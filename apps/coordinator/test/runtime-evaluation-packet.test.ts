import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowService } from "@evoloop/core";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimePage, RuntimePort, RuntimeTurn } from "@evoloop/contracts/runtime";
import type { EvaluationFixedRef, Principal, RuntimeRunRecord, RuntimeSessionRecord, TaskRevision, BasisSet } from "@evoloop/contracts";
import type { BlobPayload, BlobRead, BlobStore, PreparedBlob } from "@evoloop/contracts/sources";
import { RuntimeRunner } from "../src/runtime/runner.js";
import { evaluationPacketBlobPayload, evaluationPacketMediaType } from "../src/runtime/evaluation-materials.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const projectId = randomUUID();
const actorId = "reviewer";
const taskId = randomUUID();
const taskRevisionId = randomUUID();
const basisId = randomUUID();
const primaryDocumentId = randomUUID();
const primaryRevisionId = randomUUID();
const sessionId = randomUUID();
const evaluationId = randomUUID();
const evaluationRevisionId = randomUUID();
const caseId = randomUUID();
const conditionId = randomUUID();
const attemptId = randomUUID();
const operationId = randomUUID();
const primaryBody = "# Fixed task\nDo the bounded work.";
const primaryHash = sha(primaryBody);
const olderDocumentId = randomUUID(), olderRevisionId = randomUUID();
const replacementRevisionId = randomUUID(), laterRevisionId = randomUUID();
const olderBody = "# Previously adopted source\nKeep the fixed scope.";
const primaryRef: EvaluationFixedRef = { kind: "document", id: primaryDocumentId, revision: primaryRevisionId, contentHash: primaryHash };
const protocolRef: EvaluationFixedRef = { kind: "document", id: randomUUID(), revision: randomUUID(), contentHash: "a".repeat(64) };
const commonRef: EvaluationFixedRef = { kind: "document", id: randomUUID(), revision: randomUUID(), contentHash: "b".repeat(64) };
const principal: Principal = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] };

