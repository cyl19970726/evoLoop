import { createHash, randomUUID } from "node:crypto";
import type { Principal, TaskDetail } from "@evoloop/contracts";
import type { CollaborationConnector, IncomingChangeCandidate, ProjectionIntent, RemoteTaskRecord } from "@evoloop/contracts/collaboration";
import type { DeliveryRecord, DeliveryStore, IncomingRecord, ProjectionStatus } from "@evoloop/contracts/delivery";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();
const reason = (error: unknown) => error instanceof Error ? error.message.slice(0,500) : "connector outcome unknown";

/** Project-scoped outbox consumer. PG claims fence local workers; remote effects need stable-key readback. */
export class CollaborationRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private readonly ownerId = randomUUID();
  private readonly verified = new Map<string,string>();
  private readonly errors = new Map<string,string>();
  private readonly nextPoll = new Map<string,number>();
  constructor(private readonly deps: {
    store: DeliveryStore; workflow: WorkflowService; connector: CollaborationConnector | null;
    consumerId: string; principals: Principal[]; canWrite(): boolean;
    /** Current project/actor integration authorization. Omission denies remote access. */
    hasGrant?: (projectId: string, actorId: string) => boolean;
    allowProjection(projectId: string, principal: Principal, task: TaskDetail): Promise<boolean>;
    /** Omit to disable automatic remote polling; explicit reviewer poll remains available. */
    pollIntervalMs?: number;
  }) {
    if (deps.pollIntervalMs !== undefined && (!Number.isSafeInteger(deps.pollIntervalMs) || deps.pollIntervalMs < 30000)) throw new RangeError("poll interval must be at least 30 seconds");
  }
  private principal(projectId: string): Principal | null {
    return this.deps.principals.find(p => p.projectIds.includes(projectId) && p.permissions.includes("read") &&
      p.permissions.includes("write") && this.hasGrant(projectId,p.actorId)) ?? null;
  }
  private hasGrant(projectId: string, actorId: string): boolean { return this.deps.hasGrant?.(projectId,actorId) === true; }
  private projects(): string[] { return [...new Set(this.deps.principals.flatMap(p=>p.projectIds))].filter(id=>this.principal(id)!==null); }
  status(projectId: string): Pick<ProjectionStatus,"configured"|"verifiedAtUtc"|"error"> {
    const configured = this.deps.connector !== null && this.principal(projectId)!==null;
    return { configured, verifiedAtUtc: configured ? this.verified.get(projectId) ?? null : null,
      error: !this.deps.connector ? "notConfigured: Feishu credentials and table mapping are absent" :
        !configured ? "notAuthorized: project/actor integration grant is absent" : this.errors.get(projectId) ?? null };
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error("collaboration runner stopped");
    for (const projectId of this.projects()) await this.deps.store.recoverInterrupted(projectId,this.deps.consumerId,now());
    await this.pump();
    this.timer = setInterval(() => { void this.pump().catch(error => { for (const projectId of this.projects()) this.errors.set(projectId,reason(error)); }); },2000); this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.busy) await this.busy;
  }
  async pump(): Promise<void> {
    if (this.stopped || !this.deps.connector || !this.deps.canWrite()) return;
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async run(): Promise<void> {
    for (const projectId of this.projects()) {
      if (this.stopped || !this.deps.canWrite()) return;
      if (!this.principal(projectId)) continue;
      await this.deps.store.recoverInterrupted(projectId,this.deps.consumerId,now());
      for (let n=0;n<10 && !this.stopped && this.deps.canWrite() && this.principal(projectId);n++) {
        const claim = await this.deps.store.claimNext(projectId,this.deps.consumerId,this.ownerId,now(),300000);
        if (!claim) break;
        await this.dispatch(claim.delivery,claim.token);
      }
      const reviewer=this.deps.principals.find(p=>p.projectIds.includes(projectId)&&p.permissions.includes("read")&&p.permissions.includes("write")&&p.permissions.includes("review")&&this.hasGrant(projectId,p.actorId));
      if (!this.stopped && reviewer && this.deps.pollIntervalMs && Date.now()>=(this.nextPoll.get(projectId)??0) && this.deps.canWrite()) {
        this.nextPoll.set(projectId,Date.now()+this.deps.pollIntervalMs);
        try { await this.pollIncoming(reviewer,projectId); }
        catch(error) { this.errors.set(projectId,reason(error)); }
      }
    }
  }
  private async intent(delivery: DeliveryRecord): Promise<{ intent: ProjectionIntent; task: TaskDetail; principal: Principal } | null> {
    const principal = this.principal(delivery.projectId);
    if (!principal) return null;
    try {
      const task = await this.deps.workflow.getTask(principal,delivery.projectId,delivery.taskId);
      if (task.task.version !== delivery.taskVersion || !await this.deps.allowProjection(delivery.projectId,principal,task)) return null;
      return { task, principal, intent: { entityId:delivery.taskId,localVersion:delivery.taskVersion,
        operationId:delivery.operationId,title:task.task.title,status:task.task.state,deliveryState:"not-sent" } };
    } catch { return null; }
  }
  private async dispatch(delivery: DeliveryRecord, token: string): Promise<void> {
    const claim = { delivery,token };
    const prepared = await this.intent(delivery);
    if (!this.deps.canWrite() || !await this.deps.store.beginDispatch(claim,"coordinator",now())) return;
    if (!prepared || this.stopped || !this.deps.canWrite() || !this.hasGrant(delivery.projectId,prepared.principal.actorId)) {
      await this.deps.store.finish(claim,{state:"conflict",reason:"Task revision or current projection authority changed"},"coordinator",now(),"dispatch");
      return;
    }
    const binding = await this.deps.store.getBinding(delivery.projectId,delivery.taskId,delivery.consumerId);
    if (this.stopped || !this.deps.canWrite() || !this.hasGrant(delivery.projectId,prepared.principal.actorId)) {
      await this.deps.store.finish(claim,{state:"conflict",reason:"Project integration grant was withdrawn"},prepared.principal.actorId,now(),"dispatch");
      return;
    }
    const observation = await this.deps.connector!.project(prepared.intent,binding).catch(error => ({ state:"unknown" as const,reason:reason(error) }));
    const saved = await this.deps.store.finish(claim,observation,prepared.principal.actorId,now(),"dispatch");
    if (saved?.state === "applied") { this.verified.set(delivery.projectId,now()); this.errors.delete(delivery.projectId); }
    else if (saved) this.errors.set(delivery.projectId,saved.lastReason ?? saved.state);
  }
  async reconcile(principal: Principal, projectId: string, eventId: string): Promise<DeliveryRecord | null> {
    this.requireReviewer(principal,projectId);
    if (!this.deps.connector || !this.deps.canWrite()) throw new Error("connector not configured or coordinator lease unavailable");
    const claim = await this.deps.store.claimUnknown(projectId,eventId,this.deps.consumerId,this.ownerId,now(),300000);
    if (!claim) return this.deps.store.get(projectId,eventId,this.deps.consumerId);
    if (!await this.deps.store.beginDispatch(claim,principal.actorId,now())) return null;
    const prepared = await this.intent(claim.delivery);
    if (!prepared) return this.deps.store.finish(claim,{state:"conflict",reason:"Task revision or projection authority changed before reconciliation"},principal.actorId,now(),"reconcile");
    const binding = await this.deps.store.getBinding(projectId,claim.delivery.taskId,this.deps.consumerId);
    if (!this.deps.canWrite() || !this.hasGrant(projectId,principal.actorId)) {
      return this.deps.store.finish(claim,{state:"conflict",reason:"Project integration grant was withdrawn"},principal.actorId,now(),"reconcile");
    }
    const observation = await this.deps.connector.reconcile({...prepared.intent,deliveryState:"unknown"},binding).catch(error=>({state:"unknown" as const,reason:reason(error)}));
    const saved = await this.deps.store.finish(claim,observation,principal.actorId,now(),"reconcile");
    if (saved?.state === "applied") this.verified.set(projectId,now());
    return saved;
  }
  async retry(principal: Principal, projectId: string, eventId: string, retryReason: string): Promise<boolean> {
    this.requireReviewer(principal,projectId);
    if (!retryReason.trim() || !this.deps.canWrite()) throw new Error("retry reason and coordinator lease required");
    return this.deps.store.requestRetry(projectId,eventId,this.deps.consumerId,principal.actorId,retryReason,now());
  }
  private requireReviewer(principal: Principal, projectId: string): void {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read") || !principal.permissions.includes("write") || !principal.permissions.includes("review") || !this.hasGrant(projectId,principal.actorId)) throw new DomainError("FORBIDDEN","project review and current integration grant required");
  }
  /** Bounded full remote scan. Polling supplies no verified external actor; candidates stay review-only. */
  async pollIncoming(principal: Principal, projectId: string): Promise<number> {
    this.requireReviewer(principal,projectId);
    if (!this.deps.connector || !this.deps.canWrite()) throw new Error("connector not configured or coordinator lease unavailable");
    const remote = new Map<string,RemoteTaskRecord>(); let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page=0;page<20;page++) {
      if (!this.deps.canWrite() || !this.hasGrant(projectId,principal.actorId)) throw new Error("coordinator lease or integration grant lost during remote scan");
      const result = await this.deps.connector.listRemote(cursor);
      for (const record of result.records) remote.set(record.recordId,record);
      if (!result.nextCursor) { cursor=undefined; break; }
      if (seen.has(result.nextCursor)) throw new Error("remote pagination cursor repeated");
      seen.add(result.nextCursor); cursor=result.nextCursor;
    }
    if (cursor) throw new Error("remote scan incomplete; deletion cannot be inferred");
    this.verified.set(projectId,now()); this.errors.delete(projectId);
    let count = 0;
    for (const record of remote.values()) {
      if (!this.deps.canWrite() || !this.hasGrant(projectId,principal.actorId)) throw new Error("coordinator lease or integration grant lost while recording candidates");
      if (!record.entityId || !uuid.test(record.entityId)) continue;
      const binding = await this.deps.store.getBinding(projectId,record.entityId,this.deps.consumerId);
      const candidate: IncomingChangeCandidate = binding
        ? this.deps.connector.incoming(record,binding,null)
        : { entityId:record.entityId,remoteRecordId:record.recordId,observedLocalVersion:record.localVersion ?? 1,
          observedRemoteOperationId:record.operationId ?? "",observedRemoteModifiedTime:record.modifiedTime,actor:null,patch:{},reviewOnly:true,reason:"remote record has no confirmed local binding" };
      if (binding && !candidate.reviewOnly && !Object.keys(candidate.patch).length) continue;
      if (binding && candidate.reason === "self projection or no supported change") continue;
      try { await this.deps.workflow.getTask(principal,projectId,candidate.entityId); }
      catch { continue; }
      const sourceEventId = `poll:${record.recordId}:${digest(JSON.stringify(record))}`;
      if (!this.hasGrant(projectId,principal.actorId)) throw new Error("integration grant lost before incoming candidate write");
      await this.deps.store.recordIncoming(projectId,this.deps.consumerId,candidate,sourceEventId,now()); count++;
    }
    let after: string | undefined;
    for (let page=0;page<20;page++) {
      if (!this.deps.canWrite() || !this.hasGrant(projectId,principal.actorId)) throw new Error("coordinator lease or integration grant lost while checking remote deletions");
      const bindings = await this.deps.store.listBindings(projectId,this.deps.consumerId,100,after);
      for (const binding of bindings.items) if (!remote.has(binding.remoteRecordId)) {
        const candidate: IncomingChangeCandidate = { entityId:binding.entityId,remoteRecordId:binding.remoteRecordId,observedLocalVersion:binding.localVersion,
          observedRemoteOperationId:binding.remoteOperationId,observedRemoteModifiedTime:binding.remoteModifiedTime,actor:null,patch:{},reviewOnly:true,reason:"confirmed remote record missing from complete scan" };
        if (!this.hasGrant(projectId,principal.actorId)) throw new Error("integration grant lost before incoming candidate write");
        await this.deps.store.recordIncoming(projectId,this.deps.consumerId,candidate,`missing:${binding.remoteRecordId}:${binding.localVersion}`,now()); count++;
      }
      if (!bindings.nextCursor) { after=undefined; break; }
      after=bindings.nextCursor;
    }
    if (after) throw new Error("binding scan incomplete; deletion candidates may be missing");
    return count;
  }
  /** Fresh bounded read before a reviewer turns a remote proposal into a Task command. */
  async verifyIncomingCandidate(candidate: IncomingRecord, principal: Principal): Promise<boolean> {
    this.requireReviewer(principal,candidate.projectId);
    if (!this.deps.connector || !this.deps.canWrite()) return false;
    let cursor: string | undefined; const seen=new Set<string>();
    for(let page=0;page<20;page++) {
      if (!this.deps.canWrite() || !this.hasGrant(candidate.projectId,principal.actorId)) return false;
      const result=await this.deps.connector.listRemote(cursor);
      if (!this.deps.canWrite() || !this.hasGrant(candidate.projectId,principal.actorId)) return false;
      const record=result.records.find(item=>item.recordId===candidate.remoteRecordId);
      if(record) return record.entityId===candidate.entityId && record.localVersion===candidate.observedLocalVersion
        && record.operationId===candidate.observedRemoteOperationId && record.modifiedTime===candidate.observedRemoteModifiedTime
        && (candidate.patch.title===undefined || record.title===candidate.patch.title)
        && (candidate.patch.status===undefined || record.status===candidate.patch.status);
      if(!result.nextCursor)return false;
      if(seen.has(result.nextCursor))return false;
      seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    return false;
  }
}
