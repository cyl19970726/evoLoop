import { createHash } from "node:crypto";
import type { CommandResult, Principal, RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import type { OrchestrationCommand, OrchestrationDispatch, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact } from "@evoloop/contracts/orchestration";
import type { StudyReferenceProvenance, TaskExternalReferenceCommand } from "@evoloop/contracts/references";
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
  applyStudyReference?(principal: Principal, command: TaskExternalReferenceCommand,
    provenance: StudyReferenceProvenance): Promise<CommandResult>;
  runtime: Pick<RuntimeRunner, "pump">;
  /** A live controller binding for the requested role and authorization scope. */
  controller(projectId: string, roleId: string): Promise<ManagedRoleProfile | null>;
  /** Resolve a dynamic Dispatch against its current immutable policy and external template. */
  dynamicController?(dispatch: OrchestrationDispatch, historical?: boolean): Promise<ManagedRoleProfile | null>;
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
        else if (dispatch.state === "completed" && loop.state === "active" &&
          dispatch.recipientRoleId === loop.cognitiveRoleId) await this.continueDivision(loop, dispatch, cognitive);
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
    if (fact.kind === "waiting.resumed") {
      // The repository projects this fact only after verifying the applied resume operation,
      // formal waiting Decision and its original Issue chain. Match the local predecessor too.
      const resumed = fact as OrchestrationSourceFact & { waitingDecisionId?: string | null;
        waitingRunId?: string | null; previousSourceEventId?: string | null;
        originalSourceEventId?: string | null };
      if (resumed.continuation) return fact.sourceLoopId===loop.id &&
        resumed.continuation.kind==="same-task-study" &&
        resumed.continuation.rootSourceEventId===loop.bootstrapEventId &&
        resumed.continuation.originalTaskId===fact.subjectId &&
        resumed.continuation.expectedTaskVersion===fact.subjectVersion &&
        !!resumed.waitingDecisionId && !!resumed.waitingRunId && !!resumed.previousSourceEventId &&
        dispatches.some(d=>d.id===resumed.continuation!.originalDispatchId &&
          d.inboxId===resumed.continuation!.originalInboxId &&
          d.taskId===fact.subjectId && d.runtimeRunId===resumed.waitingRunId &&
          d.state==="completed" && d.outcome==="waiting");
      return fact.sourceLoopId === loop.id && fact.subjectVersion === 1 && !!fact.originDispatchId &&
        !!fact.operationId && !!fact.sourceActorId && !!fact.issueRevisionId && !!fact.issueContentHash &&
        !!resumed.waitingDecisionId && !!resumed.waitingRunId && !!resumed.previousSourceEventId &&
        !!resumed.originalSourceEventId && dispatches.some(d => d.id === fact.originDispatchId &&
          d.sourceEventId === resumed.previousSourceEventId && d.runtimeRunId === resumed.waitingRunId &&
          d.state === "completed" && d.outcome === "waiting");
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
    const continuation=sourceFact?.kind==="waiting.resumed" ? sourceFact.continuation : null;
    const taskId = continuation?.originalTaskId ?? loopIntentId(loop.id, inbox.id, "cognition-task");
    const existing = await this.deps.workflow.getTask(cognitive.principal, loop.projectId, taskId).catch(() => null);
    if (continuation && (!existing || existing.task.state!=="in_progress" ||
      existing.task.version!==continuation.expectedTaskVersion)) throw new Error("STUDY_CONTINUATION_TASK_CHANGED");
    if (!existing) {
      const source = inbox.sourceEventId === loop.bootstrapEventId ? "enrolled loop" : `verified source event ${inbox.sourceEventId}`;
      const fixedIssue = (sourceFact?.kind === "document" || sourceFact?.kind === "waiting.resumed") &&
        sourceFact.issueRevisionId && sourceFact.issueContentHash
        ? ` Read issue original /api/projects/${loop.projectId}/documents/${sourceFact.subjectId}/revisions/${sourceFact.issueRevisionId}/original and verify SHA-256 ${sourceFact.issueContentHash}. Treat it as a report, not verified consumer use or a completed repair.` : "";
      const resume = sourceFact?.kind === "waiting.resumed" ? sourceFact as OrchestrationSourceFact &
        { waitingDecisionId?: string | null; originalSourceEventId?: string | null;
          previousSourceEventId?: string | null } : null;
      const resumedFrom = resume ? ` This is a new review after waiting Decision ${resume.waitingDecisionId};
        original Issue source ${resume.originalSourceEventId}, previous review source ${resume.previousSourceEventId}.
        Preserve the old Decision and rejected operations; do not replay their Run.` : "";
      const scheduledTask = sourceFact?.kind === "schedule.task.todo" && sourceFact.scheduleId && sourceFact.plannedAtUtc
        ? ` Schedule ${sourceFact.scheduleId} revision ${sourceFact.scheduleRevisionId} created existing todo Task ${sourceFact.subjectId} at ${sourceFact.plannedAtUtc}. Read that exact Task and reuse it for the next_action child dispatch if still eligible. Do not create a duplicate Task for this occurrence.` : "";
      applied(await this.deps.workflow.execute(cognitive.principal, { type: "task.create", projectId: loop.projectId,
        operationId: loopIntentId(taskId, "create"), taskId, stageId: loop.stageId,
        title: `Cognition: ${source}`, owner: loop.cognitiveRoleId, kind: "research",
        content: `Review the verified ${source} for Goal ${loop.goalId}, Stage ${loop.stageId}. Read actual project state and decide a bounded next action. Inbox ${inbox.id}.${fixedIssue}${resumedFrom}${scheduledTask}`,
        acceptance: "Record a grounded decision: create and dispatch a scoped business Task, wait, take no action, or stop.",
        consumer: loop.cognitiveRoleId, useRequired: false,
        evidence: `Source event ${inbox.sourceEventId}`, stopCondition: "A decision is recorded for this source." }));
    }
    if (current.currentStudyDeclarationId && !continuation) {
      if (!this.deps.applyStudyReference) throw new Error("STUDY_REFERENCE_UNAVAILABLE");
      const declaration = await this.deps.orchestration.getStudyDeclaration(cognitive.principal,
        loop.projectId,current.currentStudyDeclarationId);
      if (!declaration || declaration.loopId !== loop.id || declaration.stageId !== loop.stageId ||
        declaration.controllerActorId !== cognitive.principal.actorId) throw new Error("STUDY_DECLARATION_CHANGED");
      const createOp = await this.deps.workflow.getOperation(cognitive.principal,loop.projectId,
        loopIntentId(taskId,"create"));
      if (!createOp || createOp.commandType !== "task.create" || createOp.result.status !== "applied" ||
        createOp.result.entityId !== taskId || createOp.result.version !== 1 || !createOp.result.revisionId)
        throw new Error("STUDY_RECEIVER_ORIGIN_UNVERIFIED");
      let revisionId=createOp.result.revisionId, version=1;
      for (const item of declaration.items) {
        const prefix=[declaration.id,inbox.id,item.sourceDecisionId];
        const provenance={declarationId:declaration.id,loopId:loop.id,inboxId:inbox.id,
          sourceDecisionId:item.sourceDecisionId};
        const command:TaskExternalReferenceCommand={projectId:loop.projectId,
          operationId:loopIntentId(...prefix,"reference"),actorId:cognitive.principal.actorId,
          decisionId:loopIntentId(...prefix,"decision"),taskId,taskRevisionId:revisionId,
          expectedTaskVersion:version,slotId:loopIntentId(...prefix,"slot"),expectedHeadVersion:0,
          decision:"adopt",kind:"run",referenceId:item.runId,revision:item.targetTaskRevisionId,
          contentHash:item.inputHash,reason:`Declared trace study ${declaration.id}`,
          actionImpact:"Review the fixed Run trace to compare actual work and choose a bounded next action."};
        const result=await this.deps.applyStudyReference(cognitive.principal,command,provenance);
        if (result.status!=="applied" || result.entityId!==taskId ||
          result.decisionId!==command.decisionId || result.version!==version+1 || !result.revisionId)
          throw new Error(`STUDY_COPY_${result.status === "rejected" ? result.code : "MISMATCH"}`);
        revisionId=result.revisionId;version=result.version;
      }
      const copied=await this.deps.workflow.getTask(cognitive.principal,loop.projectId,taskId);
      if (copied.task.version!==version || copied.task.currentRevisionId!==revisionId)
        throw new Error("STUDY_RECEIVER_CHANGED");
    }
    const detail = await this.deps.workflow.getTask(cognitive.principal, loop.projectId, taskId);
    if (continuation && (detail.task.state!=="in_progress" ||
      detail.task.version!==continuation.expectedTaskVersion)) throw new Error("STUDY_CONTINUATION_TASK_CHANGED");
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
  private async initialTaskBasis(principal: Principal, projectId: string, task: TaskDetail,
    sourceIssue?: { documentId: string; revisionId: string; contentHash: string }) {
    if (sourceIssue && !task.links.some(link => link.documentId === sourceIssue.documentId))
      throw new Error("SOURCE_ISSUE_NOT_LINKED: fixed source issue is absent from the Task");
    // An existing basis carries explicit retention decisions; let WorkflowService inherit it.
    if (task.basis) {
      if (sourceIssue && !task.basis.members.some(member => member.documentId === sourceIssue.documentId &&
        member.revisionId === sourceIssue.revisionId))
        throw new Error("SOURCE_ISSUE_BASIS_CHANGED: existing basis does not retain the fixed source issue");
      return undefined;
    }
    if (task.links.length > 19) throw new Error("LINKED_BASIS_LIMIT: Task has more than 19 linked documents");
    const basis: { documentId: string; revisionId: string }[] = [];
    for (const link of [...task.links].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
      const { document, adopted } = await this.deps.workflow.getDocument(principal, projectId, link.documentId);
      if (document.status !== "published" || !document.adoptedRevisionId)
        throw new Error(`LINKED_BASIS_UNPUBLISHED: ${link.documentId} is not a published document`);
      if (sourceIssue && link.documentId === sourceIssue.documentId &&
        (document.adoptedRevisionId !== sourceIssue.revisionId ||
          document.currentRevisionId !== sourceIssue.revisionId ||
          adopted?.contentHash !== sourceIssue.contentHash))
        throw new Error("SOURCE_ISSUE_CHANGED: fixed source issue revision is no longer the published head");
      basis.push({ documentId: link.documentId, revisionId: document.adoptedRevisionId });
    }
    return basis;
  }
  private async advanceDispatch(loop: OrchestrationLoop, original: OrchestrationDispatch) {
    const profile = original.bindingId ? await this.deps.dynamicController?.(original) :
      await this.deps.controller(loop.projectId, original.recipientRoleId);
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
    const continuation = dispatch.recipientRoleId===loop.cognitiveRoleId && dispatch.purpose==="cognition" &&
      (await this.pages(cursor=>this.deps.orchestration.listSourceFacts(profile.principal,
        loop.projectId,loop.id,100,cursor))).find(fact=>fact.id===dispatch.sourceEventId)?.continuation;
    const startOperationId = loopIntentId(dispatch.id, "task.start");
    const startPrior = await this.deps.workflow.getOperation(profile.principal, loop.projectId, startOperationId);
    const runId = loopIntentId(dispatch.id, "run");
    const priorRun = await this.deps.workflow.getRuntimeRun(profile.principal, loop.projectId, runId).catch(() => null);
    if (continuation) {
      if (startPrior || task.task.state!=="in_progress" || (priorRun
        ? priorRun.taskId!==dispatch.taskId || priorRun.operationId!==loopIntentId(dispatch.id,"run.reserve") ||
          priorRun.taskRevisionId!==task.task.currentRevisionId || task.task.version!==dispatch.taskVersion+1
        : task.task.version!==dispatch.taskVersion))
        throw new Error("STUDY_CONTINUATION_TASK_CHANGED");
    } else if (!startPrior) {
      if (task.task.state !== "todo" || task.task.version !== dispatch.taskVersion) throw new Error("TASK_CHANGED_AFTER_DISPATCH_START");
      const source = dispatch.parentDispatchId
        ? (await this.pages(cursor => this.deps.orchestration.listSourceFacts(profile.principal,
          loop.projectId, loop.id, 100, cursor))).find(fact => fact.id === dispatch.sourceEventId)
        : undefined;
      if (dispatch.parentDispatchId && !source) throw new Error("SOURCE_EVENT_UNAVAILABLE: child source fact is missing");
      if ((source?.kind === "document" || source?.kind === "waiting.resumed") &&
        (source.projectId !== loop.projectId || source.subjectVersion !== 1 ||
        !source.issueRevisionId || !source.issueContentHash))
        throw new Error("SOURCE_ISSUE_UNVERIFIED: child source is not a fixed issue creation");
      const sourceIssue = (source?.kind === "document" || source?.kind === "waiting.resumed") &&
        source.issueRevisionId && source.issueContentHash
        ? { documentId: source.subjectId, revisionId: source.issueRevisionId, contentHash: source.issueContentHash }
        : undefined;
      const basis = await this.initialTaskBasis(profile.principal, loop.projectId, task, sourceIssue);
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
    if (!priorRun) {
      const scope: WorkerScope = { projectId: loop.projectId, loopId: loop.id, taskId: dispatch.taskId,
        runId, sessionId, roleId: dispatch.recipientRoleId,
        kind: dispatch.recipientRoleId === loop.cognitiveRoleId ? "cognition" : "business",
        allowedRoleIds: dispatch.recipientRoleId === loop.cognitiveRoleId
          ? [loop.cognitiveRoleId, ...loop.allowedBusinessRoleIds] : [dispatch.recipientRoleId] };
      const credential = await this.deps.credential.lookup(runId) ?? await this.deps.credential.issue(scope);
      const currentTask = await this.deps.workflow.getTask(profile.principal, loop.projectId, dispatch.taskId);
      if (continuation &&
        (currentTask.task.state!=="in_progress" || currentTask.task.version!==dispatch.taskVersion))
        throw new Error("STUDY_CONTINUATION_TASK_CHANGED");
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
    const profile = dispatch.bindingId ? await this.deps.dynamicController?.(dispatch, true) :
      await this.deps.controller(loop.projectId, dispatch.recipientRoleId);
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
    const resumed = source?.kind === "waiting.resumed" ? source as OrchestrationSourceFact &
      { waitingDecisionId?: string | null; originalSourceEventId?: string | null;
        previousSourceEventId?: string | null } : null;
    const resumeContext = resumed?.issueRevisionId && resumed.issueContentHash
      ? ` New waiting-resume review from Decision ${resumed.waitingDecisionId}; original source ${resumed.originalSourceEventId}, previous source ${resumed.previousSourceEventId}. Read fixed Issue ${resumed.subjectId} revision ${resumed.issueRevisionId} at get /api/projects/${loop.projectId}/documents/${resumed.subjectId}/revisions/${resumed.issueRevisionId}/original and verify SHA-256 ${resumed.issueContentHash}. The old Run, Decision and rejected operations remain historical; use only this new Run's identity.` : "";
    const studyResumeContext = resumed?.continuation
      ? ` Continue the same in-progress study Task ${resumed.continuation.originalTaskId} at fixed version ${resumed.continuation.expectedTaskVersion} from waiting Decision ${resumed.waitingDecisionId}, original Run ${resumed.continuation.originalRunId}, original Dispatch ${resumed.continuation.originalDispatchId}, and root source ${resumed.continuation.rootSourceEventId}. Repair evidence is in waiting.resumed event ${resumed.id}; summary: ${String(resumed.resumedReason ?? "").slice(0,160)}${(resumed.resumedReason?.length ?? 0)>160?"… (partial; read the signed event)":""}. Read this Run's fixed Task context and all declared references using your new scoped identity. The old Run is causal history, not a separate read grant; never reuse its worker credential.` : "";
    const scheduleContext = source?.kind === "schedule.task.todo" && source.scheduleTargetLoopId === loop.id
      ? ` This source is a verified Schedule occurrence for existing todo Task ${source.subjectId}, Schedule ${source.scheduleId} revision ${source.scheduleRevisionId}, planned ${source.plannedAtUtc}. Reuse that exact Task if its current version, owner, Stage, and Run state remain eligible; do not create another Task for this occurrence.` : "";
    const businessScopes = kind === "cognition" ? (await Promise.all(loop.allowedBusinessRoleIds.map(async roleId => {
      const target = await this.deps.controller(loop.projectId, roleId);
      return target ? `${roleId}=${target.authorizationScopeId}` : `${roleId}=unavailable`;
    }))).join(", ") : "";
    const handoff = dispatch.bindingId ? await this.deps.orchestration.getBinding(profile.principal,loop.projectId,dispatch.bindingId) : null;
    if (dispatch.bindingId && !handoff) throw new Error("DIVISION_BINDING_MISSING");
    const handoffContext = handoff ? ` Read fixed handoff binding ${handoff.id} at get /api/projects/${loop.projectId}/orchestration/bindings/${handoff.id}, then its original Document ${handoff.documentId} revision ${handoff.documentRevisionId} at get /api/projects/${loop.projectId}/documents/${handoff.documentId}/revisions/${handoff.documentRevisionId}/original; verify SHA-256 ${handoff.documentContentHash}. After this Run exists and you have read it, sign division.ackHandoff using dispatchId=${dispatch.id}, runId=${runId}, documentRevisionId=${handoff.documentRevisionId}, documentContentHash=${handoff.documentContentHash}, and the Run's taskRevisionId. You must sign this receipt yourself before worker.submit or worker.decision.` : "";
    const message = kind === "cognition"
      ? `Read Goal ${loop.goalId}, Stage ${loop.stageId}, your fixed context and relevant feedback with the scoped CLI. Review existing Stage Tasks; reuse a suitable todo Task without an in-flight or unknown Run, preserving its observed version, owner and fixed basis. Create one only for distinct work, not to bypass an active Task. Planning need not read business-only originals or trace; never claim those reads, and wait if your own required input or delegation authority is missing. Check exact same-parent/source children to avoid duplicate dispatch. For binding division choices read get /api/projects/${loop.projectId}/orchestration/loops/${loop.id}/delegation-choices; decide before your final worker decision. Method records an approach only: update content and consumer before fixing the first Task version; for a suitable todo Task request that exact Task and original Role through the ordinary same-source child path before signing waiting with divisionDecisionId=null. An in-progress cognition first Task can produce its own report through worker.submit; method alone is not a waiting handoff. Binding choices require their exact binding ID in waiting and cannot use an ordinary child. To delegate through the static path, accept the SAME source event as a next_action inbox, acknowledge it, then request the selected Stage-linked Task with parentDispatchId=${dispatch.id} and business role/scope: ${businessScopes}. Sign a worker submission or decision before this Turn ends.`
      : `Execute Task ${dispatch.taskId} from its fixed basis.${handoffContext} Record actual artifacts and checks using scoped worker.submit before this Turn ends. Do not invent a Delivery.`;
    const skillPath = profile.skillPath ?? `${profile.cwd}/.agents/skills/evoloop-workflow/SKILL.md`;
    const input = `Managed evoLoop ${kind} Run. Project ${loop.projectId}; loop ${loop.id}; dispatch ${dispatch.id}; Run ${runId}; Task ${dispatch.taskId}; source inbox ${dispatch.inboxId}; source event ${dispatch.sourceEventId}. Scoped CLI: ${wrapperPath}\n${message}${gapContext}${resumeContext}${studyResumeContext}${scheduleContext}\nAuthorized writable workspace: ${profile.cwd}. Write command JSON files inside this directory, not /tmp or other external paths. Use the wrapper with command run FILE. Read this Run directly with get /api/projects/${loop.projectId}/runtime/runs/${runId} for its exact inputHash and taskRevisionId.\nProject skill: ${skillPath}`;
    if (input.length > 4000) throw new Error("WORKER_INPUT_TOO_LONG");
    return input;
  }
  /** Recover the same transfer and child request after any crash; never infer a new choice from native text. */
  private async continueDivision(loop: OrchestrationLoop, parent: OrchestrationDispatch, cognitive: ManagedRoleProfile) {
    if (parent.state !== "completed" || parent.outcome !== "waiting" || !parent.runtimeRunId) return;
    const decision = await this.deps.orchestration.getDecisionForDispatch(cognitive.principal, loop.projectId, parent.id);
    if (!decision || decision.kind !== "waiting" || !decision.divisionDecisionId || decision.runId !== parent.runtimeRunId) return;
    const intent = await this.deps.orchestration.getDivisionDecisionFact(cognitive.principal,loop.projectId,decision.divisionDecisionId);
    if (intent?.choice === "method" && intent.loopId === loop.id && intent.parentDispatchId === parent.id &&
        intent.sourceEventId === parent.sourceEventId) return; // Legacy signed method-waiting has no binding or automatic child.
    const binding = await this.deps.orchestration.getBinding(cognitive.principal, loop.projectId, decision.divisionDecisionId);
    if (!binding || binding.parentDispatchId !== parent.id || binding.sourceEventId !== parent.sourceEventId ||
      binding.firstTaskId === parent.taskId || binding.loopId !== loop.id) throw new Error("DIVISION_BINDING_MISMATCH");
    const childId = loopIntentId(binding.id, "division-child");
    let child = await this.deps.orchestration.getDispatch(cognitive.principal, loop.projectId, childId);
    const reserved = child ?? { ...parent, id: childId,
      taskId: binding.firstTaskId, parentDispatchId: parent.id,
      recipientRoleId: binding.roleId, authorizationScopeId: binding.authorizationScopeId,
      bindingId: binding.id,
      ...(loop.currentPolicyRevisionId ? {policyRevisionId:loop.currentPolicyRevisionId} : {}) };
    const profile = await this.deps.dynamicController?.(reserved);
    if (!child && !profile) throw new Error("DIVISION_GRANT_UNAVAILABLE");
    const reader = profile?.principal ?? cognitive.principal;
    const run = await this.deps.workflow.getRuntimeRun(reader, loop.projectId, parent.runtimeRunId);
    if (run.state !== "completed") return;
    if (!child) {
      const currentLoop = await this.deps.orchestration.getLoop(profile!.principal, loop.projectId, loop.id);
      if (!currentLoop || currentLoop.state !== "active") return;
      await this.deps.orchestration.execute(profile!.principal, { type: "division.consume", projectId: loop.projectId,
        operationId: loopIntentId(binding.id, "division.consume"), loopId: loop.id,
        expectedLoopVersion: currentLoop.version, bindingId: binding.id, waitingDecisionId: decision.id,
        parentDispatchId: parent.id, dispatchId: childId, reason: `First Task from division ${binding.id}` });
      child = await this.deps.orchestration.getDispatch(profile!.principal, loop.projectId, childId);
    }
    if (!child || child.state !== "pending" || child.taskVersion !== binding.firstTaskVersion) return;
    const transferOperationId = loopIntentId(binding.id, "task.transfer");
    const historical = await this.deps.dynamicController?.(child, true);
    if (!historical) throw new Error("DIVISION_HISTORICAL_OWNER_UNAVAILABLE");
    const prior = await this.deps.workflow.getOperation(historical.principal, loop.projectId, transferOperationId);
    if (!prior) {
      if (!profile) return; // Revocation or expiry may not start a new transfer.
      const detail = await this.deps.workflow.getTask(profile.principal, loop.projectId, binding.firstTaskId);
      if (detail.task.state !== "todo") throw new Error("TASK_HANDOFF_REQUIRES_REOPEN");
      if (detail.task.version !== binding.firstTaskVersion || detail.task.owner === binding.roleId)
        throw new Error("DIVISION_TASK_HANDOFF_BASELINE_CHANGED");
      applied(await this.deps.workflow.execute(profile.principal, { type: "task.update", projectId: loop.projectId,
        operationId: transferOperationId, taskId: detail.task.id, expectedVersion: binding.firstTaskVersion,
        title: detail.task.title, content: detail.task.content, acceptance: detail.task.acceptance,
        owner: binding.roleId, kind: detail.task.kind, reason: `division-transfer:${binding.id}` }));
    } else applied(prior.result);
    const transferred = await this.deps.workflow.getTask(historical.principal, loop.projectId, binding.firstTaskId);
    await this.deps.orchestration.execute(historical.principal, { type: "division.confirmTransfer", projectId: loop.projectId,
      operationId: loopIntentId(binding.id, "division.confirmTransfer"), dispatchId: childId,
      transferOperationId, transferredTaskVersion: transferred.task.version,
      reason: "Journalled Task owner transfer confirmed" });
  }
  private async settle(dispatch: OrchestrationDispatch) {
    if (!dispatch.runtimeRunId) throw new Error("ACCEPTED_DISPATCH_WITHOUT_RUN");
    const profile = dispatch.bindingId ? await this.deps.dynamicController?.(dispatch, true) :
      await this.deps.controller(dispatch.projectId, dispatch.recipientRoleId);
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
