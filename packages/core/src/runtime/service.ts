import type { Principal, RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { bindingMatchesSession, sessionProvider, type RuntimeProvider, nativeChildDiagnosticSchema, preTurnProofSchema, type PreTurnProof, type EvaluationPacketBinding, type NativeChildDiagnosticRecord,
  type NativeResumeRejection, type RunActual, type RuntimeBinding, type RuntimeSessionSpec, type RuntimeTurn, type RuntimeUsage } from "@evoloop/contracts/runtime";
import type { ExecutionProfileRevision } from "@evoloop/contracts/session-recovery";
import { DomainError } from "@evoloop/contracts/ports";
import { holdsProvider } from "@evoloop/contracts/provider-hold";
import type { Clock, IdFactory, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { event } from "./reserve.js";
import { validateDispatchBasis } from "./basis.js";
import { priorReviewDecision, reviewIntentJson } from "./pre-turn-review.js";
import { inclusiveRuntimeUsage } from "../usage.js";

export interface RuntimeWorkflowDependencies { uow: UnitOfWork; clock: Clock; ids: IdFactory;
  /** Local day used by the usage ledger; absent keeps canonical UTC. */
  usageDay?: (at: string) => string; }
const internalActor = "runtime-coordinator";
const required = <T>(value: T | null, kind: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${kind} not found`);
  return value;
};
const safeDetail = (value: string): string => value.slice(0, 4000);
const nativeResumeRejectionCategories = new Set<NativeResumeRejection["category"]>([
  "rollout_not_found", "thread_unavailable", "invalid_params", "method_not_found", "permission_denied", "server_rejected",
]);
const tokenCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const validUsage = (usage: RuntimeUsage): boolean => tokenCount(usage.inputTokens) && tokenCount(usage.outputTokens) &&
  (usage.cacheReadInputTokens === undefined || tokenCount(usage.cacheReadInputTokens)) &&
  (usage.cacheCreationInputTokens === undefined || tokenCount(usage.cacheCreationInputTokens));
const canonicalUtc = (value: string): boolean => {
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value;
};

/** Trusted coordinator entry. Never expose these result-recording methods as public HTTP commands. */
/** Requested effort (from the Run's frozen profile) beside the effort the Thread reported after turn/start. */
function effortNote(run: RuntimeRunRecord, turn: RuntimeTurn): string {
  return describeTurnEffort(run.executionProfile?.reasoningEffort ?? null, turn);
}
/** "; effort requested=… observed=…" for a started Turn, empty when no effort was involved. An unread value is never shown as consistent. */
export function describeTurnEffort(requested: string | null, turn: RuntimeTurn): string {
  if (!requested && turn.observedReasoningEffort === undefined) return "";
  const observed = turn.observedReasoningEffort ?? null;
  return `; effort requested=${requested ?? "none"} observed=${observed ?? "unread"}${requested && observed && requested !== observed ? " MISMATCH" : ""}`;
}

/**
 * The observed side of a Run's Turn after a new observation. A value the runtime reported replaces an earlier one; a field it did not
 * report (undefined) or could not read (null) keeps what was recorded, else stays null. Nothing here comes from the configured profile.
 * Returns the prior value untouched when the observation says nothing about model, effort or subagents.
 */
export function mergeRunActual(prior: RunActual | null | undefined,
  seen: { model?: string | null | undefined; reasoningEffort?: string | null | undefined; subagentModels?: string[] | null | undefined; effortRequested?: boolean | undefined }): RunActual | null {
  if (seen.model === undefined && seen.reasoningEffort === undefined && seen.subagentModels === undefined) return prior ?? null;
  const requested = seen.effortRequested ?? prior?.effortRequested;
  return { model: seen.model ?? prior?.model ?? null, reasoningEffort: seen.reasoningEffort ?? prior?.reasoningEffort ?? null,
    subagentModels: seen.subagentModels?.length ? [...new Set(seen.subagentModels)].sort() : prior?.subagentModels ?? [],
    ...(requested === undefined ? {} : { effortRequested: requested }) };
}

export class RuntimeWorkflowService {
  constructor(private readonly deps: RuntimeWorkflowDependencies) {}

  /** Append a bounded, source-free child observation; loss and exit are separate snapshots. */
  async recordNativeChildDiagnostic(projectId:string, diagnostic:NativeChildDiagnosticRecord):Promise<void>{
    const validated=nativeChildDiagnosticSchema.safeParse(diagnostic);
    if(!validated.success)
      throw new DomainError('INVALID_NATIVE_DIAGNOSTIC','native child diagnostic has invalid bounded fields');
    await this.deps.uow.transaction(projectId,async tx=>{
      const detail=JSON.stringify(validated.data);
      const sessions=await tx.listRuntimeSessions();
      // The event table requires a Session foreign key. Anchor each host snapshot
      // once per project, including when only reserved Sessions exist. No fanout:
      // two snapshots per child keep the last 16 starts within a 32-row read.
      const anchor=sessions.find(session=>!!session.nativeThreadId&&['ready','closing'].includes(session.state))??sessions[0];
      if(anchor)await this.emit(tx,null,anchor.id,'native.childDiagnostic',detail,null,projectId);
    });
  }

  async recentNativeChildDiagnostics(projectId:string):Promise<RuntimeRecordEvent[]>{
    return this.deps.uow.read(projectId,async reader=>await reader.listRuntimeHostEvents?.(32)??[]);
  }

  async verifyBinding(projectId: string, binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.deps.uow.read(projectId, async reader => {
      const saved = required(await reader.getRuntimeSession(binding.sessionId), "runtime session");
      if (!["ready", "closing"].includes(saved.state) || !bindingMatchesSession(binding, saved) ||
        binding.projectId !== projectId || binding.roleId !== saved.roleId ||
        binding.cwd !== saved.cwd || binding.authorizationScope !== saved.authorizationScope ||
        binding.nativeThreadId !== saved.nativeThreadId || binding.nativeSessionId !== saved.nativeSessionId) {
        throw new DomainError("FOREIGN_BINDING", "native binding does not match an owned active session");
      }
      const confirmed=saved.executionProfile?.activeRevisionId;
      const activeModel=saved.executionProfile?.activationState==='active'?saved.model:saved.executionProfile?.activeModel;
      const activeEffort=saved.executionProfile?.activationState==='active'?
        saved.executionProfile.revision.reasoningEffort:saved.executionProfile?.activeReasoningEffort;
      if(saved.executionProfile && (binding.resumeProfile?.actorId!==saved.actorId||
        binding.resumeProfile.model!==activeModel||
        (binding.resumeProfile.reasoningEffort??null)!==(activeEffort??null)||
        binding.resumeProfile.sandbox!==saved.sandbox||
        binding.resumeProfile.approvalPolicy!==saved.approvalPolicy))
        throw new DomainError("FOREIGN_BINDING","registered native profile differs from the owned Session");
      if (saved.executionProfile && (!confirmed ||
        binding.resumeProfile?.executionProfileRevisionId !== confirmed ||
        binding.resumeProfile.model !== activeModel))
        throw new DomainError("EXECUTION_PROFILE_NOT_ACTIVE", "binding is not the confirmed Session execution profile");
      return saved;
    });
  }

  async getExecutionProfileRevision(projectId:string,sessionId:string,revisionId:string):Promise<ExecutionProfileRevision>{
    return this.deps.uow.read(projectId,async reader =>
      required(await reader.recovery?.getExecutionProfileRevision(sessionId,revisionId)??null,"execution profile revision"));
  }

  /** Adapter preflight; the native caller cannot invent or substitute a pending revision. */
  async verifyExecutionProfileActivation(projectId:string,current:RuntimeBinding,target:RuntimeSessionSpec,
    revisionId:string,operationId:string):Promise<boolean>{
    return this.deps.uow.read(projectId,async reader=>{
      const saved=await reader.getRuntimeSession(current.sessionId);
      const adopted=saved?.executionProfile;
      if(!saved||saved.projectId!==projectId||saved.state!=="ready"||
        saved.nativeThreadId!==current.nativeThreadId||saved.nativeSessionId!==current.nativeSessionId||
        saved.cwd!==current.cwd||saved.roleId!==current.roleId||saved.authorizationScope!==current.authorizationScope||
        saved.actorId!==current.resumeProfile?.actorId||
        !adopted||!["attempting","unknown"].includes(adopted.activationState)||
        adopted.revision.revisionId!==revisionId||adopted.revision.operationId!==operationId||
        adopted.activeRevisionId!==current.resumeProfile.executionProfileRevisionId||
        adopted.revision.model!==target.model||saved.model!==adopted.revision.model||
        adopted.revision.reasoningEffort!==target.reasoningEffort||
        adopted.revision.sandbox!==target.sandbox||saved.sandbox!==adopted.revision.sandbox||
        adopted.revision.approvalPolicy!==target.approvalPolicy||saved.approvalPolicy!==adopted.revision.approvalPolicy||
        target.executionProfileRevisionId!==revisionId||
        target.actorId!==saved.actorId||target.projectId!==projectId||target.sessionId!==saved.id||
        target.roleId!==saved.roleId||target.cwd!==saved.cwd||
        target.authorizationScope!==saved.authorizationScope||target.sandbox!==saved.sandbox||
        target.approvalPolicy!==saved.approvalPolicy)return false;
      const previous=adopted.activeRevisionId?
        await reader.recovery?.getExecutionProfileRevision(saved.id,adopted.activeRevisionId):null;
      if(!previous||previous.model!==current.resumeProfile.model||
        (previous.reasoningEffort??null)!==(current.resumeProfile.reasoningEffort??null)||
        previous.sandbox!==current.resumeProfile.sandbox||
        previous.approvalPolicy!==current.resumeProfile.approvalPolicy||
        previous.cwd!==current.cwd||previous.authorizationScope!==current.authorizationScope)return false;
      let cursor=adopted.revision;
      const seen=new Set<string>();
      while(cursor.revisionId!==previous.revisionId&&seen.size<1000){
        if(seen.has(cursor.revisionId)||!cursor.previousRevisionId)return false;
        seen.add(cursor.revisionId);
        const parent=await reader.recovery?.getExecutionProfileRevision(saved.id,cursor.previousRevisionId);
        if(!parent||parent.version!==cursor.version-1)return false;
        cursor=parent;
      }
      return cursor.revisionId===previous.revisionId;
    });
  }

  async beginExecutionProfileActivation(projectId:string,sessionId:string,revisionId:string,
    operationId:string):Promise<boolean>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const profile=required(await tx.recovery?.getExecutionProfileRevision(sessionId,revisionId)??null,"execution profile revision");
      if(profile.operationId!==operationId)throw new DomainError("EXECUTION_PROFILE_OPERATION_MISMATCH","profile activation must use its original operation");
      const claimed=await tx.recovery!.beginExecutionProfileActivation(sessionId,revisionId,operationId);
      if(claimed)await this.emit(tx,null,sessionId,"session.executionProfile.activationStarted",
        `Execution profile revision ${revisionId} native resume attempt began`,null,projectId);
      return claimed;
    });
  }

  /** Read-only admission hint. The transactional startup guard remains authoritative. */
  async canStartRecoveredRun(projectId:string,sessionId:string,runId:string):Promise<boolean>{
    return this.deps.uow.read(projectId,async reader=>{
      if(!reader.recovery)throw new DomainError("CAPABILITY_UNAVAILABLE","Session recovery gate unavailable");
      const gate=required(await reader.recovery.getRecoveryGate(sessionId),"Session recovery gate");
      return gate.phase==='open'||['retrying','reworking'].includes(gate.phase)&&gate.retryRunId===runId;
    });
  }

  async settleExecutionProfileActivation(projectId:string,sessionId:string,revisionId:string,
    state:"active"|"unknown"|"rejected",evidence:string):Promise<void>{
    return this.deps.uow.transaction(projectId,async tx=>{
      if(!tx.recovery)throw new DomainError("CAPABILITY_UNAVAILABLE","execution profile persistence unavailable");
      await tx.recovery.settleExecutionProfileActivation(sessionId,revisionId,state,safeDetail(evidence));
      await this.emit(tx,null,sessionId,`session.executionProfile.${state}`,safeDetail(evidence),null,projectId);
    });
  }

  async markSessionArchiveAttempt(projectId: string, sessionId: string, closeOperationId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (current.state !== "closing" || current.closeOperationId !== closeOperationId || current.closeAttemptedAt)
        throw new DomainError("CLOSE_NOT_PENDING", "archive was already attempted or close intent changed");
      const now = this.deps.clock.now();
      const next = { ...current, version: current.version + 1, closeAttemptedAt: now, updatedAt: now };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.archiveAttempted", "Archive may have been sent; recovery only reads native state", null, projectId);
      return next;
    });
  }

  async confirmSessionClosed(projectId: string, binding: RuntimeBinding, closeOperationId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(binding.sessionId), "runtime session");
      if (current.state !== "closing" || current.closeOperationId !== closeOperationId ||
        !bindingMatchesSession(binding, current) || binding.projectId !== projectId ||
        binding.roleId !== current.roleId || binding.cwd !== current.cwd || binding.authorizationScope !== current.authorizationScope ||
        binding.nativeThreadId !== current.nativeThreadId || binding.nativeSessionId !== current.nativeSessionId)
        throw new DomainError("FOREIGN_BINDING", "close proof does not match pending owned session");
      const now = this.deps.clock.now();
      const next = { ...current, state: "closed" as const, version: current.version + 1, closeVerifiedAt: now, updatedAt: now };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, current.id, "session.closed", "Exact owned native thread verified in archived listing", null, projectId);
      return next;
    });
  }

  private async emit(tx: Transaction, runId: string | null, sessionId: string | null,
    kind: RuntimeRecordEvent["kind"], detail: string, nativeTurnId: string | null,
    projectId: string, cursor: string | null = null, itemsDigest: string | null = null): Promise<void> {
    await tx.appendRuntimeEvent(event(projectId, this.deps.ids.next(), runId, sessionId,
      kind, safeDetail(detail), nativeTurnId, internalActor, this.deps.clock.now(), cursor, itemsDigest));
  }

  async beginSessionCreate(projectId: string, sessionId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      // Match execution-profile adoption for a reserved Session: gate before its row.
      await tx.recovery?.lockRecoveryGate(sessionId);
      const current = required(await (tx.lockRuntimeSession?.(sessionId) ?? tx.getRuntimeSession(sessionId)), "runtime session");
      if (current.state !== "reserved") throw new DomainError("SESSION_NOT_RESERVED", "session create was already attempted");
      const next = { ...current, state: "creating" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.creating", "External thread creation may now begin", null, projectId);
      return next;
    });
  }

  async bindSession(projectId: string, sessionId: string, binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (!["creating", "unknown"].includes(current.state)) throw new DomainError("SESSION_NOT_CREATING", "session cannot bind from current state");
      if (!bindingMatchesSession(binding, current) || binding.projectId !== projectId || binding.sessionId !== sessionId ||
        binding.roleId !== current.roleId || binding.cwd !== current.cwd || binding.authorizationScope !== current.authorizationScope ||
        !binding.nativeThreadId || !binding.nativeSessionId ||
        (binding.observedModel != null && current.model != null && binding.observedModel !== current.model) ||
        current.executionProfile && (binding.resumeProfile?.executionProfileRevisionId !== current.executionProfile.revision.revisionId ||
          binding.resumeProfile.model !== current.executionProfile.revision.model ||
          binding.resumeProfile.actorId!==current.actorId||binding.resumeProfile.sandbox!==current.sandbox||
          binding.resumeProfile.approvalPolicy!==current.approvalPolicy)) {
        throw new DomainError("FOREIGN_BINDING", "native binding does not match reserved project session");
      }
      const next = { ...current, state: "ready" as const, version: current.version + 1,
        nativeThreadId: binding.nativeThreadId, nativeSessionId: binding.nativeSessionId,
        observedModel:binding.observedModel??null,observedProvider:binding.observedProvider??null,
        updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.bound", "Owned native thread bound", null, projectId);
      return next;
    });
  }

  async markSessionUnknown(projectId: string, sessionId: string, reason: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (current.state === "unknown") return current;
      if (current.state !== "creating") throw new DomainError("SESSION_NOT_CREATING", "only a started create can become unknown");
      const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.unknown", reason, null, projectId);
      return next;
    });
  }

  async beginDispatch(projectId: string, runId: string,
    inputReceipt?: { protocol: string; contentHash: string; byteLength: number }): Promise<RuntimeRunRecord> {
    if (inputReceipt && (!/^[a-z0-9-]{1,80}$/.test(inputReceipt.protocol) ||
        !/^[a-f0-9]{64}$/.test(inputReceipt.contentHash) ||
        !Number.isSafeInteger(inputReceipt.byteLength) || inputReceipt.byteLength < 1))
      throw new DomainError("INVALID_INPUT_RECEIPT", "prepared native input receipt is invalid");
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.state !== "requested") throw new DomainError("RUN_NOT_REQUESTED", "turn start was already attempted");
      if (current.stopRequestedAt) throw new DomainError("RUN_STOPPED", "the Run was stopped on request and cannot be dispatched");
      if (current.evaluationBinding && !current.evaluationPacket)
        throw new DomainError("EVALUATION_PACKET_MISSING", "a verified fixed-input packet is required before evaluation dispatch");
      const session = required(await tx.getRuntimeSession(current.sessionId), "runtime session");
      if (session.state !== "ready" || !session.nativeThreadId) throw new DomainError("SESSION_NOT_READY", "owned session is not ready");
      if(session.executionProfile||current.executionProfile){
        if(!session.executionProfile||!current.executionProfile||session.executionProfile.activationState!=="active"||
          current.executionProfile.revisionId!==session.executionProfile.revision.revisionId)
          throw new DomainError("EXECUTION_PROFILE_NOT_ACTIVE","Run's fixed execution profile is not active");
      }
      await tx.recovery?.assertStartupAllowed(session.id,"run",current.id);
      const task = required(await tx.getTask(current.taskId), "task");
      if (task.state !== "in_progress" || task.currentRevisionId !== current.taskRevisionId) {
        throw new DomainError("TASK_CHANGED", "task changed after run reservation");
      }
      if ((await tx.listImpacts(task.id)).some(item => item.state === "pending")) {
        throw new DomainError("PENDING_BASIS_REVIEW", "review pending basis impacts before dispatch");
      }
      const revision = required(await tx.getTaskRevision(task.id, current.taskRevisionId), "task revision");
      const basis = required(revision.basisSetId ? await tx.getBasisSet(task.id, revision.id, revision.basisSetId) : null, "sealed basis");
      await validateDispatchBasis(tx, task.id, basis);
      const next = { ...current, state: "dispatching" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.dispatching",
        inputReceipt ? `External turn/start may now begin; prepared input ${inputReceipt.protocol} SHA256 ${inputReceipt.contentHash} bytes ${inputReceipt.byteLength}` :
          "External turn/start may now begin", null, projectId);
      return next;
    });
  }

  /** Coordinator registers the already verified Blob-backed native input before any startTurn attempt. */
  async attachEvaluationPacket(projectId: string, runId: string, expectedVersion: number,
    packet: EvaluationPacketBinding): Promise<RuntimeRunRecord> {
    if (!/^[a-f0-9]{64}$/.test(packet.contentHash) || !/^[a-f0-9]{64}$/.test(packet.manifestHash) ||
      !packet.payloadRef || !packet.builderVersion || !packet.sources.length)
      throw new DomainError("INVALID_EVALUATION_PACKET", "packet requires Blob identity, hashes, builder and fixed sources");
    return this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!run.evaluationBinding || run.state !== "requested" || run.version !== expectedVersion || run.evaluationPacket)
        throw new DomainError("EVALUATION_PACKET_CONFLICT", "packet can only be attached once to a requested evaluation Run", run.version);
      const revision = required(await tx.getEvaluation(run.evaluationBinding.evaluationId, run.evaluationBinding.revisionId), "evaluation revision");
      const condition = revision.definition.conditions.find(item => item.id === run.evaluationBinding?.conditionId);
      if (!condition) throw new DomainError("EVALUATION_CONDITION_MISSING", "Run condition is unavailable");
      const signature = revision.definition.case.sourceSignature;
      const mandatory = [
        ...signature.basis.map(item => ({ kind: "document" as const, id: item.documentId,
          revision: item.revisionId, contentHash: item.contentHash })),
        ...signature.external.map(item => ({ kind: item.kind, id: item.referenceId,
          revision: item.revision, contentHash: item.contentHash })),
      ];
      const expected = [revision.definition.protocol, ...revision.definition.case.materials, ...mandatory, ...(condition.wikiRefs ?? [])];
      const key = (item: typeof expected[number]) => `${item.kind}:${item.id}:${item.revision}:${item.contentHash}`;
      if ([...new Set(expected.map(key))].sort().join("|") !== [...new Set(packet.sources.map(key))].sort().join("|") ||
        packet.sources.length !== new Set(packet.sources.map(key)).size)
        throw new DomainError("EVALUATION_PACKET_SOURCES", "packet manifest differs from frozen sources");
      const next = { ...run, evaluationPacket: packet, version: run.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, run.version);
      return next;
    });
  }

  /** Records a preflight failure, or an exact native thread/resume rejection before turn/start. */
  async rejectDispatch(projectId: string, runId: string, reason: string,
    proof?: NativeResumeRejection): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (proof) {
        if (proof.kind !== "native_resume_rejected" || proof.operationId !== current.operationId ||
          !Number.isSafeInteger(proof.code) || Math.abs(proof.code) > 2147483647 ||
          !nativeResumeRejectionCategories.has(proof.category))
          throw new DomainError("NATIVE_REJECTION_PROOF_INVALID", "native resume rejection proof does not match this Run");
        if (current.state !== "dispatching" || current.nativeTurnId !== null)
          throw new DomainError("RUN_NOT_DISPATCHING", "native resume rejection requires an unstarted dispatching Run");
      } else if (current.state !== "requested")
        throw new DomainError("RUN_NOT_REQUESTED", "preflight rejection is only valid before external dispatch");
      const detail = proof ? `Native thread/resume rejected (${proof.category}, code ${proof.code})` : reason;
      const next: RuntimeRunRecord = { ...current, state: "failed", version: current.version + 1,
        resultSummary: safeDetail(detail), updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, proof ? "run.dispatchRejected" : "run.preflightRejected", detail, null, projectId);
      await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
        effectKey: `${projectId}:runtime.run.failed:${runId}`, kind: "runtime.run.failed",
        entityId: runId, version: next.version, createdAt: this.deps.clock.now() });
      return next;
    });
  }

  /**
   * The adapter proved the start request never left this process (RuntimeNotSentError: no write was
   * attempted). Only then may a dispatching Run return to requested; any written or uncertain start
   * must become unknown instead.
   */
  async withdrawDispatch(projectId: string, runId: string, detail: string): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.state !== "dispatching" || current.nativeTurnId !== null || current.preTurnProof)
        throw new DomainError("RUN_NOT_DISPATCHING", "only an unstarted dispatching Run can be withdrawn");
      // A stopped Run never goes back to being dispatchable: the native start was not sent, so it ends here as failed.
      const stopped = !!current.stopRequestedAt;
      const next: RuntimeRunRecord = { ...current, state: stopped ? "failed" : "requested", version: current.version + 1, updatedAt: this.deps.clock.now(),
        ...(stopped ? { resultSummary: `Stopped on request before the native start was sent: ${current.stopReason ?? ""}`.slice(0, 4000) } : {}) };
      await tx.updateRuntimeRun(next, current.version);
      if (stopped) {
        await this.emit(tx, runId, current.sessionId, "run.dispatchWithdrawn",
          `Native start was not sent and the Run was stopped on request; it ends as failed, not requested; ${detail}`, null, projectId);
        return next;
      }
      await this.emit(tx, runId, current.sessionId, "run.dispatchWithdrawn",
        `Native start was not sent; Run returns to requested for a later dispatch; ${detail}`, null, projectId);
      return next;
    });
  }

  async bindTurn(projectId: string, runId: string, turn: RuntimeTurn,
    proof: { kind: "startReply" | "historyMarker"; operationId: string;
      inputReceipt?: { protocol: string; contentHash: string; byteLength: number } }): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (proof.operationId !== current.operationId || !turn.id) throw new DomainError("TURN_PROOF_MISMATCH", "turn must match durable dispatch operation");
      if (current.state === "unknown" && proof.kind !== "historyMarker" &&
          !(proof.kind === "startReply" && current.preTurnProof?.status === "attempting")) {
        throw new DomainError("HISTORY_PROOF_REQUIRED", "unknown start needs owned-history operation marker");
      }
      if (!["dispatching", "unknown"].includes(current.state)) throw new DomainError("RUN_NOT_DISPATCHING", "run cannot bind a new turn");
      if (current.nativeTurnId && current.nativeTurnId !== turn.id) throw new DomainError("FOREIGN_TURN", "run already has a different native turn");
      // A stop that arrived while the start was in flight: the Turn that binds now is interrupted at once.
      const actual = mergeRunActual(current.actual, { model: turn.observedModel, reasoningEffort: turn.observedReasoningEffort, subagentModels: turn.subagentModels,
        // Asked or left to the default is the Run's configuration; it only describes how to read the reported value, never replaces it.
        ...(turn.observedReasoningEffort !== undefined ? { effortRequested: !!current.executionProfile?.reasoningEffort } : {}) });
      const next = { ...current, state: "running" as const, version: current.version + 1,
        ...(actual ? { actual } : {}),
        ...(current.stopRequestedAt ? { interruptRequested: true } : {}),
        preTurnProof: current.preTurnProof ? { ...current.preTurnProof, status: "consumed" as const } : null,
        nativeTurnId: turn.id, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      if (turn.observedModel) await tx.recordSessionActualModel?.(current.sessionId, turn.observedModel, this.deps.clock.now());
      await this.emit(tx, runId, current.sessionId, "run.bound",
        proof.inputReceipt && proof.kind === "startReply" ?
          `Turn bound from startReply; sent input ${proof.inputReceipt.protocol} SHA256 ${proof.inputReceipt.contentHash} bytes ${proof.inputReceipt.byteLength}${effortNote(current, turn)}` :
          `Turn bound from ${proof.kind}${effortNote(current, turn)}`, turn.id, projectId);
      return next;
    });
  }

  async markRunUnknown(projectId: string, runId: string, reason: string,
    writerProof?: Pick<PreTurnProof,"threadId"|"operationId"|"requestId"|"code"|"inputHash">): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (writerProof) {
        const session=required(await tx.getRuntimeSession(current.sessionId),"runtime session");
        if(writerProof.threadId!==session.nativeThreadId||writerProof.operationId!==current.operationId||
          writerProof.code!==-32600||!Number.isSafeInteger(writerProof.requestId)||writerProof.requestId<1||
          current.nativeTurnId||!(current.state==="dispatching"||current.state==="unknown"&&current.preTurnProof?.status==="attempting"))
          throw new DomainError("PRE_TURN_PROOF_INVALID","native writer refusal does not match the original unstarted Run");
      }
      if (current.state === "unknown" && !writerProof && current.preTurnProof?.status!=="attempting") return current;
      if (!["dispatching", "running"].includes(current.state) &&
          !(current.state==="unknown"&&current.preTurnProof?.status==="attempting"))
        throw new DomainError("RUN_NOT_IN_FLIGHT", "only in-flight turn can become unknown");
      const preTurnProof: PreTurnProof|null=writerProof?preTurnProofSchema.parse({
        ...writerProof,observedAtUtc:this.deps.clock.now(),status:"observed",decisionOperationId:null,reviewerActorId:null,evidenceRef:null,
      }):current.preTurnProof?.status==="attempting"?{...current.preTurnProof,status:"consumed"}:current.preTurnProof??null;
      const next = { ...current, state: "unknown" as const, preTurnProof, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.unknown", reason, current.nativeTurnId, projectId);
      return next;
    });
  }

  /** Reviewer grants one attempt for the same operation after an exact pre-turn rejection. */
  async approvePreTurnContinuation(projectId:string,runId:string,principal:Principal,
    command:{operationId:string;sessionId:string;originalOperationId:string;expectedVersion:number;expectedGateVersion:number;evidenceRef:string;reason:string}):Promise<RuntimeRunRecord>{
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("review")||principal.actorId.startsWith("worker-"))
      throw new DomainError("FORBIDDEN","pre-turn continuation requires project review authority");
    return this.deps.uow.transaction(projectId,async tx=>{
      const intentJson=reviewIntentJson(principal.actorId,'run',runId,command);
      const prior=await priorReviewDecision<RuntimeRunRecord>(tx,command.operationId,
        principal.actorId,'run',runId,intentJson);
      if(prior)return prior;
      const run=required(await tx.getRuntimeRun(runId),"runtime run");
      const session=required(await tx.getRuntimeSession(run.sessionId),"runtime session");
      const gate=required(await tx.recovery?.lockRecoveryGate(run.sessionId)??null,"recovery gate");
      const proof=run.preTurnProof;
      if(run.stopRequestedAt){
        // A stopped Run is never continued: its approved start would only run work somebody asked to stop. Here approval means
        // "the observed refusal is true, so the Turn never began": the Run ends failed, which reopens the gate it closed (079).
        if(run.version!==command.expectedVersion||run.sessionId!==command.sessionId||
          run.operationId!==command.originalOperationId||run.state!=="unknown"||run.nativeTurnId||
          !proof||proof.status!=="observed"||proof.operationId!==run.operationId||
          gate.version!==command.expectedGateVersion||gate.phase!=="blocked"||gate.causeKind!=="run"||gate.causeId!==run.id)
          throw new DomainError("PRE_TURN_CONTINUATION_CHANGED","original refusal or recovery gate changed");
        const reviewed={...run,version:run.version+1,updatedAt:this.deps.clock.now(),
          preTurnProof:preTurnProofSchema.parse({...proof,status:"approved",decisionOperationId:command.operationId,
            reviewerActorId:principal.actorId,evidenceRef:command.evidenceRef,
            decisionReason:safeDetail(command.reason),gateVersionAtApproval:gate.version})};
        await tx.appendRuntimeEvent(event(projectId,this.deps.ids.next(),run.id,run.sessionId,'run.reviewed',
          JSON.stringify({decisionOperationId:command.operationId,originalOperationId:run.operationId,
            requestId:proof.requestId,observedAtUtc:proof.observedAtUtc,
            evidenceRef:command.evidenceRef,reason:command.reason}),null,principal.actorId,this.deps.clock.now()));
        // The proof guard (055) only allows observed -> approved on an unknown Run; the end is a second step in the same transaction.
        await tx.updateRuntimeRun(reviewed,run.version);
        const ended={...reviewed,state:"failed" as const,version:reviewed.version+1,updatedAt:this.deps.clock.now(),
          resultSummary:"Stopped on request; the reviewed pre-turn refusal shows the native Turn never began"};
        await tx.updateRuntimeRun(ended,reviewed.version);
        await this.emit(tx,runId,run.sessionId,"run.status",ended.resultSummary!,null,projectId);
        await tx.insertPreTurnReviewDecision({operationId:command.operationId,actorId:principal.actorId,
          kind:'run',subjectId:runId,intentJson,result:ended});
        return ended;
      }
      if(run.version!==command.expectedVersion||run.sessionId!==command.sessionId||
        run.operationId!==command.originalOperationId||run.state!=="unknown"||run.nativeTurnId||
        !proof||proof.status!=="observed"||proof.operationId!==run.operationId||
        proof.threadId!==session.nativeThreadId||session.state!=="ready"||
        gate.version!==command.expectedGateVersion||gate.phase!=="blocked"||gate.causeKind!=="run"||gate.causeId!==run.id||
        session.executionProfile?.activationState!=="active"||
        run.executionProfile?.revisionId!==session.executionProfile?.revision.revisionId)
        throw new DomainError("PRE_TURN_CONTINUATION_CHANGED","original refusal, profile or recovery gate changed");
      const next={...run,version:run.version+1,updatedAt:this.deps.clock.now(),
        preTurnProof:preTurnProofSchema.parse({...proof,status:"approved",decisionOperationId:command.operationId,
          reviewerActorId:principal.actorId,evidenceRef:command.evidenceRef,
          decisionReason:safeDetail(command.reason),gateVersionAtApproval:gate.version})};
      await tx.appendRuntimeEvent(event(projectId,this.deps.ids.next(),run.id,run.sessionId,'run.reviewed',
        JSON.stringify({decisionOperationId:command.operationId,originalOperationId:run.operationId,
          requestId:proof.requestId,observedAtUtc:proof.observedAtUtc,
          evidenceRef:command.evidenceRef,reason:command.reason}),null,principal.actorId,this.deps.clock.now()));
      await tx.updateRuntimeRun(next,run.version);
      await tx.insertPreTurnReviewDecision({operationId:command.operationId,actorId:principal.actorId,
        kind:'run',subjectId:runId,intentJson,result:next});
      return next;
    });
  }
  async readPreTurnContinuationDecision(projectId:string,runId:string,principal:Principal,
    command:Parameters<RuntimeWorkflowService['approvePreTurnContinuation']>[3]):Promise<RuntimeRunRecord|null>{
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("review")||principal.actorId.startsWith("worker-"))
      throw new DomainError("FORBIDDEN","pre-turn continuation requires project review authority");
    return this.deps.uow.read(projectId,reader=>priorReviewDecision<RuntimeRunRecord>(reader,
      command.operationId,principal.actorId,'run',runId,
      reviewIntentJson(principal.actorId,'run',runId,command)));
  }

  /** Consumed before native I/O. A crash or lost reply cannot acquire another permit. */
  async claimPreTurnContinuation(projectId:string,runId:string):Promise<RuntimeRunRecord|null>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const run=required(await tx.getRuntimeRun(runId),"runtime run");
      if(run.state!=="unknown"||run.preTurnProof?.status!=="approved"||run.nativeTurnId)return null;
      if(run.stopRequestedAt){
        // The approved start was never sent and nobody will send it now: the stopped Run ends failed, which reopens the gate it closed.
        const ended={...run,state:"failed" as const,version:run.version+1,updatedAt:this.deps.clock.now(),
          resultSummary:"Stopped on request; the approved native start was never sent"};
        await tx.updateRuntimeRun(ended,run.version);
        await this.emit(tx,runId,run.sessionId,"run.status",ended.resultSummary!,null,projectId);
        return null;
      }
      const session=required(await tx.getRuntimeSession(run.sessionId),"runtime session");
      const gate=required(await tx.recovery?.lockRecoveryGate(run.sessionId)??null,"recovery gate");
      if(gate.phase!=="blocked"||gate.causeKind!=="run"||gate.causeId!==run.id||
        gate.version!==run.preTurnProof.gateVersionAtApproval||
        session.state!=="ready"||session.nativeThreadId!==run.preTurnProof.threadId||
        session.executionProfile?.activationState!=="active"||
        run.executionProfile?.revisionId!==session.executionProfile.revision.revisionId)return null;
      const next={...run,version:run.version+1,updatedAt:this.deps.clock.now(),
        preTurnProof:preTurnProofSchema.parse({...run.preTurnProof,status:"attempting"})};
      await tx.updateRuntimeRun(next,run.version);
      return next;
    });
  }

  async recordTurn(projectId: string, runId: string, turnId: string,
    status: "running" | "completed" | "failed" | "interrupted", summary: string | null = null,
    checkpoint: { cursor?: string; itemsDigest?: string; completedAtUtc?: string;
      usage?: RuntimeUsage | null; costUsd?: number | null; failureCategory?: string | null;
      /** What the settled Turn reported (Claude learns its model only from the Turn's own messages). Absent when nothing was observed. */
      observedModel?: string | null; subagentModels?: string[] } = {}): Promise<RuntimeRunRecord> {
    if (checkpoint.completedAtUtc && !canonicalUtc(checkpoint.completedAtUtc)) {
      throw new DomainError("INVALID_OBSERVATION", "native completion time must be canonical UTC");
    }
    if (checkpoint.usage && !validUsage(checkpoint.usage))
      throw new DomainError("INVALID_OBSERVATION", "native usage must be non-negative token counts");
    if (checkpoint.costUsd != null && (!Number.isFinite(checkpoint.costUsd) || checkpoint.costUsd < 0))
      throw new DomainError("INVALID_OBSERVATION", "native cost must be a non-negative amount");
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!current.nativeTurnId || current.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "turn ID does not match bound run");
      if (!["running", "unknown"].includes(current.state)) {
        if (current.state === status) return current;
        throw new DomainError("RUN_TERMINAL", "terminal run cannot be rewritten");
      }
      if (status === "running" && current.state === "running" && !checkpoint.cursor && !checkpoint.itemsDigest) return current;
      const terminal = status !== "running";
      const actual = terminal ? mergeRunActual(current.actual, { model: checkpoint.observedModel, subagentModels: checkpoint.subagentModels }) : current.actual ?? null;
      const next: RuntimeRunRecord = { ...current, state: status, version: current.version + 1,
        ...(actual ? { actual } : {}),
        resultSummary: summary ? safeDetail(summary) : current.resultSummary,
        // Provider-reported accounting of the bound Turn; never estimated or carried from another Turn.
        ...(terminal && checkpoint.usage ? { usage: { ...checkpoint.usage } } : {}),
        ...(terminal && checkpoint.costUsd != null ? { costUsd: checkpoint.costUsd } : {}),
        ...(status === "failed" && checkpoint.failureCategory ? { failureCategory: checkpoint.failureCategory } : {}),
        updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      if (terminal && checkpoint.observedModel) await tx.recordSessionActualModel?.(current.sessionId, checkpoint.observedModel, this.deps.clock.now());
      // A Run that fails on the account pauses the whole provider, exactly as a message does: the next Turn of any Session of it
      // would fail the same way and close its gate. The first one opens the hold; later ones find it already there.
      if (status === "failed" && holdsProvider(checkpoint.failureCategory)) {
        const session = await tx.getRuntimeSession(current.sessionId);
        await tx.recovery?.openProviderHold({ id: this.deps.ids.next(), provider: session?.runtimeProvider ?? "codex",
          category: checkpoint.failureCategory!, causeSessionId: current.sessionId, causeMessageId: null,
          reason: (summary ?? "quota or authentication failure").slice(0, 1000) }, this.deps.clock.now());
      }
      if (terminal && checkpoint.usage && tx.usage) {
        // Codex reports cumulative thread usage through native observations; that source already counts
        // this Run. Recording both would double the Session-day bucket. Runtimes without cumulative
        // native observations (for example Claude) fall back to the Run checkpoint.
        const session = await tx.getRuntimeSession(current.sessionId);
        const cumulativeNative = (session?.runtimeProvider ?? "codex") === "codex";
        if (!cumulativeNative) {
          const at = next.updatedAt;
          const tokens = inclusiveRuntimeUsage(checkpoint.usage);
          await tx.usage.addUsage(projectId, current.sessionId,
            this.deps.usageDay?.(at) ?? at.slice(0, 10), {
              ...tokens,
              costUsd: checkpoint.costUsd != null && checkpoint.costUsd > 0 ? checkpoint.costUsd : 0,
              costReported: checkpoint.costUsd != null,
            });
        }
      }
      const detail = `${status}${checkpoint.completedAtUtc ? `; completedAtUtc=${checkpoint.completedAtUtc}` : ""}${summary ? `: ${summary}` : ""}`;
      await this.emit(tx, runId, current.sessionId, "run.status", detail, turnId, projectId,
        checkpoint.cursor ?? null, checkpoint.itemsDigest ?? null);
      if (status !== "running") {
        await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
          effectKey: `${projectId}:runtime.run.${status}:${runId}`, kind: `runtime.run.${status}`,
          entityId: runId, version: next.version, createdAt: this.deps.clock.now() });
      }
      return next;
    });
  }

  /** Reviewer-triggered observation of the same owned native turn after an earlier terminal report. */
  async reconcileTerminalObservation(projectId: string, runId: string, turnId: string,
    status: "completed" | "failed" | "interrupted", summary: string | null,
    checkpoint: { itemsDigest: string; completedAtUtc: string }, expectedVersion: number,
    principal: Principal, reason: string): Promise<RuntimeRunRecord> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review") || !principal.actorId.trim()) {
      throw new DomainError("FORBIDDEN", "run reconciliation requires project review permission");
    }
    if (!canonicalUtc(checkpoint.completedAtUtc) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.itemsDigest) || !reason.trim()) {
      throw new DomainError("INVALID_OBSERVATION", "reconciliation needs a completed UTC native turn, item digest and reason");
    }
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "run changed", current.version);
      if (!current.nativeTurnId || current.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "turn ID does not match bound run");
      if (!["completed", "failed", "interrupted"].includes(current.state)) {
        throw new DomainError("RUN_NOT_TERMINAL", "only a terminal bound run can be reconciled");
      }
      // The durable terminal event carries the native digest and completion time.
      const terminal = status === current.state ? (await tx.listRuntimeEvents(runId)).findLast(item =>
        item.kind === "run.reconciled" ||
        item.kind === "run.status" && /^(completed|failed|interrupted)(;|$)/.test(item.detail)) : undefined;
      const statusDetail = `${status}; completedAtUtc=${checkpoint.completedAtUtc}`;
      const sameEvidence = status === current.state && terminal?.nativeTurnId === turnId &&
        terminal.itemsDigest === checkpoint.itemsDigest &&
        (terminal.kind === "run.status" ?
          terminal.detail === statusDetail || terminal.detail.startsWith(`${statusDetail}: `) :
          terminal.detail.includes(` -> ${status}; completedAtUtc=${checkpoint.completedAtUtc}; reason=`)) &&
        (!summary || safeDetail(summary) === current.resultSummary);
      if (sameEvidence) {
        await tx.appendRuntimeEvent(event(projectId, this.deps.ids.next(), runId, current.sessionId, "run.reviewed",
          safeDetail(`Reviewer confirmed unchanged native terminal ${status}; completedAtUtc=${checkpoint.completedAtUtc}; reason=${reason}`),
          turnId, principal.actorId, this.deps.clock.now(), null, checkpoint.itemsDigest));
        return current;
      }
      const task = await tx.getTask(current.taskId);
      const policy = task && await tx.getTaskProposal(task.id);
      if (task?.state === "done" && policy?.acceptanceMode &&
          (await tx.listDeliveries(task.id)).some(delivery => delivery.runId === runId))
        throw new DomainError("TASK_REOPEN_REQUIRED", "reopen the accepted Task before changing its source Run terminal observation");
      const session = required(await tx.getRuntimeSession(current.sessionId), "runtime session");
      if (!session.nativeThreadId || !session.nativeSessionId || session.state !== "ready") {
        throw new DomainError("FOREIGN_BINDING", "run has no ready owned native session");
      }
      const now = this.deps.clock.now();
      const next: RuntimeRunRecord = { ...current, state: status, version: current.version + 1,
        resultSummary: summary === null ? current.resultSummary : safeDetail(summary), updatedAt: now };
      await tx.updateRuntimeRun(next, current.version);
      await tx.appendRuntimeEvent(event(projectId, this.deps.ids.next(), runId, current.sessionId, "run.reconciled",
        safeDetail(`Reviewer re-observed native terminal ${current.state} -> ${status}; completedAtUtc=${checkpoint.completedAtUtc}; reason=${reason}; summary=${summary ?? "unchanged"}`),
        turnId, principal.actorId, now, null, checkpoint.itemsDigest));
      await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
        effectKey: `${projectId}:runtime.run.reconciled:${runId}:v${next.version}`, kind: "runtime.run.reconciled",
        entityId: runId, version: next.version, createdAt: now });
      return next;
    });
  }

  /** Only Sessions of `providers` (all when absent) and their Runs: another coordinator may drive the rest. */
  async recoverDispatching(projectId: string, providers?: readonly RuntimeProvider[]): Promise<{ sessions: string[]; runs: string[] }> {
    const sessions: string[] = [];
    const runs: string[] = [];
    // One project transaction is serialized with new dispatch reservations.
    await this.deps.uow.transaction(projectId, async tx => {
      const owned = (await tx.listRuntimeSessions()).filter(session => !providers || providers.includes(sessionProvider(session)));
      const ownedIds = new Set(owned.map(session => session.id));
      for (const current of owned) {
        if (current.state !== "creating") continue;
        const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
        await tx.updateRuntimeSession(next, current.version);
        await this.emit(tx, null, current.id, "session.unknown", "Coordinator restarted during create; no automatic retry", null, projectId);
        sessions.push(current.id);
      }
      for (const current of await tx.listRuntimeRuns()) {
        if (current.state !== "dispatching" || !ownedIds.has(current.sessionId)) continue;
        const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
        await tx.updateRuntimeRun(next, current.version);
        await this.emit(tx, current.id, current.sessionId, "run.unknown", "Coordinator restarted during turn/start; no automatic retry", current.nativeTurnId, projectId);
        runs.push(current.id);
      }
    });
    return { sessions, runs };
  }

  async recordInterruptResult(projectId: string, runId: string, outcome: "acknowledged" | "unknown", detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!run.interruptRequested || !run.nativeTurnId) throw new DomainError("NO_INTERRUPT", "no interrupt was requested");
      await this.emit(tx, runId, run.sessionId, "run.interruptResult", `${outcome}: ${detail}`, run.nativeTurnId, projectId);
    });
  }

  async recordApprovalDeclined(projectId: string, runId: string, turnId: string, detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (run.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "approval belongs to another turn");
      await this.emit(tx, runId, run.sessionId, "runtime.approvalDeclined", detail, turnId, projectId);
    });
  }

  async recordSessionApprovalDeclined(projectId: string, sessionId: string,
    nativeThreadId: string, turnId: string | null, detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const session = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (!nativeThreadId || !["creating", "ready", "unknown"].includes(session.state) ||
        (session.nativeThreadId !== null && session.nativeThreadId !== nativeThreadId)) {
        throw new DomainError("FOREIGN_BINDING", "approval does not belong to an owned thread create or binding");
      }
      await this.emit(tx, null, sessionId, "runtime.approvalDeclined", `Thread ${nativeThreadId}: ${detail}`, turnId, projectId);
    });
  }

  async recordHandoffReceipt(projectId: string, runId: string,
    stage: "received" | "read" | "adopted" | "effect", evidence: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (run.state !== "completed") throw new DomainError("RUN_NOT_COMPLETED", "handoff follows a completed native run");
      const events = await tx.listRuntimeEvents(runId);
      const order = ["received", "read", "adopted", "effect"] as const;
      const position = order.indexOf(stage);
      if (position > 0 && !events.some(item => item.kind === `handoff.${order[position - 1]}`)) {
        throw new DomainError("HANDOFF_ORDER", "previous handoff evidence is missing");
      }
      if (events.some(item => item.kind === `handoff.${stage}`)) throw new DomainError("HANDOFF_ALREADY_RECORDED", "handoff stage already recorded");
      await this.emit(tx, runId, run.sessionId, `handoff.${stage}`, evidence, run.nativeTurnId, projectId);
    });
  }
}
