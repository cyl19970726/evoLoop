import { createHash, randomUUID } from "node:crypto";
import type { BasisSet, EvaluationFixedRef, Principal, RuntimeRunRecord, RuntimeSessionRecord, TaskRevision } from "@evoloop/contracts";
import type { RuntimeBinding, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn, EvaluationPacketBinding, RuntimeWorkTrace, RuntimeReconcilePartial } from "@evoloop/contracts/runtime";
import type { BlobStore } from "@evoloop/contracts/sources";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/adapter-codex-app-server";
import type { WorkflowService } from "@evoloop/core";
import type { SessionProfileRecord } from "@evoloop/contracts/session-assignments";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeGrant } from "../configuration.js";
import type { WorkerIdentity } from "../workers/types.js";
import { fixedDocumentMaterial, fixedDocumentSummary } from "./materials.js";
import { buildLightweightInput, type CliBootstrap, type RoleContextReference } from "./lightweight-input.js";
import { PreflightError, safePreflightReport } from "./preflight-report.js";
import type { NativeInputBridge } from "./native-input.js";
import type { NativeObservationBridge } from "./native-observation.js";
import { lookupKnownTurn } from "./turn-lookup.js";
import type { ReadDocumentOriginal } from "./materials.js";
import { buildEvaluationPacket, canonicalEvaluationJson, evaluationPacketBlobId, evaluationPacketBlobPayload, evaluationPacketMediaType,
  uniqueEvaluationSources, verifyEvaluationPacket, type ReadEvaluationMaterial } from "./evaluation-materials.js";

interface TaskInputMaterial { input: string; sources: EvaluationFixedRef[]; revision: TaskRevision; basis: BasisSet }
type RuntimeFaultPhase = "project_scan" | "session_create" | "session_name_sync" | "session_close" | "profile_activation" | "run_preflight" | "business_profile_restore" | "run_start" | "run_bind" | "run_reconcile" | "approval_receipt";
type RuntimeFaultCategory = "authorization" | "native_rejected" | "verification" | "unavailable" | "unknown_outcome";
export interface RuntimeFault { projectId: string; sessionId: string | null; runId: string | null;
  phase: RuntimeFaultPhase; category: RuntimeFaultCategory; message: string; observedAtUtc: string;
  nativeMethod?: "thread/resume" | "turn/start"; nativeCode?: number;
  nativeCategory?: RuntimeServerError["category"] }
const faultMessage: Record<RuntimeFaultPhase, string> = {
  project_scan: "项目运行状态暂不可读取；新派发须等待恢复。",
  session_create: "会话创建结果尚未核实；保留原会话 ID，不自动重试。",
  session_name_sync: "原生会话名称尚未核对一致；业务名称已保存，请核对原 Thread 或等待连接恢复。",
  session_close: "会话归档尚未核实；保留原关闭意图，只读对账等待恢复。",
  profile_activation: "模型配置的原生生效尚未核实；同一会话的后续启动保持阻止。",
  run_preflight: "运行前置校验未通过；请核对原 Run 的持久状态。",
  business_profile_restore: "业务配置恢复未完成；本执行者尚未发送任务 Turn，请核对原 Run 的恢复记录。",
  run_start: "原生启动结果尚未核实；保留原 Run ID，不自动重试。",
  run_bind: "原生已返回 Turn，但运行绑定尚未保存；保留原 Run ID，只读核对原操作。",
  run_reconcile: "运行暂不可对账；保留原 Run ID 与未知状态。",
  approval_receipt: "审批拒绝回执尚未保存；请核对原会话或运行。",
};
const faultCategory = (error: unknown): RuntimeFaultCategory => error instanceof RuntimeServerError ?
  error.category === "permission_denied" ? "authorization" : "native_rejected" :
  error instanceof DomainError ? error.code === "FORBIDDEN" ? "authorization" : "verification" : "unavailable";
// Native messages can contain private paths or task material. Persist only bounded protocol facts.
const dispatchFailureDetail = (error: unknown): string => {
  const method = error instanceof RuntimeServerError || error instanceof RuntimeUnknownError ? error.method : null;
  const safeMethod = method === "thread/resume" || method === "turn/start" ? method : "unavailable";
  if (error instanceof RuntimeServerError)
    return `native_rejected; method=${safeMethod}; category=${error.category}; code=${error.code}`;
  if (error instanceof RuntimeUnknownError) return `native_outcome_unknown; method=${safeMethod}`;
  if (error instanceof RuntimeProtocolError || error instanceof DomainError) return "local_verification_failed";
  return "unclassified_failure";
};

type ManagedRuntime = RuntimePort & { open(): Promise<void>; registerBinding(binding: RuntimeBinding): Promise<void>;
  isReady(): boolean; onDisconnect(listener: (reason: string) => void): () => void;
  startConversationTurn?(binding:RuntimeBinding,input:string,operationId:string):Promise<RuntimeTurn>;
  qualifyConversationThread?(binding:RuntimeBinding):Promise<{available:boolean;reason:string;fingerprint:string|null}>;
  activateExecutionProfile?(current:RuntimeBinding,target:RuntimeSessionSpec,revisionId:string,operationId:string):Promise<RuntimeBinding>;
  inspectExecutionProfileActivation?(current:RuntimeBinding,target:RuntimeSessionSpec,revisionId:string,operationId:string):Promise<RuntimeBinding|null> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const marker = (operationId: string) => `[evoloop-run-operation:${operationId}]`;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const textOf = (value: unknown): string => {
  const item = object(value);
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) return item.content.map(part => object(part)?.text).filter((part): part is string => typeof part === "string").join("\n");
  return "";
};
export function finalMessages(items: unknown[]): string[] {
  const messages = items.filter(item=>object(item)?.type==="agentMessage");
  const terminal = messages.filter(item=>object(item)?.phase==="final_answer");
  return (terminal.length ? terminal : messages.filter(item=>object(item)?.phase!=="commentary")).map(textOf).filter(Boolean);
}
export function bindingOf(session: RuntimeSessionRecord): RuntimeBinding {
  if (!session.nativeThreadId || !session.nativeSessionId) throw new Error("Owned native binding is not available");
  return { sessionId: session.id, roleId: session.roleId, projectId: session.projectId, cwd: session.cwd,
    authorizationScope: session.authorizationScope, nativeThreadId: session.nativeThreadId,
    nativeSessionId: session.nativeSessionId, owner: "evoloop-codex-app-server",
    resumeProfile:{actorId:session.actorId,model:session.model,sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,
      ...(session.executionProfile?{executionProfileRevisionId:session.executionProfile.revision.revisionId}:{})} };
}
function specOf(session: RuntimeSessionRecord): RuntimeSessionSpec {
  return { actorId: session.actorId, sessionId: session.id, roleId: session.roleId, projectId: session.projectId,
    cwd: session.cwd, authorizationScope: session.authorizationScope, sandbox: session.sandbox,
    approvalPolicy: session.approvalPolicy, ...(session.model ? { model: session.model } : {}),
    ...(session.executionProfile?{executionProfileRevisionId:session.executionProfile.revision.revisionId}:{}) };
}
async function collect<T>(load: (cursor?: string) => Promise<RuntimePage<T>>, maxPages: number): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page = await load(cursor); items.push(...page.data);
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error("Runtime history cursor repeated");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error("Runtime history exceeds the bounded recovery window");
}