const session: RuntimeSessionRecord = {
  projectId, id: sessionId, roleId: "evaluation-role", cwd: "/tmp/evoloop-evaluation", authorizationScope: "task:bounded",
  model: "test-model", sandbox: "read-only", approvalPolicy: "on-request", state: "ready", version: 1,
  nativeThreadId: "owned-thread", nativeSessionId: "owned-session", operationId: randomUUID(), actorId,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const revision: TaskRevision = {
  projectId, taskId, id: taskRevisionId, version: 1, title: "Fixed task", content: primaryBody,
  contentDocumentId: primaryDocumentId, contentRevisionId: primaryRevisionId, kind: "implementation",
  acceptance: "Report actual checks", owner: "reviewer", state: "in_progress", basisSetId: basisId,
  actorId, reason: "fixture", createdAt: new Date().toISOString(),
};
const basis: BasisSet = { projectId, taskId, taskRevisionId, id: basisId, sealed: true,
  members: [{ documentId: primaryDocumentId, revisionId: primaryRevisionId, contentHash: primaryHash }] };
const documentRevision = { projectId, documentId: primaryDocumentId, id: primaryRevisionId, previousRevisionId: null,
  format: "markdown" as const, mediaType: "text/markdown" as const, originalName: "task.md", body: primaryBody,
  payloadRef: null, contentHash: primaryHash, entrypoint: null, assetsManifest: [], author: actorId,
  reason: "fixture", createdAt: new Date().toISOString() };
const frozenSignature = { title: revision.title, contentDocumentId: primaryDocumentId, contentRevisionId: primaryRevisionId,
  acceptance: revision.acceptance, owner: revision.owner, kind: "implementation",
  basis: [{ documentId: primaryDocumentId, revisionId: primaryRevisionId, contentHash: primaryHash }], retentions: [], external: [] };
const definition = {
  ownerTaskId: taskId, question: "Compare the fixed inputs", protocol: protocolRef,
  case: { id: caseId, taskId, sourceTaskRevisionId: taskRevisionId, sourceSignature: frozenSignature,
    commonInput: "Compare this Task without changing its meaning", materials: [commonRef], criteria: "Use frozen criteria" },
  conditions: [{ id: conditionId, kind: "direct" as const, wikiRefs: null, model: "test-model",
    environment: { cwd: session.cwd, authorizationScope: session.authorizationScope, sandbox: session.sandbox,
      approvalPolicy: session.approvalPolicy } },
  { id: randomUUID(), kind: "direct" as const, wikiRefs: null, model: "other-model",
    environment: { cwd: session.cwd, authorizationScope: session.authorizationScope, sandbox: session.sandbox,
      approvalPolicy: session.approvalPolicy } }], limits: "Fixture only",
};

class FakeRuntime {
  ready = false;
  starts = 0;
  captured: string[] = [];
  disconnectListeners = new Set<(reason: string) => void>();
  approvalListeners = new Set<(request: RuntimeApprovalRequest) => void | Promise<void>>();
  throwOnStart = false;
  async open() { this.ready = true; }
  async close() { this.ready = false; }
  isReady() { return this.ready; }
  onDisconnect(listener: (reason: string) => void) { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  onApprovalRequest(listener: (request: RuntimeApprovalRequest) => void | Promise<void>) { this.approvalListeners.add(listener); return () => this.approvalListeners.delete(listener); }
  async registerBinding(_binding: RuntimeBinding) {}
  async resume(binding: RuntimeBinding) { return binding; }
  async inspect(_binding: RuntimeBinding): Promise<unknown> { return {}; }
  async listTurns(): Promise<RuntimePage<RuntimeTurn>> {
    return { data: this.starts && !this.throwOnStart ? [{ id: "native-turn", status: "running" }] : [], nextCursor: null };
  }
  async listItems(): Promise<RuntimePage<unknown>> { return { data: [], nextCursor: null }; }
  async startTurn(_binding: RuntimeBinding, input: string) {
    this.starts++; this.captured.push(input);
    if (this.throwOnStart) throw new Error("acknowledgement unknown");
    return { id: "native-turn", status: "running" };
  }
  async interruptTurn() {}
}

function createFixture(options: { evaluation?: boolean; failMaterial?: "missing" | "wrong-hash";
  unknownStart?: boolean; retainedSource?: "current-observation" | "stale-observation" } = {}) {
  const fixedBasis: BasisSet = options.retainedSource ? { ...basis,
    members: [...basis.members, { documentId: olderDocumentId, revisionId: olderRevisionId }],
    retentions: [{ documentId: olderDocumentId, revisionId: olderRevisionId,
      observedAdoptedRevisionId: replacementRevisionId, actorId, reason: "Fixed r1 remains the accepted scope",
      createdAt: new Date().toISOString() }] } : basis;
  const adoptedSourceRevision = options.retainedSource === "stale-observation" ? laterRevisionId : replacementRevisionId;
  const olderRevision = { ...documentRevision, documentId: olderDocumentId, id: olderRevisionId,
    body: olderBody, contentHash: sha(olderBody) };
  const sourceContents = new Map<string, { content: string; contentHash: string }>([
    [`${primaryRef.id}@${primaryRef.revision}`, { content: primaryBody, contentHash: primaryRef.contentHash }],
    [`${protocolRef.id}@${protocolRef.revision}`, { content: "Protocol exact bytes", contentHash: protocolRef.contentHash }],
    [`${commonRef.id}@${commonRef.revision}`, { content: "Shared material exact bytes", contentHash: commonRef.contentHash }],
  ]);
  let currentRun: RuntimeRunRecord = {
    projectId, id: randomUUID(), taskId, taskRevisionId, basisSetId: basisId, sessionId, operationId,
    input: definition.case.commonInput, inputHash: sha(definition.case.commonInput), state: "requested", version: 1,
    nativeTurnId: null, interruptRequested: false, resultSummary: null, actorId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(options.evaluation ? { evaluationBinding: { evaluationId, revisionId: evaluationRevisionId, caseId, conditionId,
      sourceTaskRevisionId: taskRevisionId, actualTaskRevisionId: taskRevisionId, attemptId }, evaluationPacket: null } : {}),
  };
  const blobs = new Map<string, { payload: BlobPayload; bytes: Uint8Array }>();
  const preparedBytes = new Map<string, Uint8Array>();
  let preparedCount = 0;
  const blobStore: BlobStore = {
    async prepare(payload, bytes) { preparedCount++; preparedBytes.set(payload.id, new Uint8Array(bytes)); return { payload, preparationId: "prepared" }; },
    async verify(_prepared) { return true; },
    async publish(prepared) {
      const bytes = preparedBytes.get(prepared.payload.id);
      if (!bytes) throw new Error("prepared Blob bytes missing");
      blobs.set(prepared.payload.id, { payload: prepared.payload, bytes: new Uint8Array(bytes) });
      return prepared.payload; },
    async read(payload): Promise<BlobRead> {
      const value = blobs.get(payload.id);
      return value ? { status: "available", payload: value.payload, bytes: new Uint8Array(value.bytes) } : { status: "unavailable", payload, reason: "missing" };
    },
    async inspectOrphans() { return { unregisteredIds: [], temporaryIds: [], unreferencedHashes: [] }; },
  };
  const runtime = new FakeRuntime(); runtime.throwOnStart = !!options.unknownStart;
  const basisReader = {
    getProject: async () => ({ id: projectId }),
    getTask: async (id: string) => id === taskId ? { id: taskId, projectId } : null,
    getTaskRevision: async (id: string, revisionId: string) => id === taskId && revisionId === taskRevisionId ? revision : null,
    getBasisSet: async (id: string, revisionId: string, selectedBasisId: string) =>
      id === taskId && revisionId === taskRevisionId && selectedBasisId === basisId ? fixedBasis : null,
    getDocument: async (id: string) => id === primaryDocumentId ? { id, projectId, adoptedRevisionId: primaryRevisionId } :
      id === olderDocumentId && options.retainedSource ? { id, projectId, adoptedRevisionId: adoptedSourceRevision } : null,
    getDocumentRevision: async (id: string, revisionId: string) =>
      id === primaryDocumentId && revisionId === primaryRevisionId ? documentRevision :
      id === olderDocumentId && revisionId === olderRevisionId && options.retainedSource ? olderRevision : null,
    hasDocumentAdoption: async (id: string, revisionId: string) =>
      id === olderDocumentId && revisionId === olderRevisionId && !!options.retainedSource,
    listImpacts: async () => [], listBasisDecisions: async () => [],
  } as unknown as Reader;
  const uow = { read: async <T>(_projectId: string, action: (reader: Reader) => Promise<T>) => action(basisReader) } as UnitOfWork;
  const workflow = Object.assign(new WorkflowService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash: sha } }), {
    getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [currentRun], getRuntimeSession: async () => session,
    getRuntimeRun: async () => currentRun,
    getTaskRevision: async () => ({ revision, basis: fixedBasis }),
    getTask: async () => ({ task: { id: taskId }, impacts: [], decisions: [] }),
    getDocumentPayloadRevision: async (_principal: Principal, _projectId: string, id: string) =>
      id === olderDocumentId && options.retainedSource ? olderRevision : documentRevision,
    getEvaluation: async () => ({ projectId, evaluationId, id: evaluationRevisionId, version: 1, definition,
      actorId, reason: "fixture", createdAt: new Date().toISOString() }),
  });
  let attached = 0, rejected: string[] = [], unknowns = 0, dispatches = 0;
  const trusted = {
    recoverDispatching: async () => ({ sessions: [], runs: [] }),
    attachEvaluationPacket: async (_projectId: string, _runId: string, expectedVersion: number, packet: RuntimeRunRecord["evaluationPacket"]) => {
      assert.equal(currentRun.state, "requested"); assert.equal(currentRun.version, expectedVersion); assert.equal(currentRun.evaluationPacket, null);
      attached++; currentRun = { ...currentRun, evaluationPacket: packet, version: currentRun.version + 1 }; return currentRun;
    },
    beginDispatch: async () => { dispatches++; currentRun = { ...currentRun, state: "dispatching", version: currentRun.version + 1 }; return currentRun; },
    bindTurn: async (_projectId: string, _runId: string, turn: RuntimeTurn) => {
      currentRun = { ...currentRun, state: "running", nativeTurnId: turn.id, version: currentRun.version + 1 }; return currentRun;
    },
    markRunUnknown: async () => { unknowns++; currentRun = { ...currentRun, state: "unknown", version: currentRun.version + 1 }; return currentRun; },
    rejectDispatch: async (_projectId: string, _runId: string, reason: string) => { rejected.push(reason); currentRun = { ...currentRun, state: "failed", version: currentRun.version + 1 }; return currentRun; },
  } as unknown as RuntimeWorkflowService;
  let materialReads = 0;
  const readEvaluationMaterial = async (_principal: Principal, _projectId: string, source: EvaluationFixedRef) => {
    materialReads++;
    if (options.failMaterial === "missing") throw new Error("fixed source unavailable");
    const value = sourceContents.get(`${source.id}@${source.revision}`);
    if (!value) throw new Error("source not in fixture");
    return options.failMaterial === "wrong-hash" ? { ...value, contentHash: "f".repeat(64) } : value;
  };
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [principal], canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    cliEntryForRun: async () => ({command:"/usr/local/bin/python3 /private/fixed-cli.py",actorId:"recipient"}),
    readDocumentOriginal: async () => { throw new Error("inline fixture needs no Blob"); },
    readEvaluationMaterial, blobsForPrincipal: async () => blobStore });
  return { runner, runtime, get run() { return currentRun; }, blobs, get preparedCount() { return preparedCount; },
    get attached() { return attached; }, get rejected() { return rejected; }, get unknowns() { return unknowns; },
    get dispatches() { return dispatches; }, get materialReads() { return materialReads; } };
}

