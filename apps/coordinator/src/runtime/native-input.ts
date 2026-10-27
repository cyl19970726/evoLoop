import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import type { NativeInputEvent, NativeInputRecord } from "@evoloop/contracts/native-input";
import type { NativeInputView } from "@evoloop/contracts/session-observation";
import type { RuntimePort } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import type { NativeInputService } from "@evoloop/core/native-input";

/** Lives inside the existing runner cycle. It does not start Turns or own another work queue. */
export class NativeInputBridge {
  private runtime: RuntimePort | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = new Set<Promise<void>>();
  constructor(private readonly deps: {
    service: NativeInputService;
    canWrite(): boolean;
    projects(): Promise<string[]>;
    principal(projectId: string, actorId: string): Promise<Principal | null>;
    session(projectId: string, sessionId: string): Promise<RuntimeSessionRecord | null>;
    executionAuthorized(session: RuntimeSessionRecord, sourceActorId: string): Promise<boolean>;
    now(): string;
  }) {}

  attach(runtime: RuntimePort): void {
    this.unsubscribe?.();
    this.runtime = runtime;
    this.unsubscribe = runtime.onNativeInput?.(event => {
      const write = this.observe(runtime, event);
      this.pending.add(write);
      void write.finally(() => this.pending.delete(write)).catch(() => {});
      return write;
    }) ?? null;
  }
  async opened(): Promise<void> {
    const connectionId = this.runtime?.nativeInputConnectionId?.();
    if (!connectionId || !this.deps.canWrite()) return;
    for (const projectId of await this.deps.projects())
      await this.deps.service.invalidateConnections(projectId, connectionId);
  }
  private async observe(runtime: RuntimePort, event: NativeInputEvent): Promise<void> {
    if (!this.deps.canWrite()) throw new Error("Native input persistence is unavailable");
    if (event.type === "closed") {
      await this.deps.service.closed(event.projectId, event.id, event.connectionId, event.reason, event.observedAt);
      return;
    }
    const request = await this.deps.service.capture(event.request);
    // A resolved/disconnect notification can overtake the database insert. Never leave a dead RPC answerable.
    if (request.supported && !runtime.hasPendingInput?.(request.id, request.connectionId))
      await this.deps.service.closed(request.projectId, request.id, request.connectionId, "request_unavailable", this.deps.now());
  }
  async drain(): Promise<void> { await Promise.all([...this.pending]); }
  detach(): void { this.unsubscribe?.(); this.unsubscribe = null; this.runtime = null; }

  private async replyReason(principal: Principal, record: NativeInputRecord): Promise<string | null> {
    if (!principal.projectIds.includes(record.projectId) || !principal.permissions.includes("read") ||
        !principal.permissions.includes("write")) return "当前身份没有本项目的回复权限。";
    if (record.state !== "pending" || !record.supported) return record.reason ?? "原生请求当前不可回复。";
    if (!record.source) return "原生请求的运行或消息归属仍在核对。";
    if (record.source.actorId !== principal.actorId && !principal.permissions.includes("review"))
      return "需要原请求发起者或本项目复核者回复。";
    if (!this.deps.canWrite() || !this.runtime?.hasPendingInput?.(record.id, record.connectionId))
      return "原生请求已清理、连接已断开或协调者当前不可写。";
    const current = await this.deps.principal(record.projectId, principal.actorId);
    if (!current || !current.permissions.includes("read") || !current.permissions.includes("write") ||
        (record.source.actorId !== current.actorId && !current.permissions.includes("review")))
      return "当前回复身份的授权已失效。";
    const session = await this.deps.session(record.projectId, record.sessionId);
    if (!session || session.state !== "ready" || session.nativeThreadId !== record.threadId ||
        !await this.deps.executionAuthorized(session, record.source.actorId))
      return "原 Session 的绑定或现行执行授权已失效。";
    return null;
  }
  async requireReply(principal: Principal, projectId: string, id: string): Promise<void> {
    const record = await this.deps.service.get(projectId, id);
    if (!record) throw new DomainError("NOT_FOUND", "Native input was not found");
    const reason = await this.replyReason(principal, record);
    if (reason) throw new DomainError("NATIVE_INPUT_UNAVAILABLE", reason);
  }
  async views(principal: Principal, projectId: string, sessionId: string): Promise<NativeInputView[]> {
    return Promise.all((await this.deps.service.list(projectId, sessionId, 20)).map(record => this.view(principal, record)));
  }
  async one(principal: Principal, projectId: string, id: string): Promise<NativeInputView> {
    const record = await this.deps.service.get(projectId, id);
    if (!record) throw new DomainError("NOT_FOUND", "Native input was not found");
    return this.view(principal, record);
  }
  private async view(principal: Principal, record: NativeInputRecord): Promise<NativeInputView> {
      const reason = await this.replyReason(principal, record);
      return { id: record.id, sessionId: record.sessionId, version: record.version, turnId: record.turnId,
        itemId: record.itemId, questions: record.questions, isBlocking: record.isBlocking, state: record.state,
        source: record.source, canReply: reason === null, reason, response: record.response,
        createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  async pump(projectId: string, sessions: RuntimeSessionRecord[]): Promise<void> {
    const runtime = this.runtime;
    const connectionId = runtime?.nativeInputConnectionId?.();
    if (!runtime?.respondToInput || !connectionId || !this.deps.canWrite()) return;
    for (const session of sessions) await this.deps.service.refreshSources(projectId, session.id);
    for (const record of await this.deps.service.pendingResponses(projectId, 20)) {
      if (!record.response) continue;
      if (!runtime.hasPendingInput?.(record.id, record.connectionId)) {
        await this.deps.service.closed(projectId, record.id, record.connectionId, "request_unavailable", this.deps.now());
        continue;
      }
      // Revalidate the signed respondent and current source grant before the one allowed send attempt.
      const principal = await this.deps.principal(projectId, record.response.actorId);
      const pending = { ...record, state: "pending" as const };
      if (!principal || await this.replyReason(principal, pending)) {
        await this.deps.service.closed(projectId, record.id, record.connectionId, "authorization_revoked", this.deps.now());
        continue;
      }
      const claimed = await this.deps.service.claimResponse(projectId, record.id, connectionId);
      if (!claimed?.response) continue;
      try {
        await runtime.respondToInput(claimed.id, connectionId, claimed.response.answers);
      } catch {
        await this.deps.service.finishResponse(projectId, claimed.id, connectionId, "unknown", this.deps.now());
        continue;
      }
      await this.deps.service.finishResponse(projectId, claimed.id, connectionId, "submitted", this.deps.now());
    }
  }
}
