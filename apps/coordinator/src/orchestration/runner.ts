import { createHash } from "node:crypto";
import type { Principal, RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import type { OrchestrationCommand, OrchestrationDispatch, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact } from "@evoloop/contracts/orchestration";
import type { WorkflowService } from "@evoloop/core";
import { OrchestrationError } from "@evoloop/core/orchestration";
import type { OrchestrationService } from "@evoloop/core/orchestration";
import type { WorkerScope } from "../workers/types.js";
import type { RuntimeRunner } from "../runtime/runner.js";

/** Stable RFC 4122 UUID for a single logical intent, including recovery after a crash. */
export function loopIntentId(...parts: string[]): string {
  const bytes = Buffer.from(createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const commandHash = (command: OrchestrationCommand) =>
  createHash("sha256").update(canonical(command)).digest("hex");

export interface ManagedRoleProfile {
  principal: Principal;
  authorizationScopeId: string;
  cwd: string;
  model?: string | undefined;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "on-request" | "untrusted";
  skillPath?: string | undefined;
}
export interface ManagedWorkerCredential { principal: Principal; wrapperPath: string }
export interface ManagedLoopDependencies {
  projects: string[];
  reader(projectId: string): Principal | null;
  orchestration: OrchestrationService;
  workflow: WorkflowService;
  runtime: Pick<RuntimeRunner, "pump">;
  /** A live controller binding for the requested role and authorization scope. */
  controller(projectId: string, roleId: string): Promise<ManagedRoleProfile | null>;
  credential: {
    issue(scope: WorkerScope): Promise<ManagedWorkerCredential>;
    lookup(runId: string): Promise<ManagedWorkerCredential | null>;
  };
  /** Seals an existing signed submission using its original actor and delivery operation. */
  sealSubmission(dispatch: OrchestrationDispatch, run: RuntimeRunRecord): Promise<{
    status: "sealed" | "decision" | "pending" | "unknown" | "rejected" | "absent";
    deliveryId?: string;
    decisionId?: string;
    outcome?: "no_action" | "waiting" | "failed";
    reason?: string;
    evidenceRef?: string;
  }>;
  now(): string;
  canWrite(): boolean;
  maxPages?: number;
}

type LoopFault = { loopId: string; dispatchId?: string; code: string };
const terminal = (state: RuntimeRunRecord["state"]) => state === "completed" || state === "failed" || state === "interrupted";
const applied = (result: Awaited<ReturnType<WorkflowService["execute"]>>) => {
  if (result.status !== "applied") throw new Error(`WORKFLOW_${result.code}: ${result.message}`);
  return result;
};

/** A bounded poller. All authority and durable transitions remain in the existing services. */
export class ManagedLoopRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private faults: LoopFault[] = [];
  constructor(private readonly deps: ManagedLoopDependencies) {}

  status() { return { running: this.timer !== null, busy: this.busy !== null, faults: [...this.faults] }; }
  start(intervalMs = 2000) {
    if (this.timer) return;
    if (!Number.isInteger(intervalMs) || intervalMs < 250) throw new Error("Invalid managed loop interval");
    this.timer = setInterval(() => { void this.pump(); }, intervalMs);
    this.timer.unref();
    void this.pump();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.busy) await this.busy;
  }
  async pump(): Promise<void> {
    if (!this.deps.canWrite()) return;
    if (this.busy) return this.busy;
    this.busy = this.cycle().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async cycle() {
    this.faults = [];
    for (const projectId of this.deps.projects) {
      if (!this.deps.canWrite()) break;
      const reader = this.deps.reader(projectId);
      if (!reader) { this.faults.push({ loopId: projectId, code: "NO_CONTROLLER" }); continue; }
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < (this.deps.maxPages ?? 20); pageNo++) {
        const page = await this.deps.orchestration.listLoops(reader, projectId, 100, cursor);
        for (const loop of page.items) {
          try { await this.advanceLoop(loop); }
          catch (error) { this.faults.push({ loopId: loop.id, code: error instanceof Error ? error.message : String(error) }); }
        }
        if (!page.nextCursor) break;
        if (page.nextCursor === cursor) throw new Error("Loop page cursor repeated");
        cursor = page.nextCursor;
      }
    }
  }
  private async advanceLoop(loop: OrchestrationLoop) {
    const cognitive = await this.deps.controller(loop.projectId, loop.cognitiveRoleId);
    if (!cognitive) { this.faults.push({ loopId: loop.id, code: "COGNITIVE_ROLE_UNAVAILABLE" }); return; }
    const sourceFacts = loop.state === "active" ? await this.acceptSources(loop, cognitive) : new Map<string, OrchestrationSourceFact>();
    // Settlement continues while paused or stopped. Neither state starts a new worker.
    const dispatches = await this.pages(cursor => this.deps.orchestration.listDispatches(cognitive.principal, loop.projectId, loop.id, 100, cursor));
    for (const dispatch of dispatches) {
      try {
        if (dispatch.state === "accepted") await this.settle(dispatch);
        else if (dispatch.state === "dispatching" && loop.state !== "active")
          await this.reconcilePausedDispatch(loop, dispatch);
        else if (loop.state === "active" && ["pending", "claimed", "dispatching"].includes(dispatch.state))
          await this.advanceDispatch(loop, dispatch);
      } catch (error) { this.faults.push({ loopId: loop.id, dispatchId: dispatch.id, code: error instanceof Error ? error.message : String(error) }); }
    }
    if (loop.state !== "active") return;
    const currentLoop = await this.deps.orchestration.getLoop(cognitive.principal, loop.projectId, loop.id);
    if (!currentLoop || currentLoop.state !== "active") return;
    const inbox = await this.pages(cursor => this.deps.orchestration.listInbox(cognitive.principal, loop.projectId, loop.id, 100, cursor));
    for (const item of inbox.filter(item => item.purpose === "cognitive_review" &&
      (item.state === "pending" || item.state === "acknowledged"))) {
      try { await this.seedCognition(loop, item, cognitive, sourceFacts.get(item.sourceEventId)); }
      catch (error) { this.faults.push({ loopId: loop.id, code: error instanceof Error ? error.message : String(error) }); }
    }
  }
  private async pages<T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let n = 0; n < (this.deps.maxPages ?? 20); n++) {
      const page = await load(cursor); items.push(...page.items);
      if (!page.nextCursor) return items;
      if (seen.has(page.nextCursor)) throw new Error("Orchestration page cursor repeated");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error("Orchestration page bound reached");
  }
  private eligible(loop: OrchestrationLoop, fact: OrchestrationSourceFact,
    dispatches: OrchestrationDispatch[]): boolean {
    if (fact.id === loop.bootstrapEventId) return fact.kind === "loop.enrolled" && fact.subjectId === loop.id;
    if (fact.kind === "observation.record") {
      // Core validates the authoritative Observation, scope and actor at inbox.accept.
      return fact.sourceLoopId === null && fact.originDispatchId === null &&
        !!fact.operationId && !!fact.sourceActorId && !!fact.observationId &&
        !!fact.deliveryId && ["used", "failed", "notUsed"].includes(fact.observationResult ?? "");
    }
    if (fact.kind === "document") {
      // Only the scoped creation revision of an issue is a cognitive input; reports return via worker outcome.
      return fact.sourceLoopId === null && fact.originDispatchId === null && fact.subjectVersion === 1 &&
        !!fact.operationId && !!fact.sourceActorId && !!fact.issueRevisionId && !!fact.issueContentHash;
    }
    if (fact.kind === "schedule.task.todo") return fact.sourceLoopId === loop.id &&
      fact.scheduleTargetLoopId === loop.id && fact.scheduleTargetStageId === loop.stageId &&
      !!fact.scheduleId && !!fact.scheduleRevisionId && !!fact.plannedAtUtc &&
      !!fact.scheduleTaskRevisionId && !!fact.operationId && !!fact.sourceActorId;
    if (fact.kind === "dispatch.gap" && fact.sourceLoopId === loop.id && fact.originDispatchId && fact.gapRunId) {
      // A missing signed intent is a software recovery source even when the failed worker was cognition itself.
      return dispatches.some(d => d.id === fact.originDispatchId && d.taskId === fact.subjectId &&
        d.runtimeRunId === fact.gapRunId && d.taskVersion === fact.gapTaskVersion &&
        d.state === "accepted" && d.outcome === null &&
        d.version >= fact.subjectVersion);
    }
    if (fact.kind !== "worker.outcome" || fact.sourceLoopId !== loop.id || !fact.originDispatchId) return false;
    return dispatches.some(d => d.id === fact.originDispatchId && d.taskId === fact.subjectId &&
      d.version === fact.subjectVersion && d.recipientRoleId !== loop.cognitiveRoleId &&
      d.state === "completed" && !!d.outcome && (d.outcome !== "delivered" || !!d.deliveryId));
  }
  private async acceptSources(loop: OrchestrationLoop, cognitive: ManagedRoleProfile) {
    const dispatches = await this.pages(cursor => this.deps.orchestration.listDispatches(cognitive.principal, loop.projectId, loop.id, 100, cursor));
    // Always begin at the first page. A durable high-water cursor would lose a late commit.
    const facts = await this.pages(cursor => this.deps.orchestration.listSourceFacts(cognitive.principal, loop.projectId, loop.id, 100, cursor));
    const byId = new Map(facts.map(fact => [fact.id, fact]));
    for (const fact of facts) {
      if (!this.eligible(loop, fact, dispatches)) continue;
      try {
        await this.deps.orchestration.execute(cognitive.principal, {
          type: "inbox.accept", projectId: loop.projectId, operationId: loopIntentId(loop.id, fact.id, "inbox.accept"),
          loopId: loop.id, sourceEventId: fact.id, recipientRoleId: loop.cognitiveRoleId, purpose: "cognitive_review",
        });
      } catch (error) {
        // A listed candidate can become stale, or fail independent-worker classification.
        if (error instanceof OrchestrationError && error.code === "SOURCE_UNAVAILABLE") continue;
        throw error;
      }
    }
    return byId;
  }
  private async seedCognition(loop: OrchestrationLoop, inbox: OrchestrationInbox, cognitive: ManagedRoleProfile, sourceFact?: OrchestrationSourceFact) {
    if (inbox.state === "pending") {
      await this.deps.orchestration.execute(cognitive.principal, { type: "inbox.ack", projectId: loop.projectId,
        operationId: loopIntentId(inbox.id, "ack"), inboxId: inbox.id, expectedVersion: inbox.version,
        reason: "Managed cognition accepted verified source" });
      inbox = { ...inbox, state: "acknowledged", version: inbox.version + 1 };
    }
    if (!loop.stageId) {
      await this.deps.orchestration.execute(cognitive.principal, { type: "inbox.dispose", projectId: loop.projectId,
        operationId: loopIntentId(inbox.id, "no-stage"), inboxId: inbox.id, expectedVersion: inbox.version,
        disposition: "waiting", reason: "Loop has no active Stage; cognition Task cannot be scoped to Goal", evidenceRef: null });
      return;
    }
    const current = await this.deps.orchestration.getLoop(cognitive.principal, loop.projectId, loop.id);
    if (!current || current.state !== "active") return;
    if (current.dispatchCount >= current.maxRuns) {
      await this.deps.orchestration.execute(cognitive.principal, { type: "inbox.dispose", projectId: loop.projectId,
        operationId: loopIntentId(inbox.id, "budget-exhausted"), inboxId: inbox.id, expectedVersion: inbox.version,
        disposition: "waiting", reason: "Managed loop run budget exhausted", evidenceRef: null });
      return;
    }
    const taskId = loopIntentId(loop.id, inbox.id, "cognition-task");
    const existing = await this.deps.workflow.getTask(cognitive.principal, loop.projectId, taskId).catch(() => null);
    if (!existing) {
      const source = inbox.sourceEventId === loop.bootstrapEventId ? "enrolled loop" : `verified source event ${inbox.sourceEventId}`;
      const fixedIssue = sourceFact?.kind === "document" && sourceFact.issueRevisionId && sourceFact.issueContentHash
        ? ` Read issue original /api/projects/${loop.projectId}/documents/${sourceFact.subjectId}/revisions/${sourceFact.issueRevisionId}/original and verify SHA-256 ${sourceFact.issueContentHash}. Treat it as a report, not verified consumer use or a completed repair.` : "";
      const scheduledTask = sourceFact?.kind === "schedule.task.todo" && sourceFact.scheduleId && sourceFact.plannedAtUtc
        ? ` Schedule ${sourceFact.scheduleId} revision ${sourceFact.scheduleRevisionId} created existing todo Task ${sourceFact.subjectId} at ${sourceFact.plannedAtUtc}. Read that exact Task and reuse it for the next_action child dispatch if still eligible. Do not create a duplicate Task for this occurrence.` : "";
      applied(await this.deps.workflow.execute(cognitive.principal, { type: "task.create", projectId: loop.projectId,
        operationId: loopIntentId(taskId, "create"), taskId, stageId: loop.stageId,
        title: `Cognition: ${source}`, owner: loop.cognitiveRoleId, kind: "research",
        content: `Review the verified ${source} for Goal ${loop.goalId}, Stage ${loop.stageId}. Read actual project state and decide a bounded next action. Inbox ${inbox.id}.${fixedIssue}${scheduledTask}`,
        acceptance: "Record a grounded decision: create and dispatch a scoped business Task, wait, take no action, or stop.",
        consumer: loop.cognitiveRoleId, useRequired: false,
        evidence: `Source event ${inbox.sourceEventId}`, stopCondition: "A decision is recorded for this source." }));
    }
    const detail = await this.deps.workflow.getTask(cognitive.principal, loop.projectId, taskId);
    await this.deps.orchestration.execute(cognitive.principal, { type: "dispatch.request", projectId: loop.projectId,
      operationId: loopIntentId(inbox.id, "cognition-dispatch-request"), inboxId: inbox.id,
      expectedInboxVersion: inbox.version, dispatchId: loopIntentId(inbox.id, "cognition-dispatch"),
      taskId, expectedTaskVersion: detail.task.version, recipientRoleId: loop.cognitiveRoleId,
      purpose: "cognition", parentDispatchId: null, authorizationScopeId: cognitive.authorizationScopeId,
      reason: `Cognition for verified source ${inbox.sourceEventId}` });
  }
  private async claimIntent(profile: ManagedRoleProfile,
    command: Extract<OrchestrationCommand, { type: "dispatch.claim" | "dispatch.reclaim" }>): Promise<OrchestrationDispatch> {
    const { principal } = profile;
    const readback = async () => {
      const [receipt, current] = await Promise.all([
        this.deps.orchestration.getOperation(principal, command.projectId, command.operationId),
        this.deps.orchestration.getDispatch(principal, command.projectId, command.dispatchId),
      ]);
      if (!receipt || !current || !current.leaseUntilUtc || receipt.actorId !== principal.actorId ||
        receipt.projectId !== command.projectId || receipt.result.entityType !== "dispatch" ||
        receipt.result.entityId !== command.dispatchId || current.claimToken !== command.claimToken ||
        current.version < receipt.result.version ||
        receipt.commandHash !== commandHash({ ...command, leaseUntilUtc: current.leaseUntilUtc }))
        throw new Error("CLAIM_RECEIPT_MISMATCH");
      return current;
    };
    if (await this.deps.orchestration.getOperation(principal, command.projectId, command.operationId))
      return readback();
    try { await this.deps.orchestration.execute(principal, command); }
    catch (error) {
      if (!await this.deps.orchestration.getOperation(principal, command.projectId, command.operationId)) throw error;
    }
    return readback();
  }
  private async initialTaskBasis(principal: Principal, projectId: string, task: TaskDetail) {
    // An existing basis carries explicit retention decisions; let WorkflowService inherit it.
    if (task.basis) return undefined;
    if (task.links.length > 19) throw new Error("LINKED_BASIS_LIMIT: Task has more than 19 linked documents");
    const basis: { documentId: string; revisionId: string }[] = [];
    for (const link of [...task.links].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
      const { document } = await this.deps.workflow.getDocument(principal, projectId, link.documentId);
      if (document.status !== "published" || !document.adoptedRevisionId)
        throw new Error(`LINKED_BASIS_UNPUBLISHED: ${link.documentId} is not a published document`);
      basis.push({ documentId: link.documentId, revisionId: document.adoptedRevisionId });
    }
    return basis;
  }
  private async advanceDispatch(loop: OrchestrationLoop, original: OrchestrationDispatch) {
    const profile = await this.deps.controller(loop.projectId, original.recipientRoleId);
    if (!profile || profile.authorizationScopeId !== original.authorizationScopeId) throw new Error("ROLE_SCOPE_UNAVAILABLE");
    let dispatch = original;
    const token = loopIntentId(dispatch.id, "claim-token");
    if (dispatch.state === "pending") {
      if (dispatch.parentDispatchId) {
        const parent = await this.deps.orchestration.getDispatch(profile.principal, loop.projectId, dispatch.parentDispatchId);
        if (!parent || parent.projectId !== loop.projectId || parent.loopId !== loop.id ||
          parent.sourceEventId !== dispatch.sourceEventId || parent.recipientRoleId !== loop.cognitiveRoleId ||
          parent.purpose !== "cognition" || !parent.runtimeRunId || !["accepted", "completed"].includes(parent.state)) return;
        const run = await this.deps.workflow.getRuntimeRun(profile.principal, loop.projectId, parent.runtimeRunId).catch(() => null);
        if (!run || run.projectId !== loop.projectId || run.taskId !== parent.taskId || !terminal(run.state)) return;
        const submission = await this.deps.orchestration.getSubmissionForDispatch(profile.principal, loop.projectId, parent.id);
        if (submission && ["submitted", "sealing", "unknown"].includes(submission.state)) return;
      }
      const leaseUntilUtc = new Date(Date.parse(this.deps.now()) + 240_000).toISOString();
      dispatch = await this.claimIntent(profile, { type: "dispatch.claim", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "claim"), dispatchId: dispatch.id, claimToken: token, leaseUntilUtc });
    }
    if (dispatch.state === "claimed") {
      if (!dispatch.leaseUntilUtc || Date.parse(dispatch.leaseUntilUtc) <= Date.parse(this.deps.now())) {
        dispatch = await this.claimIntent(profile, { type: "dispatch.reclaim", projectId: loop.projectId,
          operationId: loopIntentId(dispatch.id, "reclaim", String(dispatch.version)), dispatchId: dispatch.id,
          expectedVersion: dispatch.version, claimToken: token,
          leaseUntilUtc: new Date(Date.parse(this.deps.now()) + 240_000).toISOString() });
      }
      // A crash between these steps is harmless: the start intent and following Workflow operations are stable.
      await this.deps.orchestration.execute(profile.principal, { type: "dispatch.start", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "start"), dispatchId: dispatch.id, claimToken: token });
      dispatch = { ...dispatch, state: "dispatching" };
    }
    if (dispatch.state !== "dispatching") return;
    const task = await this.deps.workflow.getTask(profile.principal, loop.projectId, dispatch.taskId);
    const startOperationId = loopIntentId(dispatch.id, "task.start");
    const startPrior = await this.deps.workflow.getOperation(profile.principal, loop.projectId, startOperationId);
    if (!startPrior) {
      if (task.task.state !== "todo" || task.task.version !== dispatch.taskVersion) throw new Error("TASK_CHANGED_AFTER_DISPATCH_START");
      const basis = await this.initialTaskBasis(profile.principal, loop.projectId, task);
      applied(await this.deps.workflow.execute(profile.principal, { type: "task.start", projectId: loop.projectId,
        operationId: startOperationId, taskId: task.task.id, expectedVersion: dispatch.taskVersion,
        reason: `Managed dispatch ${dispatch.id}`, ...(basis === undefined ? {} : { basis }) }));
    } else applied(startPrior.result);
    const sessionId = loopIntentId(dispatch.id, "session");
    const session = await this.deps.workflow.getRuntimeSession(profile.principal, loop.projectId, sessionId).catch(() => null);
    if (!session) {
      applied(await this.deps.workflow.execute(profile.principal, { type: "runtime.session.reserve", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "session.reserve"), sessionId, roleId: dispatch.recipientRoleId,
        authorizationScope: profile.authorizationScopeId, cwd: profile.cwd, sandbox: profile.sandbox,
        approvalPolicy: profile.approvalPolicy, ...(profile.model ? { model: profile.model } : {}) }));
      await this.deps.runtime.pump();
      return;
    }
    if (session.state === "reserved" || session.state === "creating") { await this.deps.runtime.pump(); return; }
    if (session.state !== "ready") throw new Error(`SESSION_${session.state.toUpperCase()}`);
    const runId = loopIntentId(dispatch.id, "run");
    const priorRun = await this.deps.workflow.getRuntimeRun(profile.principal, loop.projectId, runId).catch(() => null);
    if (!priorRun) {
      const scope: WorkerScope = { projectId: loop.projectId, loopId: loop.id, taskId: dispatch.taskId,
        runId, sessionId, roleId: dispatch.recipientRoleId,
        kind: dispatch.recipientRoleId === loop.cognitiveRoleId ? "cognition" : "business",
        allowedRoleIds: dispatch.recipientRoleId === loop.cognitiveRoleId
          ? [loop.cognitiveRoleId, ...loop.allowedBusinessRoleIds] : [dispatch.recipientRoleId] };
      const credential = await this.deps.credential.lookup(runId) ?? await this.deps.credential.issue(scope);
      const currentTask = await this.deps.workflow.getTask(profile.principal, loop.projectId, dispatch.taskId);
      const input = await this.workerInput(loop, dispatch, runId, credential.wrapperPath, profile);
      applied(await this.deps.workflow.execute(profile.principal, { type: "runtime.run.reserve", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "run.reserve"), runId, taskId: dispatch.taskId,
        sessionId, expectedVersion: currentTask.task.version, input }));
    }
    // Read the exact original Run before resolving an uncertain reserve response.
    const run = await this.deps.workflow.getRuntimeRun(profile.principal, loop.projectId, runId);
    await this.deps.orchestration.execute(profile.principal, { type: "dispatch.resolve", projectId: loop.projectId,
      operationId: loopIntentId(dispatch.id, "resolve-accepted"), dispatchId: dispatch.id, claimToken: token,
      result: "accepted", runtimeRunId: run.id, reason: "Original durable runtime Run confirmed" });
    await this.deps.runtime.pump();
  }
  private async reconcilePausedDispatch(loop: OrchestrationLoop, dispatch: OrchestrationDispatch) {
    const profile = await this.deps.controller(loop.projectId, dispatch.recipientRoleId);
    if (!profile) throw new Error("ROLE_SCOPE_UNAVAILABLE");
    const runId = loopIntentId(dispatch.id, "run");
    const existingRun = await this.deps.workflow.getRuntimeRun(profile.principal, loop.projectId, runId).catch(() => null);
    if (existingRun) {
      await this.deps.orchestration.execute(profile.principal, { type: "dispatch.resolve", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "resolve-accepted"), dispatchId: dispatch.id,
        claimToken: dispatch.claimToken ?? loopIntentId(dispatch.id, "claim-token"), result: "accepted",
        runtimeRunId: existingRun.id, reason: "Original durable runtime Run confirmed" });
    } else if (loop.state === "stopped") {
      await this.deps.orchestration.execute(profile.principal, { type: "dispatch.resolve", projectId: loop.projectId,
        operationId: loopIntentId(dispatch.id, "stopped-before-run"), dispatchId: dispatch.id,
        claimToken: dispatch.claimToken ?? loopIntentId(dispatch.id, "claim-token"), result: "unknown",
        runtimeRunId: null, reason: "Loop stopped after dispatch intent, before a durable Run; requires reconciliation" });
    }
  }
  private async workerInput(loop: OrchestrationLoop, dispatch: OrchestrationDispatch, runId: string,
    wrapperPath: string, profile: ManagedRoleProfile): Promise<string> {
    const kind = dispatch.recipientRoleId === loop.cognitiveRoleId ? "cognition" : "business";
    const source = kind === "cognition" ? (await this.pages(cursor =>
      this.deps.orchestration.listSourceFacts(profile.principal, loop.projectId, loop.id, 100, cursor)))
      .find(fact => fact.id === dispatch.sourceEventId) : null;
    const gapContext = source?.kind === "dispatch.gap" && source.sourceLoopId === loop.id &&
      source.originDispatchId && source.gapRunId && source.gapTaskVersion
      ? ` Recovery source is dispatch.gap ${source.id} from original Dispatch ${source.originDispatchId}, terminal Run ${source.gapRunId}, Task ${source.subjectId} at version ${source.gapTaskVersion}. Read the original Dispatch at get /api/projects/${loop.projectId}/orchestration/dispatches/${source.originDispatchId} and original Run at get /api/projects/${loop.projectId}/runtime/runs/${source.gapRunId}; its taskRevisionId identifies the exact readable Task revision at get /api/projects/${loop.projectId}/tasks/${source.subjectId}/revisions/REVISION_ID and fixed basis originals at get /api/projects/${loop.projectId}/documents/DOCUMENT_ID/revisions/REVISION_ID/original. Check existing same-parent/source child dispatches before requesting more business work; a prior signed child request is an execution commitment, while the parent's final declaration may still be absent. Do not use the Task's current detail or revision list to reconstruct this gap.` : "";
    const scheduleContext = source?.kind === "schedule.task.todo" && source.scheduleTargetLoopId === loop.id
      ? ` This source is a verified Schedule occurrence for existing todo Task ${source.subjectId}, Schedule ${source.scheduleId} revision ${source.scheduleRevisionId}, planned ${source.plannedAtUtc}. Reuse that exact Task if its current version, owner, Stage, and Run state remain eligible; do not create another Task for this occurrence.` : "";
    const businessScopes = kind === "cognition" ? (await Promise.all(loop.allowedBusinessRoleIds.map(async roleId => {
      const target = await this.deps.controller(loop.projectId, roleId);
      return target ? `${roleId}=${target.authorizationScopeId}` : `${roleId}=unavailable`;
    }))).join(", ") : "";
    const message = kind === "cognition"
      ? `Read Goal ${loop.goalId}, Stage ${loop.stageId}, your fixed context and relevant feedback with the scoped CLI. Review existing Stage Tasks; reuse a suitable todo Task without an in-flight or unknown Run, preserving its observed version, owner and fixed basis. Create one only for distinct work, not to bypass an active Task. Planning need not read business-only originals or trace; never claim those reads, and wait if your own required input or delegation authority is missing. Check exact same-parent/source children to avoid duplicate dispatch. To delegate, accept the SAME source event as a next_action inbox, acknowledge it, then request the selected Stage-linked Task with parentDispatchId=${dispatch.id} and business role/scope: ${businessScopes}. Sign a worker submission or decision before this Turn ends.`
      : `Execute Task ${dispatch.taskId} from its fixed basis. Record actual artifacts and checks using scoped worker.submit before this Turn ends. Do not invent a Delivery.`;
    const skillPath = profile.skillPath ?? `${profile.cwd}/.agents/skills/evoloop-workflow/SKILL.md`;
    const input = `Managed evoLoop ${kind} Run. Project ${loop.projectId}; loop ${loop.id}; dispatch ${dispatch.id}; Run ${runId}; Task ${dispatch.taskId}; source inbox ${dispatch.inboxId}; source event ${dispatch.sourceEventId}. Scoped CLI: ${wrapperPath}\n${message}${gapContext}${scheduleContext}\nAuthorized writable workspace: ${profile.cwd}. Write command JSON files inside this directory, not /tmp or other external paths. Use the wrapper with command run FILE. Read this Run directly with get /api/projects/${loop.projectId}/runtime/runs/${runId} for its exact inputHash and taskRevisionId.\nProject skill: ${skillPath}`;
    if (input.length > 4000) throw new Error("WORKER_INPUT_TOO_LONG");
    return input;
  }
  private async settle(dispatch: OrchestrationDispatch) {
    if (!dispatch.runtimeRunId) throw new Error("ACCEPTED_DISPATCH_WITHOUT_RUN");
    const profile = await this.deps.controller(dispatch.projectId, dispatch.recipientRoleId);
    if (!profile) throw new Error("ROLE_SCOPE_UNAVAILABLE");
    const run = await this.deps.workflow.getRuntimeRun(profile.principal, dispatch.projectId, dispatch.runtimeRunId);
    if (!terminal(run.state)) return;
    const seal = await this.deps.sealSubmission(dispatch, run);
    if (seal.status === "pending" && !seal.reason) return;
    if (seal.status !== "sealed" && seal.status !== "decision") {
      const child = seal.status === "absent" && dispatch.purpose === "cognition"
        ? await this.signedChildRequest(profile, dispatch) : null;
      const reason = child
        ? `Worker intent gap: final declaration absent; signed child request ${child.id} already exists`
        : `Worker intent gap: ${seal.status}`;
      if (!dispatch.reason.startsWith("Worker intent gap:")) {
        await this.deps.orchestration.execute(profile.principal, { type: "dispatch.gap", projectId: dispatch.projectId,
          operationId: loopIntentId(dispatch.id, "worker-intent-gap"), dispatchId: dispatch.id,
          expectedVersion: dispatch.version, reason, evidenceRef: child ? `dispatch:${child.id}` : seal.evidenceRef ?? null });
      }
      return;
    }
    if (seal.status === "sealed" && !seal.deliveryId || seal.status === "decision" && (!seal.decisionId || !seal.outcome))
      throw new Error("WORKER_INTENT_INCOMPLETE");
    const outcome = seal.status === "sealed" ? "delivered" : seal.outcome!;
    await this.deps.orchestration.execute(profile.principal, { type: "worker.outcome", projectId: dispatch.projectId,
      operationId: loopIntentId(dispatch.id, "worker.outcome"), dispatchId: dispatch.id, outcome,
      deliveryId: outcome === "delivered" ? seal.deliveryId! : null,
      decisionId: seal.status === "decision" ? seal.decisionId! : null,
      evidenceRef: seal.evidenceRef ?? null,
      reason: seal.reason ?? (outcome === "delivered" ? "Signed worker submission sealed as actual Delivery" : "Signed worker decision after terminal Run") });
  }
  private async signedChildRequest(profile: ManagedRoleProfile, parent: OrchestrationDispatch) {
    const children = await this.pages(cursor => this.deps.orchestration.listDispatches(profile.principal,
      parent.projectId, parent.loopId, 100, cursor));
    for (const child of children) {
      if (child.projectId !== parent.projectId || child.loopId !== parent.loopId ||
        child.parentDispatchId !== parent.id || child.sourceEventId !== parent.sourceEventId ||
        child.recipientRoleId === parent.recipientRoleId) continue;
      const inbox = await this.deps.orchestration.getInbox(profile.principal, parent.projectId, child.inboxId);
      if (inbox?.projectId === parent.projectId && inbox.loopId === parent.loopId &&
        inbox.sourceEventId === parent.sourceEventId && inbox.purpose === "next_action" &&
        inbox.state === "disposed" && inbox.disposition === "dispatch" && inbox.dispatchId === child.id)
        return child;
    }
    return null;
  }
}