test("evaluation Run sends the exact verified external packet and packet readback returns those bytes", async () => {
  const fixture = createFixture({ evaluation: true });
  try {
    await fixture.runner.start();
    assert.equal(fixture.runtime.starts, 1, JSON.stringify({ status: fixture.runner.status(), rejected: fixture.rejected, run: fixture.run }));
    assert.equal(fixture.attached, 1);
    assert.equal(fixture.run.inputHash, sha(definition.case.commonInput));
    const packet = fixture.run.evaluationPacket!;
    const payload = evaluationPacketBlobPayload(packet.payloadRef, projectId, packet.contentHash);
    const blob = fixture.blobs.get(payload.id)!;
    const stored = new TextDecoder().decode(blob.bytes);
    assert.equal(sha(stored), packet.contentHash);
    assert.equal(fixture.runtime.captured[0], stored);
    const readback = await fixture.runner.readEvaluationPacket(principal, projectId, fixture.run.id);
    assert.equal(readback.content, stored);
    assert.equal(readback.contentHash, packet.contentHash);
    assert.deepEqual(readback.sources, packet.sources);
    assert.equal(fixture.preparedCount, 1);
    assert.match(stored, /Fixed task/);
    assert.match(stored, /Protocol exact bytes/);
    assert.match(stored, /Shared material exact bytes/);
  } finally { await fixture.runner.stop(); }
});

