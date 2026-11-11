import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DirectInputCommand, DirectInputRecord } from "@evoloop/contracts/direct-input";
import type { RuntimeBinding, RuntimeCapabilities } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { DirectInputService } from "../src/direct-input/service.js";
import { SessionSteerLock } from "../src/runtime/session-steer-lock.js";

const projectId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
const principal = { actorId: "sender", projectIds: [projectId], permissions: ["read", "write"] as Array<"read" | "write"> };
const binding: RuntimeBinding = { projectId, sessionId, roleId: "role", nativeThreadId: "thread",
  nativeSessionId: "thread", cwd: "/tmp/direct-input-service", authorizationScope: "test",
  owner: "evoloop-codex-app-server" };
const grant = { projectId, sessionId, senderActorId: principal.actorId, receiverRoleId: "role",
  receiverActorId: "receiver", cwd: binding.cwd, enabled: true, canStart: true, canSteer: true };
const capabilities = (midTurnInput: boolean, idleTurnStart: boolean): RuntimeCapabilities => ({
  provider: "codex", process: "shared",
  delivery: { midTurnInput, idleTurnStart, callerAssignedTurnKey: false, callerAssignedSessionId: false },
  errors: { notSent: true, rejected: true }, compaction: { autoCompacts: true, mode: "unavailable" },
  history: { workTrace: true, workspace: false }, naming: true, archive: "native", nativeInput: false,
  executionProfileActivation: true, modelList: true, usage: "unavailable", cost: false,
});
const command = (): DirectInputCommand => ({
  inputId: randomUUID(), operationId: randomUUID(), content: "continue this Turn", expectedTurnId: null,
});
const record = (value: DirectInputCommand, mode: "start" | "steer"): DirectInputRecord => ({
  projectId, sessionId, inputId: value.inputId, operationId: value.operationId, actorId: principal.actorId,
  content: value.content, mode, source: { kind: "message", id: value.inputId, processingId: randomUUID() },
  expectedTurnId: mode === "steer" ? turnId : null, actualTurnId: null, nativeItemId: null,
  state: "attempted", reason: null, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

test("capability answers from the exact Session runtime for steer and idle start", async () => {
  let turns = 0;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(false, false),
    registerBinding: async () => {}, listTurns: async () => { turns++; return { data: [], nextCursor: null }; },
  } as never;
  const store = {
    inspect: async () => ({ state: "running", turnId, used: 0 }),
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const result = await service.capability(principal, projectId, sessionId);
  assert.deepEqual({ available: result.available, mode: result.mode, reasonCode: result.reasonCode },
    { available: false, mode: null, reasonCode: "NATIVE_STEER_UNAVAILABLE" });
  assert.equal(turns, 0, "an unavailable runtime is refused before native history is read");
});

test("one Session steer lock makes a competing submit retryable and preserves its draft for retry", async () => {
  const lock = new SessionSteerLock(), first = command(), second = command();
  const accepted: string[] = [];
  let reserve = 0;
  const store = {
    get: async () => null, hasPrimary: async () => false,
    reserve: async (_project: string, _session: string, _actor: string, value: DirectInputCommand) => {
      reserve++;
      return { record: record(value, "start"), created: true };
    },
    accept: async (_project: string, id: string) => {
      accepted.push(id); return { ...record(first, "start"), inputId: id, state: "accepted" as const };
    },
  } as never;
  let releaseNative!: () => void;
  const nativeGate = new Promise<void>(resolve => { releaseNative = resolve; });
  let enteredNative!: () => void;
  const nativeStarted = new Promise<void>(resolve => { enteredNative = resolve; });
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    qualifyConversationThread: async () => ({ available: true, reason: "ready", fingerprint: "a".repeat(64) }),
    startConversationTurn: async (_binding: RuntimeBinding, _input: string, id: string) => {
      enteredNative(); await nativeGate; return { id: `turn-${id}`, status: "inProgress", completedAtUtc: null };
    },
    listTurns: async () => ({ data: [], nextCursor: null }),
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true, lock,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const owner = service.submit(principal, projectId, sessionId, first);
  await nativeStarted;
  await assert.rejects(() => service.submit(principal, projectId, sessionId, second),
    error => error instanceof DomainError && error.code === "SESSION_INPUT_BUSY");
  assert.equal(reserve, 1, "a busy lock does not reserve the competing input");
  releaseNative();
  assert.equal((await owner).state, "accepted");
  const retried = await service.submit(principal, projectId, sessionId, second);
  assert.equal(retried.state, "accepted");
  assert.deepEqual(accepted, [first.inputId, second.inputId]);
});

test("a non-steerable Turn rejects direct input and atomically queues its content", async () => {
  const value = { ...command(), expectedTurnId: turnId };
  const queued: string[] = [];
  const store = {
    get: async () => null, hasPrimary: async () => true,
    reserve: async () => ({ record: record(value, "steer"), created: true }),
    rejectSteerAndQueue: async (_project: string, id: string) => {
      queued.push(id); return { ...record(value, "steer"), state: "rejected" as const,
        reason: "Native Turn kind cannot accept input; saved as a queued ordinary message" };
    },
  } as never;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: "inProgress", completedAtUtc: null }], nextCursor: null }),
    steerTurn: async () => { throw new RuntimeServerError("turn/steer", 7, -32602,
      "NonSteerableTurnKind(compaction)"); },
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const receipt = await service.submit(principal, projectId, sessionId, value);
  assert.equal(receipt.state, "rejected");
  assert.deepEqual(queued, [value.inputId]);
});