/** The durable reservation is authoritative; this runner never repeats an uncertain external start. */
export class RuntimeRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private registered = new Set<string>();
  private checkedNames = new Map<string, number>();
  private interruptAttempted = new Set<string>();
  private approvalQueue: { id: string | number; projectId?: string; sessionId?: string; threadId?: string; turnId?: string; method: string }[] = [];
  private approvalFlush: Promise<void> | null = null;
  private serviceError: string | null = null;
  private faults = new Map<string, RuntimeFault>();
  private available = false;
  private runtime: ManagedRuntime;
  private recovering: Promise<void> | null = null;
  private unsubscribeDisconnect: (() => void) | null = null;
  private unsubscribeApproval: (() => void) | null = null;

  constructor(private readonly deps: {
    readExternalMaterials?(principal:Principal,projectId:string,taskId:string,taskRevisionId:string):Promise<string>;
    runtimeFactory(): ManagedRuntime; workflow: WorkflowService; trusted: RuntimeWorkflowService;
    nativeInputs?: NativeInputBridge;
    nativeObservation?: NativeObservationBridge;
    principals: Principal[]; canWrite(): boolean; allowedCwd(projectId: string, cwd: string): Promise<boolean>;
    hasGrant(scope: RuntimeGrant, session?: RuntimeSessionRecord): boolean | Promise<boolean>;
    /** Exact persisted dynamic Session/Run ownership for read-only reconciliation and one-shot settlement. */
    canSettleOwned?(session: RuntimeSessionRecord, run?: RuntimeRunRecord): Promise<boolean>;
    ownedCwd?(projectId: string, cwd: string): Promise<boolean>;
    /** Trusted database check of the reader Run's frozen, reviewed Run-reference snapshot. */
    workerTraceAuthority?(identity: WorkerIdentity, targetRunId: string): Promise<boolean>;
    /** Optional admission checks for managed loops. A false answer waits without changing durable state. */
    mayCreateSession?(session: RuntimeSessionRecord): Promise<boolean>;
    mayDispatchRun?(run: RuntimeRunRecord): Promise<boolean>;
    /** Trusted, exact Session/actor/Task CLI entry; never inferred from Task or Run prose. */
    cliEntryForRun?(session: RuntimeSessionRecord | null, run: RuntimeRunRecord): Promise<CliBootstrap | null>;
    roleContextForRun?(session: RuntimeSessionRecord, run: RuntimeRunRecord): Promise<RoleContextReference | null>;
    readDocumentOriginal?: ReadDocumentOriginal;
    profileForSession?(principal: Principal, session: RuntimeSessionRecord): Promise<SessionProfileRecord | null>;
    readEvaluationMaterial?: ReadEvaluationMaterial;
    blobsForPrincipal?: (principal: Principal) => BlobStore | Promise<BlobStore>;
  }) { this.runtime = deps.runtimeFactory(); }
  nativeAdapter():ManagedRuntime { return this.runtime; }
  nativeStartsAvailable():boolean { return this.available && !this.recovering && !this.stopped && this.deps.canWrite(); }
  status(projectId?: string) {
    const faults = projectId ? [...this.faults.values()].filter(fault => fault.projectId === projectId) : [];
    return { available: this.available && this.runtime.isReady(),
      error: this.serviceError ?? faults.at(-1)?.message ?? null, faults };
  }
  private faultKey(projectId: string, phase: RuntimeFaultPhase, sessionId?: string, runId?: string) {
    return `${projectId}:${runId ? `run:${runId}` : sessionId ? `session:${sessionId}` : "project"}:${phase}`;
  }
  private recordFault(projectId: string, phase: RuntimeFaultPhase, error: unknown,
    sessionId?: string, runId?: string, category = faultCategory(error)) {
    const fault: RuntimeFault = {projectId,sessionId:sessionId??null,runId:runId??null,
      phase,category,message:faultMessage[phase],observedAtUtc:new Date().toISOString()};
    if ((error instanceof RuntimeServerError || error instanceof RuntimeUnknownError) &&
      (error.method === "thread/resume" || error.method === "turn/start")) fault.nativeMethod = error.method;
    if (error instanceof RuntimeServerError) {
      fault.nativeCode = error.code;
      fault.nativeCategory = error.category;
    }
    const key=this.faultKey(projectId,phase,sessionId,runId);
    this.faults.delete(key);this.faults.set(key,fault);
  }
  private clearFault(projectId: string, sessionId?: string, runId?: string, phase?: RuntimeFaultPhase,
    preservePhase?: RuntimeFaultPhase) {
    for (const [key,fault] of this.faults) {
      if (fault.projectId === projectId && fault.sessionId === (sessionId ?? null) && fault.runId === (runId ?? null) &&
          (phase ? fault.phase === phase : fault.phase !== "approval_receipt" && fault.phase !== preservePhase)) this.faults.delete(key);
    }
  }
  private principal(projectId: string): Principal {
    const principal = this.deps.principals.find(p => p.projectIds.includes(projectId) && p.permissions.includes("read") && p.permissions.includes("write"));
    if (!principal) throw new Error("Project authority is unavailable");
    return principal;
  }
  private async authorized(session: RuntimeSessionRecord, actorId = session.actorId): Promise<boolean> {
    return this.deps.principals.some(p => p.actorId === actorId && p.projectIds.includes(session.projectId) &&
      p.permissions.includes("read") && p.permissions.includes("write") && p.permissions.includes("review")) &&
      await this.deps.hasGrant({ projectId: session.projectId, actorId, roleId: session.roleId,
        authorizationScope: session.authorizationScope, cwd: session.cwd, sandbox: session.sandbox,
        model: session.model, approvalPolicy: session.approvalPolicy }, session);
  }
  private async owned(session: RuntimeSessionRecord, run?: RuntimeRunRecord): Promise<boolean> {
    return !!this.deps.canSettleOwned && !!await this.deps.canSettleOwned(session, run) &&
      !!await this.deps.ownedCwd?.(session.projectId, session.cwd);
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error("Runner has stopped");
    this.attachRuntime();
    await this.runtime.open();
    await this.deps.nativeInputs?.opened();
    await this.deps.nativeObservation?.opened();
    for (const projectId of this.projects()) await this.deps.trusted.recoverDispatching(projectId);
    this.available = true;
    await this.pump();
    this.ensureTimer();
  }
  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pump(); }, 2000);
    this.timer.unref();
  }
  private attachRuntime(): void {
    this.deps.nativeInputs?.attach(this.runtime);
    this.deps.nativeObservation?.attach(this.runtime);
    this.unsubscribeDisconnect = this.runtime.onDisconnect(_reason => {
      if (this.stopped) return;
      this.available = false;
      this.serviceError = "Codex 执行连接已断开；需要显式恢复。";
    });
    this.unsubscribeApproval = this.runtime.onApprovalRequest(async request => {
      const approval = { id: request.id, method: request.method,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.threadId ? { threadId: request.threadId } : {}),
        ...(request.turnId ? { turnId: request.turnId } : {}) };
      this.approvalQueue.push(approval);
      try {
        await this.flushApprovals(approval);
        if (this.approvalQueue.includes(approval)) throw new Error("Owned approval could not be correlated");
      }
      catch (error) {
        if (approval.projectId) this.recordFault(approval.projectId,"approval_receipt",error,approval.sessionId);
        this.available = false;
        this.serviceError = "审批拒绝回执未能保存；需要显式恢复。";
        throw new Error("Approval evidence unavailable");
      }
    });
  }
  async recover(): Promise<void> {
    if (this.stopped || !this.deps.canWrite()) throw new Error("Coordinator cannot recover runtime now");
    if (this.available && this.runtime.isReady()) return;
    if (this.recovering) return this.recovering;
    this.recovering = this.reopen().finally(() => { this.recovering = null; });
    return this.recovering;
  }
  private async reopen(): Promise<void> {
    this.available = false;
    if (this.busy) await this.busy;
    this.unsubscribeDisconnect?.(); this.unsubscribeApproval?.();
    try {
      // A replacement must wait for proof that the previous owned child exited.
      await this.runtime.close();
      await this.deps.nativeInputs?.drain();
      await this.deps.nativeObservation?.drain();
      this.runtime = this.deps.runtimeFactory();
      this.registered.clear(); this.checkedNames.clear(); this.interruptAttempted.clear();
      this.attachRuntime();
      await this.runtime.open();
      await this.deps.nativeInputs?.opened();
      await this.deps.nativeObservation?.opened();
      for (const projectId of this.projects()) await this.deps.trusted.recoverDispatching(projectId);
      this.serviceError = null;
      this.available = true;
      await this.pump();
      this.ensureTimer();
    } catch (error) {
      this.available = false;
      this.serviceError = "执行连接恢复失败；需要检查原运行状态。";
      throw error;
    }
  }
  private projects(): string[] { return [...new Set(this.deps.principals.flatMap(p => p.projectIds))]; }
  async pump(): Promise<void> {
    if (this.stopped || !this.available || !this.deps.canWrite()) return;
    if (this.busy) return this.busy;
    this.busy = this.cycle().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async cycle(): Promise<void> {
    for (const projectId of this.projects()) {
      if (!this.deps.canWrite() || this.stopped) return;
      try {
        const principal = this.principal(projectId);
        // Uncreated authorized project scopes are normal, and have no runtime work.
        try { await this.deps.workflow.getProject(principal, projectId); }
        catch (error) {
          if (error instanceof DomainError && error.code === "NOT_FOUND") continue;
          this.recordFault(projectId,"project_scan",error);
          continue;
        }
        const sessions = await this.deps.workflow.listRuntimeSessions(principal, projectId);
        const runs = await this.deps.workflow.listRuntimeRuns(principal, projectId);
        for (const session of sessions) {
          if (session.state === "ready") this.clearFault(projectId, session.id, undefined, undefined, "session_name_sync");
          if (session.state === "closed") this.clearFault(projectId, session.id);
          if (session.state === "reserved") {
            try { await this.create(session); }
            catch (error) { this.recordFault(projectId,"session_create",error,session.id); }
          }
          if (session.state === "ready" && session.executionProfile &&
              ["pending","attempting","unknown"].includes(session.executionProfile.activationState) &&
              !runs.some(run=>run.sessionId===session.id&&["requested","dispatching","running","unknown"].includes(run.state))) {
            try {
              if(await this.authorized(session) && await this.deps.allowedCwd(session.projectId,session.cwd))
                await this.executionBinding(session);
            } catch(error) { this.recordFault(projectId,"profile_activation",error,session.id); }
          }
          if (session.state === "ready" && this.deps.profileForSession) {
            try { await this.syncSessionName(principal, session); }
            catch (error) { this.recordFault(projectId,"session_name_sync",error,session.id); }
          }
          if (session.state === "closing") {
            try { if (await this.closeSession(session)) this.clearFault(projectId,session.id); }
            catch (error) { this.recordFault(projectId,"session_close",error,session.id); }
          }
        }
        for (const run of runs) {
          if (["completed","failed","interrupted"].includes(run.state)) { this.clearFault(projectId,run.sessionId,run.id);continue; }
          try { if (await this.process(principal, run)) this.clearFault(projectId,run.sessionId,run.id); }
          catch (error) { this.recordFault(projectId,"run_reconcile",error,run.sessionId,run.id); }
        }
        await this.flushApprovals();
        await this.deps.nativeInputs?.pump(projectId, sessions);
        await this.deps.nativeObservation?.pump(projectId, sessions);
        this.clearFault(projectId);
      } catch (error) { this.recordFault(projectId,"project_scan",error); }
    }
  }
  private async closeSession(session: RuntimeSessionRecord): Promise<boolean> {
    if (!session.closeOperationId || !(await this.authorized(session) && await this.deps.allowedCwd(session.projectId, session.cwd) || await this.owned(session)))
      throw new Error("Session close authority or intent is unavailable");
    if (!this.runtime.isThreadArchived) throw new Error("Native archive verification unsupported");
    const binding = bindingOf(session);
    await this.runtime.registerBinding(binding);
    // Readback comes before any write, including after a restart or lost acknowledgement.
    const retainUnverifiedAttempt = () => {
      const prior = this.faults.get(this.faultKey(session.projectId,"session_close",session.id));
      if (prior?.category !== "native_rejected" && prior?.category !== "authorization")
        this.recordFault(session.projectId,"session_close",null,session.id,undefined,"unknown_outcome");
    };
    let archivedBefore: boolean;
    try { archivedBefore = await this.runtime.isThreadArchived(binding); }
    catch (error) {
      // Before an attempt, a failed precheck must stop archive; after one, its outcome stays unknown.
      if (!session.closeAttemptedAt) throw error;
      retainUnverifiedAttempt();
      return false;
    }
    if (archivedBefore) {
      await this.deps.trusted.confirmSessionClosed(session.projectId, binding, session.closeOperationId);
      return true;
    }
    if (session.closeAttemptedAt) {
      retainUnverifiedAttempt();
      return false;
    }
    if (!this.runtime.archiveThread) throw new Error("Native archive unsupported");
    // Native source is a UI classification, not proof of who created the thread.
    // inspect validates the exact persisted thread/session/cwd binding before archive.
    await this.runtime.inspect(binding);
    await this.deps.trusted.markSessionArchiveAttempt(session.projectId, session.id, session.closeOperationId);
    let archiveCategory: RuntimeFaultCategory = "unknown_outcome";
    try { await this.runtime.archiveThread(binding); }
    catch (error) {
      // Only an explicit native rejection is classifiable; lost replies remain unknown.
      if (error instanceof RuntimeServerError) archiveCategory = faultCategory(error);
    }
    let archivedAfter: boolean;
    try { archivedAfter = await this.runtime.isThreadArchived(binding); }
    catch {
      // The archive may have happened even when verification itself fails.
      this.recordFault(session.projectId,"session_close",null,session.id,undefined,archiveCategory);
      return false;
    }
    if (archivedAfter) {
      await this.deps.trusted.confirmSessionClosed(session.projectId, binding, session.closeOperationId);
      return true;
    }
    this.recordFault(session.projectId,"session_close",null,session.id,undefined,archiveCategory);
    return false;
  }
  private async create(session: RuntimeSessionRecord): Promise<void> {
    if (!await this.authorized(session) || !await this.deps.allowedCwd(session.projectId, session.cwd)) return;
    if (this.deps.mayCreateSession && !await this.deps.mayCreateSession(session)) return;
    await this.deps.trusted.beginSessionCreate(session.projectId, session.id);
    try {
      const binding = await this.runtime.create(specOf(session));
      await this.deps.trusted.bindSession(session.projectId, session.id, binding);
      this.registered.add(session.id);
      this.clearFault(session.projectId,session.id);
    } catch (error) {
      await this.deps.trusted.markSessionUnknown(session.projectId, session.id, "Thread creation acknowledgement unavailable; no automatic retry");
      this.recordFault(session.projectId,"session_create",error,session.id,undefined,"unknown_outcome");
    }
  }
  private async syncSessionName(principal: Principal, session: RuntimeSessionRecord): Promise<void> {
    const profile = await this.deps.profileForSession!(principal, session);
    if (!profile || profile.projectId !== session.projectId || profile.target.kind !== "owned" ||
        profile.target.sessionId !== session.id) return;
    if (this.checkedNames.get(session.id) === profile.version) return;
    if (!await this.authorized(session) || !await this.deps.allowedCwd(session.projectId, session.cwd)) return;
    if (!this.runtime.readThreadName || !this.runtime.setThreadName) throw new Error("Native Thread naming unavailable");
    const binding = bindingOf(session);
    await this.runtime.registerBinding(binding);
    const currentName = await this.runtime.readThreadName(binding);
    if (currentName === profile.displayName) {
      this.checkedNames.set(session.id, profile.version);
      this.clearFault(session.projectId, session.id, undefined, "session_name_sync");
      return;
    }
    // A profile change during native I/O wins; the next cycle reads its new version.
    const latest = await this.deps.profileForSession!(principal, session);
    if (!latest || latest.version !== profile.version || latest.displayName !== profile.displayName) return;
    // One native attempt per profile revision. A lost reply is read back, never replayed
    // in this connection; reconnect or a newer business name makes a fresh comparison.
    this.checkedNames.set(session.id, profile.version);
    let failure: unknown = null;
    try { await this.runtime.setThreadName(binding, profile.displayName); }
    catch (error) { failure = error; }
    try {
      if (await this.runtime.readThreadName(binding) === profile.displayName) {
        this.clearFault(session.projectId, session.id, undefined, "session_name_sync");
        return;
      }
    } catch (error) { failure ??= error; }
    throw failure ?? new Error("Native Thread name does not match the saved profile");
  }
  private async resumeForRun(session: RuntimeSessionRecord): Promise<RuntimeBinding> {
    if (!await this.authorized(session) || !await this.deps.allowedCwd(session.projectId, session.cwd)) throw new Error("Session authority is no longer available");
    const binding = bindingOf(session);
    if (!this.registered.has(session.id)) {
      await this.runtime.registerBinding(binding);
      await this.runtime.resume(binding, specOf(session));
      this.registered.add(session.id);
    }
    return binding;
  }
  /** An adopted revision is its own durable activation intent. A lost reply is read back, never resent. */
  private async executionBinding(session:RuntimeSessionRecord,run?:RuntimeRunRecord):Promise<RuntimeBinding|null>{
    const profile=session.executionProfile;
    if(!profile)return this.readBinding(session);
    if(run && (!run.executionProfile||run.executionProfile.revisionId!==profile.revision.revisionId||
      run.executionProfile.model!==profile.revision.model||run.executionProfile.sandbox!==session.sandbox||
      run.executionProfile.approvalPolicy!==session.approvalPolicy||run.executionProfile.cwd!==session.cwd||
      run.executionProfile.authorizationScope!==session.authorizationScope))
      throw new DomainError("EXECUTION_PROFILE_MISMATCH","Run's fixed launch profile differs from its Session revision");
    if(profile.activationState==='active')return this.readBinding(session);
    if(profile.activationState==='rejected'){
      // The native operation was explicitly rejected before any Turn was sent. Keep the
      // immutable Run as a terminal failed attempt so a later revision requires a new Run.
      if(run)await this.deps.trusted.rejectDispatch(run.projectId,run.id,
        'Native Thread rejected this execution profile before Turn start');
      return null;
    }
    if(!this.runtime.activateExecutionProfile||!this.runtime.inspectExecutionProfileActivation)
      throw new DomainError("CAPABILITY_UNAVAILABLE","native execution profile activation is unavailable");
    const previousId=profile.activeRevisionId;
    if(!previousId)throw new DomainError("EXECUTION_PROFILE_MISSING","last confirmed execution profile revision is unavailable");
    const previous=await this.deps.trusted.getExecutionProfileRevision(session.projectId,session.id,previousId);
    if(previous.projectId!==session.projectId||previous.sessionId!==session.id||
      previous.cwd!==session.cwd||previous.authorizationScope!==session.authorizationScope)
      throw new DomainError("EXECUTION_PROFILE_MISMATCH","previous execution profile changed immutable Session identity");
    const prior=bindingOf(session);
    prior.resumeProfile={...prior.resumeProfile!,model:previous.model,sandbox:previous.sandbox,
      approvalPolicy:previous.approvalPolicy,executionProfileRevisionId:previous.revisionId};
    const target=specOf(session),revisionId=profile.revision.revisionId,operationId=profile.revision.operationId;
    if(profile.activationState==='pending'){
      const permit=await this.deps.trusted.beginExecutionProfileActivation(session.projectId,session.id,revisionId,operationId);
      if(permit){
        try{
          const revised=await this.runtime.activateExecutionProfile(prior,target,revisionId,operationId);
          await this.deps.trusted.settleExecutionProfileActivation(session.projectId,session.id,revisionId,
            'active','Exact original Thread and complete execution profile confirmed by thread/resume');
          this.registered.add(session.id);
          return revised;
        }catch(error){
          const state=error instanceof RuntimeServerError&&error.method==='thread/resume'?'rejected':'unknown';
          await this.deps.trusted.settleExecutionProfileActivation(session.projectId,session.id,revisionId,state,
            state==='rejected'?'Native thread/resume explicitly rejected the chosen profile':
              'Native profile activation outcome is uncertain; original Thread requires readback');
          this.recordFault(session.projectId,'profile_activation',error,session.id,run?.id,
            state==='unknown'?'unknown_outcome':faultCategory(error));
          if(state==='rejected'&&run)await this.deps.trusted.rejectDispatch(run.projectId,run.id,
            'Native Thread rejected this execution profile before Turn start');
          return null;
        }
      }
    }
    try{
      const revised=await this.runtime.inspectExecutionProfileActivation(prior,target,revisionId,operationId);
      if(!revised)return null;
      await this.deps.trusted.settleExecutionProfileActivation(session.projectId,session.id,revisionId,
        'active','Exact original Thread and full configured execution profile independently confirmed');
      this.registered.add(session.id);
      return revised;
    }catch(error){
      this.recordFault(session.projectId,'profile_activation',error,session.id,run?.id,'verification');
      return null;
    }
  }
  /** Register provenance and inspect metadata for reads without opening another native writer. */
  private async readBinding(session: RuntimeSessionRecord): Promise<RuntimeBinding> {
    if (!(await this.authorized(session) && await this.deps.allowedCwd(session.projectId, session.cwd) || await this.owned(session)))
      throw new DomainError("FORBIDDEN", "当前会话授权或工作目录已失效，无法读取原生历史。");
    const binding = bindingOf(session);
    await this.runtime.registerBinding(binding);
    await this.runtime.inspect(binding);
    return binding;
  }
  private readFailure(error: unknown): DomainError {
    if (error instanceof DomainError) return error;
    const detail = error instanceof RuntimeServerError ? `原生读取 ${error.method} 被拒绝（${error.category}，代码 ${error.code}）` :
      "原生读取或归属校验失败";
    return new DomainError("RUNTIME_READ_UNAVAILABLE", `${detail}。已保存的运行状态仍可读；请检查执行连接后重试读取，不要重发运行。`);
  }
  async history(principal: Principal, projectId: string, sessionId: string) {
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, sessionId);
    try {
      const binding = await this.readBinding(session);
      const turns: RuntimeTurn[] = [];
      let turnCursor: string | undefined, nextTurnCursor: string | null = null;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
        const page = await this.runtime.listTurns(binding, turnCursor);
        turns.push(...page.data);
        nextTurnCursor = page.nextCursor;
        if (turns.length >= 20 || !nextTurnCursor) break;
        if (seen.has(nextTurnCursor)) throw new Error("Runtime turn cursor repeated");
        seen.add(nextTurnCursor); turnCursor = nextTurnCursor;
      }
      const result = [];
      for (const turn of turns.slice(0,20)) {
        const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
        result.push({ id: turn.id, status: turn.status, messages: items.filter(item => ["userMessage", "agentMessage"].includes(String(object(item)?.type))).map(item => ({type:String(object(item)?.type),text:textOf(item)})) });
      }
      return { turns: result, truncated: !!nextTurnCursor || turns.length > 20, observedAt: new Date().toISOString() };
    } catch (error) {
      throw this.readFailure(error);
    }
  }
  private async input(principal: Principal, run: RuntimeRunRecord): Promise<TaskInputMaterial> {
    const fixed = await this.deps.workflow.getTaskRevision(principal, run.projectId, run.taskId, run.taskRevisionId);
    const current = await this.deps.workflow.getTask(principal, run.projectId, run.taskId);
    if (!fixed.basis || fixed.basis.id !== run.basisSetId || current.impacts.some(i => i.state === "pending")) throw new Error("Fixed basis needs review");
    await this.deps.workflow.validateTaskRevisionBasis(principal, run.projectId, run.taskId,
      run.taskRevisionId, run.basisSetId);
    const materials: string[] = [];
    const sources: EvaluationFixedRef[] = [];
    const primary = await this.deps.workflow.getDocumentPayloadRevision(principal, run.projectId,
      fixed.revision.contentDocumentId, fixed.revision.contentRevisionId);
    if (primary.projectId !== run.projectId || primary.documentId !== fixed.revision.contentDocumentId ||
      primary.id !== fixed.revision.contentRevisionId || primary.format !== "markdown" || primary.body !== fixed.revision.content)
      throw new Error("Fixed Task content differs from its pinned primary Document revision");
    materials.push(await fixedDocumentMaterial(principal, primary, this.deps.readDocumentOriginal));
    sources.push({ kind: "document", id: primary.documentId, revision: primary.id, contentHash: primary.contentHash });
    for (const member of fixed.basis.members) {
      if (member.documentId === fixed.revision.contentDocumentId && member.revisionId === fixed.revision.contentRevisionId) continue;
      const revision = await this.deps.workflow.getDocumentPayloadRevision(principal, run.projectId, member.documentId, member.revisionId);
      if (revision.projectId !== run.projectId || revision.documentId !== member.documentId || revision.id !== member.revisionId)
        throw new Error("Fixed document revision scope differs from the accepted basis");
      materials.push(await fixedDocumentMaterial(principal, revision, this.deps.readDocumentOriginal));
      sources.push({ kind: "document", id: revision.documentId, revision: revision.id, contentHash: revision.contentHash });
    }
    if (this.deps.readExternalMaterials) {
      const external = await this.deps.readExternalMaterials(principal, run.projectId, run.taskId, run.taskRevisionId);
      if (external) materials.push(external);
    }
    const input = `${marker(run.operationId)}\nProject task: ${fixed.revision.title}\nContent: ${fixed.revision.content}\nAcceptance: ${fixed.revision.acceptance}\nTask revision: ${fixed.revision.id}\nBasis set: ${fixed.basis.id}\n\n${materials.join("\n\n---\n\n")}\n\nAuthorized task input:\n${run.input}\n\nReport actual files, checks and limits. Native turn completion is not task acceptance or consumer use.`;
    if (Buffer.byteLength(input, "utf8") > 256 * 1024) throw new Error("Complete required context exceeds the first-version input limit");
    return { input, sources: uniqueEvaluationSources(sources), revision: fixed.revision, basis: fixed.basis };
  }

  private async lightweightInput(principal: Principal, run: RuntimeRunRecord, session: RuntimeSessionRecord | null = null) {
    const fixed = await this.deps.workflow.getTaskRevision(principal, run.projectId, run.taskId, run.taskRevisionId);
    const current = await this.deps.workflow.getTask(principal, run.projectId, run.taskId);
    if (!fixed.basis || fixed.basis.id !== run.basisSetId || current.impacts.some(i => i.state === "pending"))
      throw new PreflightError("FIXED_SOURCE_INVALID", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId });
    await this.deps.workflow.validateTaskRevisionBasis(principal, run.projectId, run.taskId,
      run.taskRevisionId, run.basisSetId);
    const refs = [{ documentId: fixed.revision.contentDocumentId, revisionId: fixed.revision.contentRevisionId },
      ...fixed.basis.members.filter(member => member.documentId !== fixed.revision.contentDocumentId ||
        member.revisionId !== fixed.revision.contentRevisionId)];
    const documents = [];
    for (const ref of refs) {
      const source = { kind: "document" as const, id: ref.documentId, revisionId: ref.revisionId };
      let revision;
      try { revision = await this.deps.workflow.getDocumentPayloadRevision(principal, run.projectId, ref.documentId, ref.revisionId); }
      catch (error) {
        if (error instanceof DomainError && error.code === "FORBIDDEN") throw error;
        throw new PreflightError("FIXED_SOURCE_UNAVAILABLE", source);
      }
      if (revision.projectId !== run.projectId || revision.documentId !== ref.documentId || revision.id !== ref.revisionId ||
          (ref.documentId === fixed.revision.contentDocumentId && ref.revisionId === fixed.revision.contentRevisionId &&
            (revision.format !== "markdown" || revision.body !== fixed.revision.content)))
        throw new PreflightError("FIXED_SOURCE_INVALID", source);
      try { documents.push(fixedDocumentSummary(revision)); }
      catch { throw new PreflightError("FIXED_SOURCE_INVALID", source); }
    }
    const cliEntry = await this.deps.cliEntryForRun?.(session, run) ?? null;
    const roleContext = session && cliEntry ? await this.deps.roleContextForRun?.(session,run) ?? null : null;
    return buildLightweightInput(run, fixed.revision, fixed.basis, documents, cliEntry, roleContext);
  }

  private async evaluationSources(principal: Principal, session: RuntimeSessionRecord, run: RuntimeRunRecord,
    taskInput: TaskInputMaterial): Promise<{ evaluation: Awaited<ReturnType<WorkflowService["getEvaluation"]>>; sources: EvaluationFixedRef[] }> {
    const binding = run.evaluationBinding;
    if (!binding) throw new Error("Evaluation binding is missing");
    const evaluation = await this.deps.workflow.getEvaluation(principal, run.projectId, binding.evaluationId, binding.revisionId);
    const definition = evaluation.definition;
    const condition = definition.conditions.find(item => item.id === binding.conditionId);
    if (evaluation.projectId !== run.projectId || evaluation.id !== binding.revisionId ||
        definition.case.id !== binding.caseId || definition.case.taskId !== run.taskId ||
        definition.case.sourceTaskRevisionId !== binding.sourceTaskRevisionId ||
        run.taskRevisionId !== binding.actualTaskRevisionId || run.input !== definition.case.commonInput || !condition)
      throw new Error("Evaluation binding no longer matches its frozen case, condition or Run input");
    if (!session.model || session.model !== condition.model || session.cwd !== condition.environment.cwd ||
        session.authorizationScope !== condition.environment.authorizationScope || session.sandbox !== condition.environment.sandbox ||
        session.approvalPolicy !== condition.environment.approvalPolicy)
      throw new Error("Owned session no longer matches the frozen evaluation condition");

    const signature = definition.case.sourceSignature;
    const revision = taskInput.revision;
    if (revision.projectId !== run.projectId || revision.taskId !== run.taskId || revision.id !== run.taskRevisionId ||
        revision.title !== signature.title || revision.contentDocumentId !== signature.contentDocumentId ||
        revision.contentRevisionId !== signature.contentRevisionId || revision.acceptance !== signature.acceptance ||
        revision.owner !== signature.owner || (revision.kind ?? "unclassified") !== signature.kind)
      throw new Error("Actual Task revision differs from the frozen evaluation business signature");
    const primary = taskInput.sources.find(source => source.kind === "document" &&
      source.id === signature.contentDocumentId && source.revision === signature.contentRevisionId);
    if (!primary) throw new Error("Frozen Task primary content is missing from the verified Task input");
    const signatureDocuments = uniqueEvaluationSources([
      primary,
      ...signature.basis.map(source => ({ kind: "document" as const, id: source.documentId,
        revision: source.revisionId, contentHash: source.contentHash })),
    ]);
    const actualDocuments = taskInput.sources.filter(source => source.kind === "document");
    if (canonicalEvaluationJson(signatureDocuments) !== canonicalEvaluationJson(actualDocuments))
      throw new Error("Actual Task basis differs from the frozen evaluation source signature");
    if (signature.external.length && !this.deps.readExternalMaterials)
      throw new Error("Frozen Task external references cannot be loaded; evaluation input is incomplete");
    if (signature.external.some(source => source.kind === "run"))
      throw new Error("Evaluation packet cannot treat a Run input hash as a transcript original");

    const staticMaterials = [definition.protocol, ...definition.case.materials];
    if (staticMaterials.some(source => source.kind !== "document" && source.kind !== "git"))
      throw new Error("Evaluation protocol and common materials must be fixed Document or Git sources");
    if (condition.wikiRefs !== null && condition.wikiRefs?.some(source => source.kind !== "wiki"))
      throw new Error("Evaluation Wiki condition contains a non-Wiki source");
    const external = signature.external.filter((source): source is typeof source & { kind: "git" | "wiki" } => source.kind !== "run").map(source => ({ kind: source.kind, id: source.referenceId,
      revision: source.revision, contentHash: source.contentHash }));
    return { evaluation, sources: uniqueEvaluationSources([...taskInput.sources, ...external, ...staticMaterials, ...(condition.wikiRefs ?? [])]) };
  }

  private async loadEvaluationPacket(principal: Principal, run: RuntimeRunRecord, expectedTaskInput: string) {
    const packet = run.evaluationPacket;
    if (!packet || !this.deps.readEvaluationMaterial || !this.deps.blobsForPrincipal)
      throw new Error("Verified evaluation packet storage or fixed-source reader is unavailable");
    const payload = evaluationPacketBlobPayload(packet.payloadRef, run.projectId, packet.contentHash);
    const stored = await (await this.deps.blobsForPrincipal(principal)).read(payload);
    if (stored.status !== "available" || stored.payload.id !== payload.id || stored.payload.projectId !== run.projectId ||
        stored.payload.contentHash !== packet.contentHash || stored.payload.size !== payload.size || stored.payload.mediaType !== payload.mediaType)
      throw new Error("Stored evaluation packet Blob is unavailable or mismatched");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stored.bytes); }
    catch { throw new Error("Stored evaluation packet is not valid UTF-8"); }
    const verified = await verifyEvaluationPacket(principal, run, content, this.deps.readEvaluationMaterial, expectedTaskInput);
    if (verified.manifestHash !== packet.manifestHash || verified.builderVersion !== packet.builderVersion ||
        canonicalEvaluationJson(verified.sources) !== canonicalEvaluationJson(uniqueEvaluationSources(packet.sources)))
      throw new Error("Stored evaluation packet does not match its attached Run manifest");
    return { content, contentHash: packet.contentHash, manifestHash: verified.manifestHash,
      builderVersion: verified.builderVersion, sources: verified.sources };
  }

  private async prepareEvaluationInput(principal: Principal, session: RuntimeSessionRecord, run: RuntimeRunRecord): Promise<{ run: RuntimeRunRecord; input: string }> {
    if (!this.deps.readEvaluationMaterial || !this.deps.blobsForPrincipal)
      throw new Error("Evaluation packet storage or fixed-source reader is unavailable");
    const taskInput = await this.input(principal, run);
    const { sources } = await this.evaluationSources(principal, session, run, taskInput);
    let attached = run;
    if (!attached.evaluationPacket) {
      const built = await buildEvaluationPacket(principal, run, taskInput.input, sources, this.deps.readEvaluationMaterial);
      const bytes = Buffer.from(built.content, "utf8");
      const payload = { id: evaluationPacketBlobId(bytes.length, randomUUID()), projectId: run.projectId,
        contentHash: built.contentHash, size: bytes.length, mediaType: evaluationPacketMediaType };
      const blobs = await this.deps.blobsForPrincipal(principal);
      const prepared = await blobs.prepare(payload, bytes);
      if (!(await blobs.verify(prepared))) throw new Error("Evaluation packet Blob preparation failed verification");
      await blobs.publish(prepared);
      const binding: EvaluationPacketBinding = { payloadRef: payload.id, contentHash: built.contentHash,
        manifestHash: built.manifestHash, builderVersion: built.builderVersion, sources: built.sources };
      attached = await this.deps.trusted.attachEvaluationPacket(run.projectId, run.id, run.version, binding);
      if (attached.version !== run.version + 1 || !attached.evaluationPacket ||
          attached.evaluationPacket.payloadRef !== payload.id || attached.evaluationPacket.contentHash !== built.contentHash)
        throw new Error("Evaluation packet attachment acknowledgement does not match the persisted Run");
    }
    if (canonicalEvaluationJson(uniqueEvaluationSources(attached.evaluationPacket?.sources ?? [])) !== canonicalEvaluationJson(sources))
      throw new Error("Attached evaluation packet references differ from the required fixed source set");
    // Read the attached Blob back and recheck all source permissions/hashes before native dispatch.
    const packet = await this.loadEvaluationPacket(principal, attached, taskInput.input);
    return { run: attached, input: packet.content };
  }

  async readEvaluationPacket(principal: Principal, projectId: string, runId: string) {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new Error("Project read authority is unavailable for evaluation packet");
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (run.projectId !== projectId || !run.evaluationBinding || !run.evaluationPacket)
      throw new Error("Run has no attached evaluation packet");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    if (!(await this.authorized(session, run.actorId) && await this.deps.allowedCwd(projectId, session.cwd) || await this.owned(session, run)))
      throw new Error("Runtime session authority is no longer available");
    const taskInput = await this.input(principal, run);
    const { sources } = await this.evaluationSources(principal, session, run, taskInput);
    if (canonicalEvaluationJson(sources) !== canonicalEvaluationJson(uniqueEvaluationSources(run.evaluationPacket.sources)))
      throw new Error("Packet manifest no longer matches the frozen Task and Evaluation sources");
    return this.loadEvaluationPacket(principal, run, taskInput.input);
  }

  private async process(principal: Principal, original: RuntimeRunRecord): Promise<boolean> {
    if (!["requested", "running", "unknown"].includes(original.state)) return false;
    if (original.state === "requested" && !original.nativeTurnId && this.deps.mayDispatchRun &&
      !await this.deps.mayDispatchRun(original)) return false;
    const session = await this.deps.workflow.getRuntimeSession(principal, original.projectId, original.sessionId);
    if (session.state !== "ready") return false;
    const currentAuthority = await this.authorized(session, original.actorId);
    if (!currentAuthority && !await this.owned(session, original)) {
      if (original.state === "requested") await this.deps.trusted.rejectDispatch(original.projectId, original.id, "Run requester authority is no longer configured");
      return false;
    }
    if (!currentAuthority && original.state === "requested" && !original.nativeTurnId) {
      await this.deps.trusted.rejectDispatch(original.projectId, original.id, "Current authorization is unavailable for a new Turn");
      return false;
    }
    const unstarted=original.state==="requested"&&!original.nativeTurnId;
    const canStart=unstarted&&this.deps.trusted.canStartRecoveredRun ?
      await this.deps.trusted.canStartRecoveredRun(original.projectId,original.sessionId,original.id) : true;
    // A blocked gate may still need read-only reconciliation of a lost activation
    // reply, or durable closure of an explicit rejection. Neither starts a Turn.
    const activation=session.executionProfile?.activationState;
    if(unstarted&&!canStart&&!['attempting','unknown','rejected'].includes(activation??''))return false;
    const binding = unstarted ? await this.executionBinding(session,original) : await this.readBinding(session);
    if(!binding||unstarted&&!canStart)return false;
    let run = original;
    if (run.state === "requested" && !run.nativeTurnId) {
      let input: string;
      let inputReceipt: { protocol: string; contentHash: string; byteLength: number } | undefined;
      try {
        if (run.evaluationBinding) {
          const prepared = await this.prepareEvaluationInput(principal, session, run);
          run = prepared.run; input = prepared.input;
          inputReceipt = { protocol: run.evaluationPacket?.builderVersion ?? "evaluation-packet", contentHash: digest(input), byteLength: Buffer.byteLength(input, "utf8") };
        } else {
          const prepared = await this.lightweightInput(principal, run, session);
          input = prepared.input;
          inputReceipt = { protocol: prepared.protocol, contentHash: prepared.contentHash, byteLength: prepared.byteLength };
        }
      }
      catch (error) { await this.deps.trusted.rejectDispatch(run.projectId, run.id, safePreflightReport(error).summary);
        this.recordFault(run.projectId,"run_preflight",error,run.sessionId,run.id);return false; }
      // Recheck after preflight, immediately before recording the external-start intent.
      if (!run.nativeTurnId && this.deps.mayDispatchRun && !await this.deps.mayDispatchRun(run)) return false;
      await this.deps.trusted.beginDispatch(run.projectId, run.id, inputReceipt);
      let startBinding: RuntimeBinding;
      try {
        // Persist the original intent before resuming the same full-permission Thread
        // and starting its Turn. An uncertain resume is never retried.
        startBinding = await this.resumeForRun(session);
      } catch (error) {
        if (error instanceof RuntimeServerError && error.method === "thread/resume") {
          await this.deps.trusted.rejectDispatch(run.projectId, run.id,
            "Native business-profile resume was explicitly rejected before Task turn/start", {
              kind: "native_resume_rejected", operationId: run.operationId, code: error.code, category: error.category,
            });
          this.recordFault(run.projectId,"business_profile_restore",error,run.sessionId,run.id);
        } else {
          await this.deps.trusted.markRunUnknown(run.projectId, run.id,
            `Business profile restoration was not confirmed; this coordinator did not call Task turn/start; ${dispatchFailureDetail(error)}; reconcile the original operation without replay`);
          this.recordFault(run.projectId,"business_profile_restore",error,run.sessionId,run.id,"unknown_outcome");
        }
        return false;
      }
      let turn: RuntimeTurn;
      try {
        turn = await this.runtime.startTurn(startBinding, input, run.operationId,run.executionProfile);
      } catch (error) {
        await this.deps.trusted.markRunUnknown(run.projectId, run.id,
          `Task turn/start outcome was not confirmed; ${dispatchFailureDetail(error)}; reconcile owned history before any retry`);
        this.recordFault(run.projectId,"run_start",error,run.sessionId,run.id,"unknown_outcome");
        return false;
      }
      try {
        run = await this.deps.trusted.bindTurn(run.projectId, run.id, turn, { kind: "startReply", operationId: run.operationId, inputReceipt });
      } catch (error) {
        await this.deps.trusted.markRunUnknown(run.projectId, run.id,
          "Task turn/start returned a Turn but its binding receipt was not saved; reconcile the original operation without starting another Turn");
        this.recordFault(run.projectId,"run_bind",error,run.sessionId,run.id,"unknown_outcome");
        return false;
      }
    }
    const turns = run.nativeTurnId ? [] : (await this.runtime.listTurns(binding)).data.slice(0, 20);
    if (!run.nativeTurnId) {
      const matches: RuntimeTurn[] = [];
      // A native request ID is not an idempotency promise. Correlate the durable marker in owned user input.
      for (const turn of turns.slice(0, 20)) {
        const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 10);
        if (items.some(item => object(item)?.type === "userMessage" && textOf(item).startsWith(marker(run.operationId)))) matches.push(turn);
      }
      if (matches.length !== 1) {
        this.recordFault(run.projectId,"run_reconcile",null,run.sessionId,run.id,"verification");
        return false;
      }
      run = await this.deps.trusted.bindTurn(run.projectId, run.id, matches[0]!, { kind: "historyMarker", operationId: run.operationId });
    }
    const lookup = await lookupKnownTurn(this.runtime.listTurns.bind(this.runtime), binding, run.nativeTurnId!);
    if (lookup.status !== "found") {
      if (lookup.status === "not_found") this.recordFault(run.projectId,"run_reconcile",null,run.sessionId,run.id,"verification");
      return false;
    }
    const turn = lookup.turn;
    if (run.interruptRequested && !this.interruptAttempted.has(run.id)) {
      const events = await this.deps.workflow.listRuntimeEvents(principal, run.projectId, run.id);
      if (!events.some(e => e.kind === "run.interruptResult")) {
        this.interruptAttempted.add(run.id);
        // Record the intent before external I/O; a restart cannot blindly repeat an uncertain interruption.
        await this.deps.trusted.recordInterruptResult(run.projectId, run.id, "unknown", "External interrupt attempt begins; final Turn status remains authoritative");
        try {
          await this.runtime.interruptTurn(binding, turn.id);
          await this.deps.trusted.recordInterruptResult(run.projectId, run.id, "acknowledged", "Interrupt request acknowledged; awaiting terminal history");
        } catch { /* The durable unknown receipt remains available. */ }
      }
    }
    // The native history list can transiently project an active turn as "interrupted".
    // Only a settled native timestamp proves a terminal observation.
    if (original.state === "running" && run.state === "running" && run.nativeTurnId === original.nativeTurnId &&
        !run.interruptRequested && turn.status === "inProgress") {
      // Exact readback heals a transient history failure, but does not settle a durable unknown Run.
      this.clearFault(run.projectId,run.sessionId,run.id,"run_reconcile");
      return false;
    }
    if (!["completed", "failed", "interrupted"].includes(turn.status) || !turn.completedAtUtc) return false;
    const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
    const messages = finalMessages(items);
    if (turn.error) messages.push(`Native failure: ${turn.error.summary}; category=${turn.error.category}; HTTP=${turn.error.httpStatus ?? "unknown"}; providerCode=${turn.error.providerCode ?? "unknown"}`);
    await this.deps.trusted.recordTurn(run.projectId, run.id, turn.id, turn.status as "completed" | "failed" | "interrupted",
      messages.join("\n\n"), { itemsDigest: digest(JSON.stringify(items)), completedAtUtc: turn.completedAtUtc });
    return true;
  }
  private async flushApprovals(target?: typeof this.approvalQueue[number]): Promise<void> {
    if (this.approvalFlush) {
      await this.approvalFlush;
      if (!target || !this.approvalQueue.includes(target)) return;
    }
    this.approvalFlush = this.writeApprovalReceipts().finally(() => { this.approvalFlush = null; });
    return this.approvalFlush;
  }
  private async writeApprovalReceipts(): Promise<void> {
    for (const approval of [...this.approvalQueue]) {
      if (!approval.threadId) continue;
      if (approval.projectId && approval.sessionId) {
        const principal = this.principal(approval.projectId);
        const session = await this.deps.workflow.getRuntimeSession(principal, approval.projectId, approval.sessionId);
        if (["creating", "unknown"].includes(session.state) && !session.nativeThreadId) {
          await this.deps.trusted.recordSessionApprovalDeclined(approval.projectId, session.id, approval.threadId,
            approval.turnId ?? null, `Approval declined by policy: ${approval.method}; request ${approval.id}; unbound request observed during create; native identity not yet verified`);
          this.approvalQueue.splice(this.approvalQueue.indexOf(approval), 1);
          this.clearFault(approval.projectId,session.id,undefined,"approval_receipt");
          continue;
        }
      }
      let matched = false;
      for (const projectId of this.projects()) {
        let principal: Principal;
        try { principal = this.principal(projectId); } catch { continue; }
        let sessions: RuntimeSessionRecord[];
        try { sessions = await this.deps.workflow.listRuntimeSessions(principal, projectId); }
        catch { continue; }
        const session = sessions.find(s => s.nativeThreadId === approval.threadId && s.state === "ready");
        if (!session) continue;
        const runs = await this.deps.workflow.listRuntimeRuns(principal, projectId);
        const run = runs.find(r => r.sessionId === session.id && r.nativeTurnId && r.nativeTurnId === approval.turnId);
        const detail = `Approval declined by policy: ${approval.method}; request ${approval.id}`;
        if (run && approval.turnId) await this.deps.trusted.recordApprovalDeclined(projectId, run.id, approval.turnId, detail);
        else await this.deps.trusted.recordSessionApprovalDeclined(projectId, session.id, approval.threadId, approval.turnId ?? null, detail);
        matched = true;
        break;
      }
      if (matched) {
        this.approvalQueue.splice(this.approvalQueue.indexOf(approval), 1);
        if (approval.projectId) this.clearFault(approval.projectId,approval.sessionId,undefined,"approval_receipt");
      }
    }
  }
  async result(principal: Principal, projectId: string, runId: string): Promise<{ messages: string[]; source: "owned-native-history"; finalPhaseConfirmed: boolean; observedAt: string }> {
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (!run.nativeTurnId) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "此运行尚未绑定原生 Turn，没有可确认的原生答复；请先阅读运行回执。");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    try {
      const binding = await this.readBinding(session);
      // The persisted owned binding and exact Turn ID identify the result.
      // Item pagination does not require scanning unrelated Thread history first.
      const items = await collect(cursor => this.runtime.listItems(binding, run.nativeTurnId!, cursor), 100);
      return { messages: finalMessages(items), source: "owned-native-history",
        finalPhaseConfirmed: items.some(item => object(item)?.type === "agentMessage" && object(item)?.phase === "final_answer"),
        observedAt: new Date().toISOString() };
    } catch (error) { throw this.readFailure(error); }
  }
  /** Metadata for one frozen source Run, using the same current authority as worker trace. No native read. */
  async workerFixedRunMetadata(principal: Principal, projectId: string, runId: string,
    identity: WorkerIdentity): Promise<Pick<RuntimeRunRecord,
      "projectId" | "id" | "taskId" | "taskRevisionId" | "inputHash" | "state" | "nativeTurnId">> {
    const scope = identity.scope;
    if (identity.principal.actorId !== principal.actorId || scope.projectId !== projectId ||
        !principal.projectIds.includes(projectId) || !principal.permissions.includes("read") ||
        !this.deps.workerTraceAuthority)
      throw new DomainError("FORBIDDEN", "受管读取者身份或固定引用不可用。");
    const reader = await this.deps.workflow.getRuntimeRun(principal, projectId, scope.runId);
    const readerSession = await this.deps.workflow.getRuntimeSession(principal, projectId, scope.sessionId);
    if (reader.taskId !== scope.taskId || reader.sessionId !== scope.sessionId || !reader.nativeTurnId ||
        readerSession.roleId !== scope.roleId || readerSession.state !== "ready" ||
        !await this.authorized(readerSession, reader.actorId) ||
        !await this.deps.workerTraceAuthority(identity, runId))
      throw new DomainError("FORBIDDEN", "目标运行未被本次受管运行的固定依据采纳。");
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    if (!run.nativeTurnId || !["completed","failed","interrupted"].includes(run.state) ||
        session.projectId !== projectId || session.id !== run.sessionId || session.state !== "ready" ||
        !await this.authorized(session, run.actorId))
      throw new DomainError("FORBIDDEN", "此运行所属会话的授权已失效。");
    return {projectId:run.projectId,id:run.id,taskId:run.taskId,taskRevisionId:run.taskRevisionId,
      inputHash:run.inputHash,state:run.state,nativeTurnId:run.nativeTurnId};
  }
  async trace(principal: Principal, projectId: string, runId: string, initialCursor?: string,
    workerIdentity?: WorkerIdentity, turnCursor?: string): Promise<RuntimeWorkTrace> {
    const reviewer = !!principal.actorId && principal.projectIds.includes(projectId) && principal.permissions.includes("read") &&
      principal.permissions.includes("review") && this.deps.principals.some(p => p.actorId === principal.actorId &&
        p.projectIds.includes(projectId) && p.permissions.includes("read") && p.permissions.includes("review"));
    if (workerIdentity) await this.workerFixedRunMetadata(principal, projectId, runId, workerIdentity);
    else if (!reviewer) throw new DomainError("FORBIDDEN", "读取工作轨迹需要本项目读取和复核权限。");
    if (!this.runtime.readWorkPage) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "当前执行适配器不支持工作轨迹读取。");
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (run.projectId !== projectId || !run.nativeTurnId)
      throw new DomainError("RUNTIME_READ_UNAVAILABLE", "此运行尚无可核对的受管原生 Turn。");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    if (session.projectId !== projectId || session.id !== run.sessionId || session.state !== "ready" ||
      !await this.authorized(session, run.actorId))
      throw new DomainError("FORBIDDEN", "此运行所属会话的授权已失效。");
    try {
      const binding = await this.readBinding(session);
      const lookup = await lookupKnownTurn(this.runtime.listTurns.bind(this.runtime), binding, run.nativeTurnId, turnCursor);
      const turn = lookup.status === "found" ? lookup.turn : null;
      const items: RuntimeWorkTrace["items"] = [];
      let unsupportedCount = 0, truncated = false, cursor: string | undefined = initialCursor;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
        const page = await this.runtime.readWorkPage!(binding, run.nativeTurnId, cursor);
        if (page.data.length + page.unsupportedCount > 50) throw new Error("Runtime work page exceeds item budget");
        items.push(...page.data); unsupportedCount += page.unsupportedCount; truncated ||= page.truncated;
        if (!page.nextCursor) { cursor = undefined; break; }
        if (seen.has(page.nextCursor)) throw new Error("Runtime work cursor repeated");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      truncated ||= !!cursor;
      return { runId: run.id, nativeTurnId: run.nativeTurnId, source: "owned-native-history", observedAt: new Date().toISOString(), turn,
        turnMetadata: { status: lookup.status, nextTurnCursor: lookup.status === "partial" ? lookup.nextTurnCursor : null },
        items, unsupportedCount, truncated, nextCursor: cursor ?? null,
        completeness: truncated || unsupportedCount || initialCursor || items.length === 0 || !turn?.completedAtUtc ? "partial" : "complete",
        limits: { maxPages: 2, maxItems: 100, maxFieldChars: 2000 } };
    } catch (error) { throw this.readFailure(error); }
  }
  /** Explicit reviewer readback of a previously recorded terminal observation; never starts a turn. */
  async reconcile(principal: Principal, projectId: string, runId: string, expectedVersion: number, reason: string,
    turnCursor?: string): Promise<RuntimeRunRecord | RuntimeReconcilePartial> {
    if (!this.available || !this.runtime.isReady() || !this.deps.canWrite()) throw new Error("Runtime readback is unavailable");
    if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read") ||
      !principal.permissions.includes("review") || !this.deps.principals.some(p => p.actorId === principal.actorId &&
        p.projectIds.includes(projectId) && p.permissions.includes("read") && p.permissions.includes("review")))
      throw new Error("Project review authority is unavailable");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !reason.trim()) throw new Error("Version and review reason are required");
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (run.version !== expectedVersion || !run.nativeTurnId || !["completed", "failed", "interrupted"].includes(run.state))
      throw new Error("Bound terminal run version is required for readback");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    if (session.state !== "ready" || !(await this.authorized(session, run.actorId) && await this.authorized(session, principal.actorId) ||
      await this.owned(session, run)))
      throw new Error("Session authority is no longer available");
    const binding = await this.readBinding(session);
    const lookup = await lookupKnownTurn(this.runtime.listTurns.bind(this.runtime), binding, run.nativeTurnId, turnCursor);
    if (lookup.status === "partial") return { status: "partial", changed: false, projectId, runId,
      nativeTurnId: run.nativeTurnId, expectedVersion, nextTurnCursor: lookup.nextTurnCursor, reason };
    const turn = lookup.status === "found" ? lookup.turn : null;
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status) || !turn.completedAtUtc)
      throw new Error("Native turn has no settled terminal observation");
    const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
    const messages = finalMessages(items);
    if (turn.error) messages.push(`Native failure: ${turn.error.summary}; category=${turn.error.category}; HTTP=${turn.error.httpStatus ?? "unknown"}; providerCode=${turn.error.providerCode ?? "unknown"}`);
    const reconciled = await this.deps.trusted.reconcileTerminalObservation(projectId, run.id, turn.id,
      turn.status as "completed" | "failed" | "interrupted", messages.join("\n\n"),
      { itemsDigest: digest(JSON.stringify(items)), completedAtUtc: turn.completedAtUtc }, expectedVersion, principal, reason);
    this.clearFault(projectId,run.sessionId,run.id);
    return reconciled;
  }
  async stop(): Promise<void> {
    this.stopped = true; this.available = false;
    if (this.timer) clearInterval(this.timer);
    if (this.busy) await this.busy;
    this.unsubscribeDisconnect?.(); this.unsubscribeApproval?.();
    await this.runtime.close();
    await this.deps.nativeInputs?.drain();
    this.deps.nativeInputs?.detach();
    await this.deps.nativeObservation?.drain();
    this.deps.nativeObservation?.detach();
  }
}
