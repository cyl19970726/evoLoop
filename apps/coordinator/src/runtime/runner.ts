import { createHash, randomUUID } from "node:crypto";
import type { BasisSet, EvaluationFixedRef, Principal, RuntimeRunRecord, RuntimeSessionRecord, TaskRevision } from "@evoloop/contracts";
import type { RuntimeBinding, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn, EvaluationPacketBinding, RuntimeWorkTrace } from "@evoloop/contracts/runtime";
import type { BlobStore } from "@evoloop/contracts/sources";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeGrant } from "../configuration.js";
import type { WorkerIdentity } from "../workers/types.js";
import { fixedDocumentMaterial } from "./materials.js";
import type { ReadDocumentOriginal } from "./materials.js";
import { buildEvaluationPacket, canonicalEvaluationJson, evaluationPacketBlobId, evaluationPacketBlobPayload, evaluationPacketMediaType,
  uniqueEvaluationSources, verifyEvaluationPacket, type ReadEvaluationMaterial } from "./evaluation-materials.js";

interface TaskInputMaterial { input: string; sources: EvaluationFixedRef[]; revision: TaskRevision; basis: BasisSet }

type ManagedRuntime = RuntimePort & { open(): Promise<void>; registerBinding(binding: RuntimeBinding): Promise<void>;
  isReady(): boolean; onDisconnect(listener: (reason: string) => void): () => void };
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
    nativeSessionId: session.nativeSessionId, owner: "evoloop-codex-app-server" };
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
  private interruptAttempted = new Set<string>();
  private approvalQueue: { id: string | number; projectId?: string; sessionId?: string; threadId?: string; turnId?: string; method: string }[] = [];
  private approvalFlush: Promise<void> | null = null;
  private currentError: string | null = null;
  private available = false;
  private runtime: ManagedRuntime;
  private recovering: Promise<void> | null = null;
  private unsubscribeDisconnect: (() => void) | null = null;
  private unsubscribeApproval: (() => void) | null = null;

  constructor(private readonly deps: {
    readExternalMaterials?(principal:Principal,projectId:string,taskId:string,taskRevisionId:string):Promise<string>;
    runtimeFactory(): ManagedRuntime; workflow: WorkflowService; trusted: RuntimeWorkflowService;
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
    readDocumentOriginal?: ReadDocumentOriginal;
    readEvaluationMaterial?: ReadEvaluationMaterial;
    blobsForPrincipal?: (principal: Principal) => BlobStore | Promise<BlobStore>;
  }) { this.runtime = deps.runtimeFactory(); }
  status() { return { available: this.available && this.runtime.isReady(), error: this.currentError }; }
  private principal(projectId: string): Principal {
    const principal = this.deps.principals.find(p => p.projectIds.includes(projectId) && p.permissions.includes("read") && p.permissions.includes("write"));
    if (!principal) throw new Error("Project authority is unavailable");
    return principal;
  }
  private async authorized(session: RuntimeSessionRecord, actorId = session.actorId): Promise<boolean> {
    return this.deps.principals.some(p => p.actorId === actorId && p.projectIds.includes(session.projectId) &&
      p.permissions.includes("read") && p.permissions.includes("write") && p.permissions.includes("review")) &&
      await this.deps.hasGrant({ projectId: session.projectId, actorId, roleId: session.roleId,
        authorizationScope: session.authorizationScope, cwd: session.cwd, sandbox: session.sandbox }, session);
  }
  private async owned(session: RuntimeSessionRecord, run?: RuntimeRunRecord): Promise<boolean> {
    return !!this.deps.canSettleOwned && !!await this.deps.canSettleOwned(session, run) &&
      !!await this.deps.ownedCwd?.(session.projectId, session.cwd);
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error("Runner has stopped");
    this.attachRuntime();
    await this.runtime.open();
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
    this.unsubscribeDisconnect = this.runtime.onDisconnect(reason => {
      if (this.stopped) return;
      this.available = false;
      this.currentError = `Codex transport disconnected: ${reason}. Explicit recovery is required.`;
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
      catch {
        this.available = false;
        this.currentError = "Approval denial evidence could not be saved; explicit recovery is required.";
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
    try { await this.runtime.close(); } catch { /* replacement still proceeds */ }
    this.runtime = this.deps.runtimeFactory();
    this.registered.clear(); this.interruptAttempted.clear();
    this.attachRuntime();
    try {
      await this.runtime.open();
      for (const projectId of this.projects()) await this.deps.trusted.recoverDispatching(projectId);
      this.currentError = null;
      this.available = true;
      await this.pump();
      this.ensureTimer();
    } catch (error) {
      this.available = false;
      this.currentError = error instanceof Error ? error.message : "Runtime recovery failed";
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
        try { await this.deps.workflow.getProject(principal, projectId); } catch { continue; }
        const sessions = await this.deps.workflow.listRuntimeSessions(principal, projectId);
        for (const session of sessions) {
          if (session.state === "reserved") await this.create(session);
          if (session.state === "closing") {
            try { await this.closeSession(session); }
            catch { this.currentError = "会话归档尚未核实；保留原关闭意图，只读对账等待恢复。"; }
          }
        }
        const runs = await this.deps.workflow.listRuntimeRuns(principal, projectId);
        for (const run of runs) {
          try { await this.process(principal, run); }
          catch { this.currentError = "某项运行暂不可对账，保留原运行 ID 与未知状态。"; }
        }
        await this.flushApprovals();
      } catch { this.currentError = "运行服务暂不可读取；新派发须等待恢复。"; }
    }
  }
  private async closeSession(session: RuntimeSessionRecord): Promise<void> {
    if (!session.closeOperationId || !(await this.authorized(session) && await this.deps.allowedCwd(session.projectId, session.cwd) || await this.owned(session)))
      throw new Error("Session close authority or intent is unavailable");
    if (!this.runtime.isThreadArchived) throw new Error("Native archive verification unsupported");
    const binding = bindingOf(session);
    await this.runtime.registerBinding(binding);
    // Readback comes before any write, including after a restart or lost acknowledgement.
    if (await this.runtime.isThreadArchived(binding)) {
      await this.deps.trusted.confirmSessionClosed(session.projectId, binding, session.closeOperationId);
      return;
    }
    if (session.closeAttemptedAt) return;
    if (!this.runtime.archiveThread) throw new Error("Native archive unsupported");
    // Native source is a UI classification, not proof of who created the thread.
    // inspect validates the exact persisted thread/session/cwd binding before archive.
    await this.runtime.inspect(binding);
    await this.deps.trusted.markSessionArchiveAttempt(session.projectId, session.id, session.closeOperationId);
    try { await this.runtime.archiveThread(binding); }
    catch { /* Archive may have happened. A subsequent pump only reads archived state. */ }
    if (await this.runtime.isThreadArchived(binding))
      await this.deps.trusted.confirmSessionClosed(session.projectId, binding, session.closeOperationId);
  }
  private async create(session: RuntimeSessionRecord): Promise<void> {
    if (!await this.authorized(session) || !await this.deps.allowedCwd(session.projectId, session.cwd)) return;
    if (this.deps.mayCreateSession && !await this.deps.mayCreateSession(session)) return;
    await this.deps.trusted.beginSessionCreate(session.projectId, session.id);
    try {
      const spec: RuntimeSessionSpec = { actorId: session.actorId, sessionId: session.id, roleId: session.roleId, projectId: session.projectId,
        cwd: session.cwd, authorizationScope: session.authorizationScope, sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy, ...(session.model ? { model: session.model } : {}) };
      const binding = await this.runtime.create(spec);
      await this.deps.trusted.bindSession(session.projectId, session.id, binding);
      this.registered.add(session.id);
    } catch {
      await this.deps.trusted.markSessionUnknown(session.projectId, session.id, "Thread creation acknowledgement unavailable; no automatic retry");
    }
  }
  private async restore(session: RuntimeSessionRecord): Promise<RuntimeBinding> {
    if (!await this.authorized(session) || !await this.deps.allowedCwd(session.projectId, session.cwd)) throw new Error("Session authority is no longer available");
    const binding = bindingOf(session);
    if (!this.registered.has(session.id)) {
      await this.runtime.registerBinding(binding);
      await this.runtime.resume(binding);
      this.registered.add(session.id);
    }
    return binding;
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
      const turns = await collect(cursor => this.runtime.listTurns(binding, cursor), 10);
      const result = [];
      for (const turn of turns.slice(0,20)) {
        const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
        result.push({ id: turn.id, status: turn.status, messages: items.filter(item => ["userMessage", "agentMessage"].includes(String(object(item)?.type))).map(item => ({type:String(object(item)?.type),text:textOf(item)})) });
      }
      return { turns: result, truncated: turns.length > 20, observedAt: new Date().toISOString() };
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

  private async process(principal: Principal, original: RuntimeRunRecord): Promise<void> {
    if (!["requested", "running", "unknown"].includes(original.state)) return;
    if (original.state === "requested" && !original.nativeTurnId && this.deps.mayDispatchRun &&
      !await this.deps.mayDispatchRun(original)) return;
    const session = await this.deps.workflow.getRuntimeSession(principal, original.projectId, original.sessionId);
    if (session.state !== "ready") return;
    const currentAuthority = await this.authorized(session, original.actorId);
    if (!currentAuthority && !await this.owned(session, original)) {
      if (original.state === "requested") await this.deps.trusted.rejectDispatch(original.projectId, original.id, "Run requester authority is no longer configured");
      return;
    }
    if (!currentAuthority && original.state === "requested" && !original.nativeTurnId) {
      await this.deps.trusted.rejectDispatch(original.projectId, original.id, "Current authorization is unavailable for a new Turn");
      return;
    }
    const binding = original.state === "requested" && !original.nativeTurnId ?
      await this.restore(session) : await this.readBinding(session);
    let run = original;
    if (run.state === "requested" && !run.nativeTurnId) {
      let input: string;
      try {
        if (run.evaluationBinding) {
          const prepared = await this.prepareEvaluationInput(principal, session, run);
          run = prepared.run; input = prepared.input;
        } else input = (await this.input(principal, run)).input;
      }
      catch (error) { await this.deps.trusted.rejectDispatch(run.projectId, run.id, error instanceof Error ? error.message : "Preflight failed"); return; }
      // Recheck after preflight, immediately before recording the external-start intent.
      if (!run.nativeTurnId && this.deps.mayDispatchRun && !await this.deps.mayDispatchRun(run)) return;
      await this.deps.trusted.beginDispatch(run.projectId, run.id);
      try {
        const turn = await this.runtime.startTurn(binding, input, run.operationId);
        run = await this.deps.trusted.bindTurn(run.projectId, run.id, turn, { kind: "startReply", operationId: run.operationId });
      } catch (error) {
        const detail = error instanceof Error && error.name === "RuntimeServerError" ? error.message : "turn/start acknowledgement unavailable";
        await this.deps.trusted.markRunUnknown(run.projectId, run.id, `${detail}; reconcile owned history before any retry`);
        return;
      }
    }
    const turns = await collect(cursor => this.runtime.listTurns(binding, cursor), 10);
    if (!run.nativeTurnId) {
      const matches: RuntimeTurn[] = [];
      // A native request ID is not an idempotency promise. Correlate the durable marker in owned user input.
      for (const turn of turns.slice(0, 20)) {
        const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 10);
        if (items.some(item => object(item)?.type === "userMessage" && textOf(item).startsWith(marker(run.operationId)))) matches.push(turn);
      }
      if (matches.length !== 1) return;
      run = await this.deps.trusted.bindTurn(run.projectId, run.id, matches[0]!, { kind: "historyMarker", operationId: run.operationId });
    }
    const turn = turns.find(t => t.id === run.nativeTurnId);
    if (!turn) { await this.deps.trusted.markRunUnknown(run.projectId, run.id, "Known Turn is not currently readable"); return; }
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
    if (!["completed", "failed", "interrupted"].includes(turn.status) || !turn.completedAtUtc) return;
    const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
    const messages = finalMessages(items);
    if (turn.error) messages.push(`Native failure: ${turn.error.summary}; category=${turn.error.category}; HTTP=${turn.error.httpStatus ?? "unknown"}; providerCode=${turn.error.providerCode ?? "unknown"}`);
    await this.deps.trusted.recordTurn(run.projectId, run.id, turn.id, turn.status as "completed" | "failed" | "interrupted",
      messages.join("\n\n"), { itemsDigest: digest(JSON.stringify(items)), completedAtUtc: turn.completedAtUtc });
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
      if (matched) this.approvalQueue.splice(this.approvalQueue.indexOf(approval), 1);
    }
  }
  async result(principal: Principal, projectId: string, runId: string): Promise<{ messages: string[]; source: "owned-native-history"; finalPhaseConfirmed: boolean; observedAt: string }> {
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (!run.nativeTurnId) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "此运行尚未绑定原生 Turn，没有可确认的原生答复；请先阅读运行回执。");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    try {
      const binding = await this.readBinding(session);
      const turns = await collect(cursor => this.runtime.listTurns(binding, cursor), 10);
      if (!turns.some(turn => turn.id === run.nativeTurnId)) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "已绑定的原生 Turn 当前不可见；已保存的结果摘要不是原生全文，请稍后重试读取。");
      const items = await collect(cursor => this.runtime.listItems(binding, run.nativeTurnId!, cursor), 100);
      return { messages: finalMessages(items), source: "owned-native-history",
        finalPhaseConfirmed: items.some(item => object(item)?.type === "agentMessage" && object(item)?.phase === "final_answer"),
        observedAt: new Date().toISOString() };
    } catch (error) { throw this.readFailure(error); }
  }
  async trace(principal: Principal, projectId: string, runId: string, initialCursor?: string,
    workerIdentity?: WorkerIdentity): Promise<RuntimeWorkTrace> {
    const reviewer = !!principal.actorId && principal.projectIds.includes(projectId) && principal.permissions.includes("read") &&
      principal.permissions.includes("review") && this.deps.principals.some(p => p.actorId === principal.actorId &&
        p.projectIds.includes(projectId) && p.permissions.includes("read") && p.permissions.includes("review"));
    if (workerIdentity) {
      const scope = workerIdentity.scope;
      if (workerIdentity.principal.actorId !== principal.actorId || scope.projectId !== projectId ||
          !principal.permissions.includes("read") || !this.deps.workerTraceAuthority)
        throw new DomainError("FORBIDDEN", "受管读取者身份或固定引用不可用。");
      const reader = await this.deps.workflow.getRuntimeRun(principal, projectId, scope.runId);
      const readerSession = await this.deps.workflow.getRuntimeSession(principal, projectId, scope.sessionId);
      if (reader.taskId !== scope.taskId || reader.sessionId !== scope.sessionId || !reader.nativeTurnId ||
          readerSession.roleId !== scope.roleId || readerSession.state !== "ready" ||
          !this.authorized(readerSession, reader.actorId) || !await this.deps.workerTraceAuthority(workerIdentity, runId))
        throw new DomainError("FORBIDDEN", "目标运行未被本次受管运行的固定依据采纳。");
    } else if (!reviewer) throw new DomainError("FORBIDDEN", "读取工作轨迹需要本项目读取和复核权限。");
    if (!this.runtime.readWorkPage) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "当前执行适配器不支持工作轨迹读取。");
    const run = await this.deps.workflow.getRuntimeRun(principal, projectId, runId);
    if (run.projectId !== projectId || !run.nativeTurnId)
      throw new DomainError("RUNTIME_READ_UNAVAILABLE", "此运行尚无可核对的受管原生 Turn。");
    const session = await this.deps.workflow.getRuntimeSession(principal, projectId, run.sessionId);
    if (session.projectId !== projectId || session.id !== run.sessionId || session.state !== "ready" ||
      !this.authorized(session, run.actorId))
      throw new DomainError("FORBIDDEN", "此运行所属会话的授权已失效。");
    try {
      const binding = await this.readBinding(session);
      const turns = await collect(cursor => this.runtime.listTurns(binding, cursor), 10);
      const turn = turns.find(candidate => candidate.id === run.nativeTurnId);
      if (!turn) throw new DomainError("RUNTIME_READ_UNAVAILABLE", "已绑定的原生 Turn 当前不可见，不能确认工作轨迹。");
      const items: RuntimeWorkTrace["items"] = [];
      let unsupportedCount = 0, truncated = false, cursor: string | undefined = initialCursor;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
        const page = await this.runtime.readWorkPage!(binding, turn.id, cursor);
        if (page.data.length + page.unsupportedCount > 50) throw new Error("Runtime work page exceeds item budget");
        items.push(...page.data); unsupportedCount += page.unsupportedCount; truncated ||= page.truncated;
        if (!page.nextCursor) { cursor = undefined; break; }
        if (seen.has(page.nextCursor)) throw new Error("Runtime work cursor repeated");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      truncated ||= !!cursor;
      return { runId: run.id, source: "owned-native-history", observedAt: new Date().toISOString(), turn,
        items, unsupportedCount, truncated, nextCursor: cursor ?? null,
        completeness: truncated || unsupportedCount || initialCursor || items.length === 0 || !turn.completedAtUtc ? "partial" : "complete",
        limits: { maxPages: 2, maxItems: 100, maxFieldChars: 2000 } };
    } catch (error) { throw this.readFailure(error); }
  }
  /** Explicit reviewer readback of a previously recorded terminal observation; never starts a turn. */
  async reconcile(principal: Principal, projectId: string, runId: string, expectedVersion: number, reason: string): Promise<RuntimeRunRecord> {
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
    const turns = await collect(cursor => this.runtime.listTurns(binding, cursor), 10);
    const turn = turns.find(candidate => candidate.id === run.nativeTurnId);
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status) || !turn.completedAtUtc)
      throw new Error("Native turn has no settled terminal observation");
    const items = await collect(cursor => this.runtime.listItems(binding, turn.id, cursor), 100);
    const messages = finalMessages(items);
    if (turn.error) messages.push(`Native failure: ${turn.error.summary}; category=${turn.error.category}; HTTP=${turn.error.httpStatus ?? "unknown"}; providerCode=${turn.error.providerCode ?? "unknown"}`);
    return this.deps.trusted.reconcileTerminalObservation(projectId, run.id, turn.id,
      turn.status as "completed" | "failed" | "interrupted", messages.join("\n\n"),
      { itemsDigest: digest(JSON.stringify(items)), completedAtUtc: turn.completedAtUtc }, expectedVersion, principal, reason);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.available = false;
    if (this.timer) clearInterval(this.timer);
    if (this.busy) await this.busy;
    this.unsubscribeDisconnect?.(); this.unsubscribeApproval?.();
    await this.runtime.close();
  }
}