for (const failure of ["missing", "wrong-hash"] as const) {
  test(`evaluation source ${failure} fails closed before native start`, async () => {
    const fixture = createFixture({ evaluation: true, failMaterial: failure });
    try {
      await fixture.runner.start();
      assert.equal(fixture.runtime.starts, 0);
      assert.equal(fixture.dispatches, 0);
      assert.equal(fixture.attached, 0);
      assert.equal(fixture.rejected.length, 1);
      assert.equal(fixture.run.state, "failed");
    } finally { await fixture.runner.stop(); }
  });
}

test("unknown evaluation start does not rebuild or re-dispatch its attached packet", async () => {
  const fixture = createFixture({ evaluation: true, unknownStart: true });
  try {
    await fixture.runner.start();
    assert.equal(fixture.runtime.starts, 1);
    assert.equal(fixture.run.state, "unknown");
    const readsAfterStart = fixture.materialReads;
    const blobsAfterStart = fixture.preparedCount;
    await fixture.runner.pump();
    assert.equal(fixture.runtime.starts, 1);
    assert.equal(fixture.materialReads, readsAfterStart);
    assert.equal(fixture.preparedCount, blobsAfterStart);
    assert.equal(fixture.attached, 1);
    assert.equal(fixture.unknowns, 1);
  } finally { await fixture.runner.stop(); }
});

test("ordinary Run sends a bounded fixed-reference handoff and does not create an evaluation packet", async () => {
  const fixture = createFixture();
  try {
    await fixture.runner.start();
    const input = fixture.runtime.captured[0]!;
    assert.match(input, /evoloop-lightweight-v1/);
    assert.match(input, new RegExp(taskRevisionId));
    assert.match(input, new RegExp(primaryRevisionId));
    assert.match(input, new RegExp(primaryHash));
    assert.ok(Buffer.byteLength(input, "utf8") < 16_000);
    assert.doesNotMatch(input, /Process document/);
    assert.equal(fixture.run.evaluationPacket, undefined);
    assert.equal(fixture.attached, 0);
    assert.equal(fixture.preparedCount, 0);
  } finally { await fixture.runner.stop(); }
});

test("an adopted older source with a sealed no-impact retention reaches native start", async () => {
  const fixture = createFixture({ retainedSource: "current-observation" });
  try {
    await fixture.runner.start();
    assert.equal(fixture.runtime.starts, 1);
    assert.equal(fixture.dispatches, 1);
    assert.equal(fixture.run.state, "running");
    assert.doesNotMatch(fixture.runtime.captured[0]!, /Previously adopted source/);
    assert.match(fixture.runtime.captured[0]!, new RegExp(olderRevisionId));
  } finally { await fixture.runner.stop(); }
});

test("a newer adoption invalidates the sealed observation before native start", async () => {
  const fixture = createFixture({ retainedSource: "stale-observation" });
  try {
    await fixture.runner.start();
    assert.equal(fixture.runtime.starts, 0);
    assert.equal(fixture.dispatches, 0);
    assert.equal(fixture.rejected.length, 1);
    assert.equal(fixture.run.state, "failed");
    assert.match(fixture.rejected[0]!, /^evoloop-preflight-v1:/);
    assert.equal(JSON.parse(fixture.rejected[0]!.slice("evoloop-preflight-v1:".length)).modelStarted, false);
    assert.deepEqual(fixture.runner.status(projectId).faults.map(fault =>
      ({ projectId: fault.projectId, runId: fault.runId, phase: fault.phase, category: fault.category })),
      [{ projectId, runId: fixture.run.id, phase: "run_preflight", category: "verification" }]);
    assert.doesNotMatch(JSON.stringify(fixture.runner.status(projectId)), /Retained source observation is no longer current/);
  } finally { await fixture.runner.stop(); }
});
