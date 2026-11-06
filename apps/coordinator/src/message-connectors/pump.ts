import { createHash } from "node:crypto";
import type { ConnectorMessageLink, ConnectorRouteRecord, ConnectorSource,
  ConnectorTrustedAdmission } from "@evoloop/contracts/message-connectors";
import type { WechatGatewayClient } from "@evoloop/connector-wechat";

type Gateway = Pick<WechatGatewayClient, "call">;
type Row = Record<string, unknown>;
type DeliveryMessage = {eventCursor:number;messageId:string;messageState:string;processingState:string|null;
  nativeTurnId:string|null;response:string|null};
type DeliveryDecision = {projectId:string;bindingId:string;deliveryId:number;routeVersion:number;
  decision:'reply'|'draft'|'skip'|'defer';requestId:string|null;content:string|null;
  state:'prepared'|'attempted'|'observed'|'complete_unknown'|'completed'};
const object = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value);

/** Stable across process restarts and independent of the gateway's private claim token. */
function sourceId(source: ConnectorSource, purpose: string): string {
  const bytes = createHash("sha256").update(JSON.stringify([purpose, source.source.provider,
    source.source.connectionId, source.source.conversationId, source.deliveryId, source.eventCursor])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ConnectorIngressPumpDeps {
  gateway: Gateway;
  projects(): Promise<string[]>;
  routes: { list(projectId: string, limit: number, cursor?: string): Promise<{items: ConnectorRouteRecord[]; nextCursor: string | null}>;
    get(projectId: string, bindingId: string): Promise<ConnectorRouteRecord | null> };
  links: { admitTrusted(input: ConnectorTrustedAdmission): Promise<ConnectorMessageLink>;
    getBySource(projectId: string, source: ConnectorSource): Promise<ConnectorMessageLink | null> };
  decisions?: {messages(projectId:string,bindingId:string,deliveryId:number):Promise<DeliveryMessage[]>;
    transport(projectId:string,bindingId:string,deliveryId:number):Promise<{routeVersion:number;
      recordTurnId:string|null;finishStatus:'completed'|'interrupted'|'failed'|null}|null>;
    markReserve(projectId:string,bindingId:string,deliveryId:number,routeVersion:number):Promise<boolean>;
    markRecord(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,turnId:string):Promise<boolean>;
    markFinish(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,
      status:'completed'|'interrupted'|'failed'):Promise<boolean>;
    get(projectId:string,bindingId:string,deliveryId:number):Promise<DeliveryDecision|null>;
    prepare(input:Omit<DeliveryDecision,'state'>):Promise<DeliveryDecision>;
    markAttempted(input:DeliveryDecision):Promise<boolean>;markObserved(input:DeliveryDecision):Promise<void>;
    markCompleteUnknown(input:DeliveryDecision):Promise<void>;markCompleted(input:DeliveryDecision):Promise<void>};
  /** Both the coordinator lease and the explicit connector activation switch. */
  canWrite(): boolean;
  enabled(): Promise<boolean>;
  /** Must prove the exact restricted native receiver is isolated and qualified. Alpha.6 returns false. */
  qualifyReceiver(route: ConnectorRouteRecord): Promise<boolean>;
  pollIntervalMs: number;
  onError(error: unknown): void;
}

type Delivery = { id: number; start: number; end: number; cursor: number; routeVersion: number; finished: boolean };
const decidedFor = (rows: Array<Row | null>, delivery: Delivery, route: ConnectorRouteRecord): boolean => {
  const matches = rows.filter(row => row?.delivery_id === delivery.id);
  if (matches.length !== 1 || delivery.routeVersion !== route.version) return false;
  const row = matches[0]!;
  return row.owner === route.owner && row.epoch === route.epoch &&
    row.cursor_start === delivery.start && row.cursor_end === delivery.end &&
    (row.conversation_id === undefined || row.conversation_id === route.source.conversationId) &&
    ["replied", "skipped", "deferred", "draft"].includes(String(row.status));
};

/** Reads bounded wx pages into the original SessionMessage queue. It never starts a native Turn. */
export class ConnectorIngressPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private readonly uncertain = new Set<string>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly recovery = new Map<string, Delivery>();
  private readonly routeOffsets = new Map<string, string | undefined>();
  private nextProjectIndex = 0;
  constructor(private readonly deps: ConnectorIngressPumpDeps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick(): Promise<void> {
    if (this.stopped) return this.busy ?? Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.cycle().catch(this.deps.onError).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async live(): Promise<boolean> {
    return !this.stopped && this.deps.canWrite() && await this.deps.enabled()
      && !this.stopped && this.deps.canWrite();
  }
  private async exact(route: ConnectorRouteRecord): Promise<boolean> {
    if (!await this.live()) return false;
    const current = await this.deps.routes.get(route.projectId, route.bindingId);
    return await this.live() && !!current && current.state === "active" && current.version === route.version
      && current.source.provider === "wechat" && current.source.connectionId === route.source.connectionId
      && current.source.conversationId === route.source.conversationId && current.owner === route.owner
      && current.epoch === route.epoch && current.sessionRef === route.sessionRef
      && current.targetSessionId === route.targetSessionId && current.senderActorId === route.senderActorId
      && current.mode === route.mode && current.policyHash === route.policyHash
      && JSON.stringify(current.sendTargets) === JSON.stringify(route.sendTargets)
      && JSON.stringify(current.internalTargets) === JSON.stringify(route.internalTargets);
  }
  private async cycle(): Promise<void> {
    if (!await this.live()) return;
    const projects = await this.deps.projects();
    if (!projects.length) return;
    const start = this.nextProjectIndex % projects.length;
    this.nextProjectIndex = (start + 1) % projects.length;
    let visited = 0;
    for (const projectId of [...projects.slice(start), ...projects.slice(0, start)]) {
      if (!await this.live() || visited >= 20) return;
      const cursor = this.routeOffsets.get(projectId);
      const page = await this.deps.routes.list(projectId, 20 - visited, cursor);
      this.routeOffsets.set(projectId, page.nextCursor ?? undefined);
      for (const route of page.items) {
        if (!await this.live()) return;
        visited++;
        if (route.state !== "active" || route.source.provider !== "wechat" || !route.capabilities.subscribe) continue;
        try { await this.ingest(route); }
        catch (error) {
          // The next tick only reads original wx/PG evidence; it cannot claim again.
          this.uncertain.add(route.bindingId);
          this.deps.onError(error);
        }
      }
    }
  }
  private async read(method: "binding" | "inbox_status" | "inbox_claim" | "inbox_show" | "events" | "transport_status",
    params: {conversation_id: string; delivery_id?: number; after?: number; limit?: number}): Promise<Row> {
    const outcome = await this.deps.gateway.call(method, params as never);
    if (outcome.state !== "ok") throw new Error(`wx ingress ${method} ${outcome.state}`);
    return outcome.result;
  }
  private async ingest(route: ConnectorRouteRecord): Promise<void> {
    if (!await this.exact(route)) return;
    if (!await this.deps.qualifyReceiver(route) || !await this.live()) return;
    const conversation_id = route.source.conversationId;
    const binding = await this.read("binding", {conversation_id});
    if (binding.conversation_id !== conversation_id || binding.control !== "active"
        || binding.owner !== route.owner || binding.epoch !== route.epoch
        || binding.owner_session_ref !== null && binding.owner_session_ref !== route.sessionRef) return;
    if (!await this.exact(route) || !await this.deps.qualifyReceiver(route) || !await this.live()) return;
    const status = await this.read("inbox_status", {conversation_id});
    if (status.conversation_id !== conversation_id || status.owner !== route.owner
        || status.epoch !== route.epoch || !Array.isArray(status.deliveries))
      throw new Error("wx ingress status identity is unconfirmed");
    const rows = status.deliveries.map(object);
    if (rows.some(row => !row)) throw new Error("wx ingress status contains an invalid delivery");
    if(route.mode==='standard'&&this.deps.decisions){
      for(const row of rows){
        if(!positive(row?.delivery_id)||!['replied','skipped','deferred','draft'].includes(String(row.status))||
          row.owner!==route.owner||row.epoch!==route.epoch)continue;
        const saved=await this.deps.decisions.get(route.projectId,route.bindingId,row.delivery_id);
        if(saved&&saved.state==='complete_unknown'&&saved.routeVersion===route.version)
          await this.deps.decisions.markCompleted(saved);
      }
    }
    const claimed = rows.filter(row => row?.status === "claimed");
    if (claimed.length > 1) throw new Error("wx ingress has multiple unresolved claimed deliveries");
    const prior = this.deliveries.get(route.bindingId);
    const claimedRow = claimed[0];
    if (this.uncertain.has(route.bindingId)) {
      if (claimedRow) {
        await this.reconcile(route, claimedRow);
        if(route.mode==='standard'&&prior?.finished)await this.settle(route,prior);
      }
      else if (prior) {
        if (decidedFor(rows, prior, route)) {
          // The original wx decision, rather than a timeout or absent row,
          // releases this in-process uncertainty for a later tick.
          this.deliveries.delete(route.bindingId);
          this.uncertain.delete(route.bindingId);
        }
      }
      return;
    }
    if (prior && prior.routeVersion !== route.version) {
      this.uncertain.add(route.bindingId);
      if (claimedRow) await this.reconcile(route, claimedRow);
      return;
    }
    if (claimedRow) {
      if (!prior || prior.id !== claimedRow.delivery_id || prior.start !== claimedRow.cursor_start
          || prior.end !== claimedRow.cursor_end) {
        if(route.mode==='standard'&&!prior&&positive(claimedRow.delivery_id)&&
          positive(claimedRow.cursor_start)&&positive(claimedRow.cursor_end)){
          const restored:Delivery={id:claimedRow.delivery_id,start:claimedRow.cursor_start,
            end:claimedRow.cursor_end,cursor:claimedRow.cursor_start-1,routeVersion:route.version,finished:false};
          this.deliveries.set(route.bindingId,restored);
          await this.processDelivery(route,restored);
          if(restored.finished)await this.settle(route,restored);
          return;
        }
        this.uncertain.add(route.bindingId);
        await this.reconcile(route, claimedRow);
        return;
      }
      if (prior.finished) { if(route.mode==="standard")await this.settle(route,prior); return; }
      await this.processDelivery(route, prior);
      if(prior.finished&&route.mode==="standard")await this.settle(route,prior);
      return;
    }
    if (prior) {
      if (!decidedFor(rows, prior, route)) {
        this.uncertain.add(route.bindingId);
        return;
      }
      this.deliveries.delete(route.bindingId);
      const decision=await this.deps.decisions?.get(route.projectId,route.bindingId,prior.id);
      if(decision)await this.deps.decisions!.markCompleted(decision);
      return; // Observe the decision before a later tick can consider another claim.
    }
    const pending = rows.find(row => row?.status === "pending");
    if (!pending || !await this.exact(route) || !await this.deps.qualifyReceiver(route) || !await this.live()) return;
    const claim = await this.read("inbox_claim", {conversation_id});
    if (claim.status !== "claimed" || !positive(claim.delivery_id)
        || claim.delivery_id !== pending.delivery_id || claim.owner !== route.owner || claim.epoch !== route.epoch
        || !positive(claim.cursor_start) || !positive(claim.cursor_end)
        || claim.cursor_start !== pending.cursor_start || claim.cursor_end !== pending.cursor_end
        || claim.cursor_end < claim.cursor_start) throw new Error("wx ingress claim identity is unconfirmed");
    const delivery: Delivery = {id: claim.delivery_id, start: claim.cursor_start, end: claim.cursor_end,
      cursor: claim.cursor_start - 1, routeVersion: route.version, finished: false};
    this.deliveries.set(route.bindingId, delivery);
    await this.processDelivery(route, delivery);
    if(delivery.finished&&route.mode==="standard")await this.settle(route,delivery);
  }
  private async shown(route: ConnectorRouteRecord, delivery: Delivery): Promise<Row> {
    const result = await this.read("inbox_show", {conversation_id: route.source.conversationId, delivery_id: delivery.id});
    if (result.delivery_id !== delivery.id || result.conversation_id !== route.source.conversationId
        || result.owner !== route.owner || result.epoch !== route.epoch || result.status !== "claimed"
        || result.session_ref !== null && result.session_ref !== route.sessionRef
        || result.cursor_start !== delivery.start || result.cursor_end !== delivery.end)
      throw new Error("wx ingress original delivery identity changed");
    return result;
  }
  private async processDelivery(route: ConnectorRouteRecord, delivery: Delivery): Promise<void> {
    const shown = await this.shown(route, delivery);
    if (route.mode === "standard") await this.reserve(route, delivery, shown);
    for (let pageNumber = 0; pageNumber < 10 && !delivery.finished; pageNumber++) {
      if (!await this.exact(route) || !await this.deps.qualifyReceiver(route) || !await this.live()) return;
      const page = await this.read("events", {conversation_id: route.source.conversationId,
        delivery_id: delivery.id, after: delivery.cursor, limit: 30});
      if (page.delivery_id !== delivery.id || page.conversation_id !== route.source.conversationId
          || !Array.isArray(page.events) || page.events.length > 30 || typeof page.has_more !== "boolean")
        throw new Error("wx ingress event page is unconfirmed");
      if (page.events.length === 0 && page.has_more) throw new Error("wx ingress delivery cursor made no progress");
      for (const value of page.events) {
        const event = object(value);
        if (!event || !positive(event.cursor) || event.cursor !== delivery.cursor + 1 || event.cursor > delivery.end)
          throw new Error("wx ingress event cursor escaped the frozen delivery");
        if (event.kind === "message_observed" && event.direction === "incoming"
            && !await this.admitEvent(route, delivery, event)) return;
        delivery.cursor = event.cursor;
      }
      if (page.next_cursor !== delivery.cursor || page.has_more !== (delivery.cursor < delivery.end))
        throw new Error("wx ingress page end differs from frozen delivery");
      delivery.finished = !page.has_more;
    }
  }
  /** Inspect the original delivery before the one transport reservation. Unknown stays on this delivery. */
  private async reserve(route: ConnectorRouteRecord, delivery: Delivery, shown: Row): Promise<void> {
    const store=this.deps.decisions;
    if(!store)throw new Error("Durable Connector transport attempts are unavailable");
    const conversation_id=route.source.conversationId;
    const status=await this.read("transport_status", {conversation_id});
    if (status.conversation_id!==conversation_id || !Array.isArray(status.deliveries))
      throw new Error("wx transport status is unconfirmed");
    const matches=status.deliveries.map(object).filter(row=>row?.delivery_id===delivery.id);
    if (matches.length>1) throw new Error("wx transport delivery is duplicated");
    const attempt=await store.transport(route.projectId,route.bindingId,delivery.id);
    if(attempt&&attempt.routeVersion!==route.version)throw new Error("wx original transport route changed");
    if (matches.length===1) {
      const row=matches[0]!;
      if(row.owner!==route.owner||row.epoch!==route.epoch||row.session_ref!==route.sessionRef||
        row.conversation_id!==conversation_id||!['reserved','recorded'].includes(String(row.turn_state)))
        throw new Error("wx transport reservation changed identity");
      if(!attempt)await store.markReserve(route.projectId,route.bindingId,delivery.id,route.version);
      return;
    }
    if(attempt)throw new Error("wx original reserve attempt is unresolved; inspect its delivery");
    if(typeof shown.token!=="string"||!shown.token)throw new Error("wx claim token is unavailable");
    if(!await store.markReserve(route.projectId,route.bindingId,delivery.id,route.version))
      throw new Error("wx original reserve was attempted concurrently; read original status");
    const outcome=await this.deps.gateway.call("reserve_turn", {conversation_id,delivery_id:delivery.id,token:shown.token});
    if(outcome.state!=="ok"||outcome.result.delivery_id!==delivery.id)
      throw new Error(`wx transport reserve ${outcome.state}; reconcile original delivery`);
  }
  private async settle(route:ConnectorRouteRecord,delivery:Delivery):Promise<void>{
    const store=this.deps.decisions;
    if(!store||!await this.exact(route)||!await this.live())return;
    const messages=await store.messages(route.projectId,route.bindingId,delivery.id);
    if(messages.some(message=>!['replied','completed_without_reply','failed','cancelled'].includes(message.messageState)))return;
    const shown=await this.shown(route,delivery);
    const conversation_id=route.source.conversationId;
    const transport=await this.read("transport_status",{conversation_id});
    const rows=Array.isArray(transport.deliveries)?transport.deliveries.map(object):[];
    const row=rows.find(value=>value?.delivery_id===delivery.id);
    if(row&&(row.owner!==route.owner||row.epoch!==route.epoch||row.session_ref!==route.sessionRef||
      row.conversation_id!==conversation_id||typeof row.transport_token!=="string"))
      throw new Error("wx transport changed identity before finish");
    const attempt=await store.transport(route.projectId,route.bindingId,delivery.id);
    if(!attempt||attempt.routeVersion!==route.version)
      throw new Error("wx original transport attempt is unavailable");
    if(shown.turn_state==='reserved'&&row?.turn_state==='reserved'){
      const representative=messages.find(value=>value.nativeTurnId);
      if(representative?.nativeTurnId){
        if(attempt.recordTurnId){
          if(attempt.recordTurnId!==representative.nativeTurnId)throw new Error("wx original recorded Turn changed");
          return; // Unknown record result is read from transport status; never replay it.
        }
        if(!await store.markRecord(route.projectId,route.bindingId,delivery.id,route.version,
          representative.nativeTurnId))return;
        const recorded=await this.deps.gateway.call("record_turn",{conversation_id,delivery_id:delivery.id,
          token:row.transport_token as string,turn_id:representative.nativeTurnId});
        if(recorded.state!=="ok")throw new Error(`wx record original Turn ${recorded.state}`);
        return; // Read back the pinned Turn before finishing it.
      }
      if(attempt.finishStatus)return;
      if(!await store.markFinish(route.projectId,route.bindingId,delivery.id,route.version,'failed'))return;
      const failed=await this.deps.gateway.call("finish_turn",{conversation_id,delivery_id:delivery.id,
        token:row.transport_token as string,status:'failed'});
      if(failed.state!=="ok")throw new Error(`wx finish unstarted delivery ${failed.state}`);
      return;
    }
    if(shown.turn_state==='recorded'&&row?.turn_state==='recorded'){
      const failed=messages.some(value=>value.messageState==='failed'||value.messageState==='cancelled');
      const status=failed?'failed':'completed';
      if(attempt.finishStatus){
        if(attempt.finishStatus!==status)throw new Error("wx original finish status changed");
        return;
      }
      if(!await store.markFinish(route.projectId,route.bindingId,delivery.id,route.version,status))return;
      const finished=await this.deps.gateway.call("finish_turn",{conversation_id,delivery_id:delivery.id,
        token:row.transport_token as string,status});
      if(finished.state!=="ok")throw new Error(`wx finish original Turn ${finished.state}`);
      return; // The terminal transport state is read from the original inbox row.
    }
    if(!['completed','interrupted','failed'].includes(String(shown.turn_state)))return;
    let decision=await store.get(route.projectId,route.bindingId,delivery.id);
    if(!decision){
      const response=messages.map(value=>value.response?.trim()).filter((value):value is string=>!!value).join("\n\n");
      const failed=messages.some(value=>value.messageState==='failed'||value.messageState==='cancelled');
      const canSend=route.capabilities.sendText&&route.sendTargets.includes(conversation_id);
      const bytes=Buffer.byteLength(response,'utf8');
      const sendable=Array.from(response).length<=2000&&bytes<=16000&&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(response);
      const action=failed||bytes>65536?'defer':response?(canSend&&sendable?'reply':'draft'):'skip';
      const requestId=action==='reply'?`ev${createHash('sha256').update(JSON.stringify([
        route.bindingId,delivery.id,route.version])).digest('hex').slice(0,48)}`:null;
      decision=await store.prepare({projectId:route.projectId,bindingId:route.bindingId,
        deliveryId:delivery.id,routeVersion:route.version,decision:action,requestId,
        content:action==='reply'||action==='draft'?response:null});
    }
    if(decision.state==='completed'||decision.state==='complete_unknown')return;
    if(decision.decision==='reply'){
      if(!decision.requestId||!decision.content)throw new Error("wx original send intent is incomplete");
      if(decision.state==='prepared'&&await store.markAttempted(decision)){
        const sent=await this.deps.gateway.call("send_text",{conversation_id,request_id:decision.requestId,
          text:decision.content});
        if(sent.state==='ok'&&['pending','ui_observed','recipient_confirmed'].includes(String(sent.result.status)))
          await store.markObserved(decision);
        else throw new Error(`wx send ${sent.state}; inspect original request ${decision.requestId}`);
        return;
      }
      const result=await this.deps.gateway.call("result",{conversation_id,request_id:decision.requestId});
      if(result.state!=="ok")return; // No new request ID or send attempt after an unknown result.
      if(!['pending','ui_observed','recipient_confirmed'].includes(String(result.result.status)))
        throw new Error(`wx original request ${decision.requestId} has no sendable result`);
      await store.markObserved(decision);
      if(decision.state==='attempted')return;
    }
    if(typeof shown.token!=="string"||!shown.token)throw new Error("wx original claim token is unavailable");
    const params=decision.decision==='reply'
      ? {conversation_id,delivery_id:delivery.id,token:shown.token,decision:'reply' as const,request_id:decision.requestId!}
      : decision.decision==='draft'
        ? {conversation_id,delivery_id:delivery.id,token:shown.token,decision:'draft' as const,text:decision.content!}
        : decision.decision==='defer'
          ? {conversation_id,delivery_id:delivery.id,token:shown.token,decision:'defer' as const,
            reason:'One or more native messages failed; review the saved processing records'}
          : {conversation_id,delivery_id:delivery.id,token:shown.token,decision:'skip' as const,
            reason:'No reply text was produced by the native Session'};
    const completed=await this.deps.gateway.call("complete",params);
    await store.markCompleteUnknown(decision);
    if(completed.state!=="ok")throw new Error(`wx complete ${completed.state}; inspect original delivery`);
  }
  private async admitEvent(route: ConnectorRouteRecord, delivery: Delivery, event: Row): Promise<boolean> {
    const message = object(event.message), content = object(message?.content);
    const body = content?.Text;
    if (typeof body !== "string" || !body.trim() || body.length > 16000) return true;
    const source: ConnectorSource = {source: route.source, deliveryId: delivery.id, cursorStart: delivery.start,
      cursorEnd: delivery.end, eventCursor: event.cursor as number,
      participantId: key(message?.sender) ? message.sender : null, replyToEventCursor: null};
    const input: ConnectorTrustedAdmission = {projectId: route.projectId, bindingId: route.bindingId,
      routeVersion: route.version, source, messageId: sourceId(source, "message"),
      messageOperationId: sourceId(source, "operation"), decisionId: sourceId(source, "decision"),
      content: body, gateway: {owner: route.owner, epoch: route.epoch, sessionRef: route.sessionRef}};
    if (!await this.exact(route) || !await this.deps.qualifyReceiver(route) || !await this.live()) return false;
    const prior = await this.deps.links.getBySource(route.projectId, source);
    if (prior) {
      if (prior.messageId !== input.messageId || prior.messageOperationId !== input.messageOperationId)
        throw new Error("wx ingress source already belongs to another message");
      return true;
    }
    if (!await this.exact(route) || !await this.live()) return false;
    await this.deps.links.admitTrusted(input);
    return true;
  }
  /** After a restart or unknown result, read the original wx delivery and PG links only. */
  private async reconcile(route: ConnectorRouteRecord, row: Row): Promise<void> {
    if (!positive(row.delivery_id) || !positive(row.cursor_start) || !positive(row.cursor_end)
        || row.owner !== route.owner || row.epoch !== route.epoch) return;
    const saved = this.recovery.get(route.bindingId);
    const delivery: Delivery = saved?.id === row.delivery_id && saved.start === row.cursor_start
      && saved.end === row.cursor_end && saved.routeVersion === route.version ? saved
      : {id: row.delivery_id, start: row.cursor_start, end: row.cursor_end,
        cursor: row.cursor_start - 1, routeVersion: route.version, finished: false};
    this.recovery.set(route.bindingId, delivery);
    await this.shown(route, delivery);
    for (let pageNumber = 0; pageNumber < 10 && !delivery.finished; pageNumber++) {
      const page = await this.read("events", {conversation_id: route.source.conversationId,
        delivery_id: delivery.id, after: delivery.cursor, limit: 30});
      if (!Array.isArray(page.events) || !page.events.length || page.delivery_id !== delivery.id) return;
      for (const value of page.events) {
        const event = object(value);
        if (!event || !positive(event.cursor) || event.cursor !== delivery.cursor + 1 || event.cursor > delivery.end) return;
        if (event.kind === "message_observed" && event.direction === "incoming") {
          const message = object(event.message);
          const source: ConnectorSource = {source: route.source, deliveryId: delivery.id,
            cursorStart: delivery.start, cursorEnd: delivery.end, eventCursor: event.cursor,
            participantId: key(message?.sender) ? message.sender : null, replyToEventCursor: null};
          await this.deps.links.getBySource(route.projectId, source);
        }
        delivery.cursor = event.cursor;
      }
      delivery.finished = page.has_more === false;
    }
  }
}
