import type { Principal } from "@evoloop/contracts";
import type { DirectInputCommand, DirectInputGrant, DirectInputReceipt, DirectInputRecord, DirectInputCapability } from "@evoloop/contracts/direct-input";
import { publicDirectInput } from "@evoloop/contracts/direct-input";
import type { RuntimeBinding, RuntimeCapabilities, RuntimePage, RuntimeTurn } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeLocalBusyError, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/adapter-codex-app-server";
import type { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import { SessionSteerLock } from "../runtime/session-steer-lock.js";

type Native = {
  isReady():boolean;
  capabilities?():RuntimeCapabilities;
  capabilitiesFor?(binding:RuntimeBinding):RuntimeCapabilities;
  registerBinding(binding:RuntimeBinding):Promise<void>;
  qualifyConversationThread(binding:RuntimeBinding):Promise<{available:boolean;reason:string;fingerprint:string|null}>;
  startConversationTurn(binding:RuntimeBinding,input:string,operationId:string):Promise<RuntimeTurn>;
  steerTurn(binding:RuntimeBinding,expectedTurnId:string,input:string,inputId:string):Promise<{turnId:string;itemId:string|null}>;
  listTurns(binding:RuntimeBinding,cursor?:string):Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding:RuntimeBinding,turnId:string,cursor?:string):Promise<RuntimePage<unknown>>;
};
/** Narrow runtime adapter check at the shared composition edge. */
export function requireDirectInputRuntime(value:unknown):Native{
  const native=value as Partial<Native>|null;
  if(!native||typeof native.isReady!=="function"||typeof native.registerBinding!=="function"||
    typeof native.capabilities!=="function"&&typeof native.capabilitiesFor!=="function"||
    typeof native.qualifyConversationThread!=="function"||typeof native.startConversationTurn!=="function"||
    typeof native.steerTurn!=="function"||typeof native.listTurns!=="function"||
    typeof native.listItems!=="function")
    throw new DomainError("DIRECT_RUNTIME_UNAVAILABLE","Owned direct input adapter is unavailable");
  return native as Native;
}
const marker=(operationId:string)=>`[evoloop-message-operation:${operationId}]`;
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const textOf=(item:unknown):string=>{
  const x=object(item);if(typeof x?.text==="string")return x.text;
  return Array.isArray(x?.content)?x.content.map(part=>object(part)?.text).filter(x=>typeof x==="string").join("\n"):"";
};
export interface DirectInputServiceDeps {
  store:PgDirectInputs; runtime():Native; canWrite():boolean;
  /** Shared with the ordinary-message pump; omitted only by isolated callers and tests. */
  lock?:SessionSteerLock;
  /** Re-reads the current direct grant, writer identities and Session execution authority. */
  admission(principal:Principal,projectId:string,sessionId:string):Promise<{grant:DirectInputGrant;binding:RuntimeBinding}>;
  /** Existing owned binding for read-only reconciliation; a revoked sender grant cannot erase prior evidence. */
  bindingFor(projectId:string,sessionId:string):Promise<RuntimeBinding>;
  /** Records the requested effort beside the one the Thread reported for the started Turn. Best effort. */
  observeEffort?(projectId:string,sessionId:string,inputId:string,turn:RuntimeTurn,requested:string|null):Promise<void>;
}

/** The HTTP caller never controls the native binding, source or mode. */
export class DirectInputService {
  private readonly lock:SessionSteerLock;
  /** Inputs the adapter proved were never handed to the transport; the same ID may be sent again. */
  private readonly provedUnsent = new Set<string>();
  constructor(private readonly deps:DirectInputServiceDeps){
    this.lock=deps.lock??new SessionSteerLock();
  }
  async capability(principal:Principal,projectId:string,sessionId:string):Promise<DirectInputCapability>{
    const result=(available:boolean,mode:DirectInputCapability["mode"],expectedTurnId:string|null,reasonCode:string,detail?:string):DirectInputCapability=>
      ({available,mode,expectedTurnId,reasonCode,observedAt:new Date().toISOString(),...(detail?{detail}:{})});
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read")||
      !principal.permissions.includes("write"))return result(false,null,null,"FORBIDDEN");
    let runtime:Native;
    try{runtime=this.deps.runtime();if(!this.deps.canWrite()||!runtime.isReady())
      return result(false,null,null,"NATIVE_UNAVAILABLE");}
    catch{return result(false,null,null,"NATIVE_UNAVAILABLE");}
    let grant:DirectInputGrant,binding:RuntimeBinding;
    try{({grant,binding}=await this.deps.admission(principal,projectId,sessionId));}
    catch(error){return result(false,null,null,"DIRECT_GRANT_MISSING",error instanceof DomainError?error.message:undefined);}
    if(this.lock.isBusy(projectId,sessionId))return result(false,null,null,"SESSION_INPUT_BUSY");
    const capabilities=runtime.capabilitiesFor?.(binding)??runtime.capabilities?.();
    if(!capabilities)return result(false,null,null,"NATIVE_CAPABILITY_UNKNOWN");
    const state=await this.deps.store.inspect(projectId,sessionId,principal.actorId);
    if(state.state==="busy")return result(false,null,null,"SESSION_BUSY");
    if(state.state==="running"){
      if(!grant.canSteer)return result(false,null,null,"DIRECT_STEER_DISABLED");
      if(!capabilities.delivery.midTurnInput)return result(false,null,null,"NATIVE_STEER_UNAVAILABLE");
      try{
        await runtime.registerBinding(binding);
        const turn=await this.findTurn(runtime,binding,state.turnId!);
        return turn?.status==="inProgress"?result(true,"steer",state.turnId,"READY_TO_STEER"):
          result(false,null,null,"NATIVE_TURN_NOT_ACTIVE");
      }catch{return result(false,null,null,"NATIVE_TURN_UNKNOWN");}
    }
    if(await this.deps.store.providerHeld(projectId,sessionId))return result(false,null,null,"PROVIDER_HELD",
      "the model provider is paused for quota or authentication; messages are saved queued and go out with the release");
    if(!grant.canStart)return result(false,null,null,"DIRECT_START_DISABLED");
    if(!capabilities.delivery.idleTurnStart)return result(false,null,null,"NATIVE_IDLE_START_UNAVAILABLE");
    if(grant.maxTurns!==undefined&&state.used>=grant.maxTurns)
      return result(false,null,null,"MESSAGE_BUDGET_EXHAUSTED");
    try{
      await runtime.registerBinding(binding);
      const native=await runtime.qualifyConversationThread(binding);
      return native.available&&native.fingerprint?result(true,"start",null,"READY_TO_START"):
        result(false,null,null,"NATIVE_ADMISSION_MISSING");
    }catch{return result(false,null,null,"NATIVE_ADMISSION_UNKNOWN");}
  }
  async get(principal:Principal,projectId:string,inputId:string):Promise<DirectInputReceipt>{
    const record=await this.deps.store.get(projectId,inputId);
    if(!record)throw new DomainError("NOT_FOUND","Direct input was not found");
    this.requireReader(principal,record);
    return publicDirectInput(record);
  }
  async list(principal:Principal,projectId:string,sessionId:string,limit:number,cursor?:string){
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN","Project read permission required");
    const page=await this.deps.store.list(projectId,sessionId,limit,cursor,
      principal.permissions.includes("review")?undefined:principal.actorId);
    return {...page,items:page.items.map(publicDirectInput)};
  }
  async submit(principal:Principal,projectId:string,sessionId:string,command:DirectInputCommand):Promise<DirectInputReceipt>{
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("write")||
      !principal.permissions.includes("read")||!this.deps.canWrite())
      throw new DomainError("FORBIDDEN","Current project writer is unavailable");
    const key=`${projectId}\u0000${command.inputId}`;
    const prior=await this.deps.store.get(projectId,command.inputId);
    const retrying=!!prior&&prior.state==="attempted"&&this.provedUnsent.has(key);
    if(prior){
      this.requireSameIntent(principal,sessionId,command,prior);
      // A later request may reuse the exact intent only after a local admission refusal proved no send.
      if(!retrying)return publicDirectInput(prior);
    }
    const {grant,binding}=await this.deps.admission(principal,projectId,sessionId);
    const runtime=this.deps.runtime();
    if(!runtime.isReady())throw new DomainError("NATIVE_UNAVAILABLE","Owned native connection is unavailable");
    await runtime.registerBinding(binding);
    const capabilities=runtime.capabilitiesFor?.(binding)??runtime.capabilities?.();
    if(!capabilities)throw new DomainError("NATIVE_CAPABILITY_UNKNOWN","Session runtime capabilities are unavailable");
    const release=this.lock.acquire(projectId,sessionId);
    let provedBusy=false;
    try{
    // Qualification must precede reservation for an idle start. The PG lock chooses the final mode.
    let fingerprint="";
    if(!await this.deps.store.hasPrimary(projectId,sessionId)){
      const qualification=await runtime.qualifyConversationThread(binding);
      if(!qualification.available||!qualification.fingerprint)
        throw new DomainError("NATIVE_ADMISSION_MISSING",qualification.reason);
      fingerprint=qualification.fingerprint;
    }
    const reserved=await this.deps.store.reserve(projectId,sessionId,principal.actorId,command,grant,fingerprint);
    const record=reserved.record;
    this.requireSameIntent(principal,sessionId,command,record);
    // Never replay an uncertain native attempt. The only exception is an identical intent the adapter
    // refused before writing; it still carries the same operation ID and has no native attempt.
    if(!reserved.created&&!retrying)return publicDirectInput(record);
    // The Turn changed under a steer: reserve saved the text as one queued message and recorded that; nothing is sent.
    if(record.state==="rejected")return publicDirectInput(record);
    if(record.mode==="steer"&&!capabilities.delivery.midTurnInput)
      return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,
        "This runtime cannot add input to an active Turn"));
    if(record.mode==="start"&&!capabilities.delivery.idleTurnStart)
      return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,
        "This runtime cannot start an idle Turn directly"));
    // A revoked grant between reservation and transport rejects this original intent.
    try{await this.deps.admission(principal,projectId,sessionId);}
    catch(error){return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,"Authorization changed before native send"));}
    try{
      if(record.mode==="steer"){
        const turnId=record.expectedTurnId!;
        // The native runtime validates expectedTurnId. A review/start Turn and its execution child
        // can have different IDs in history, so a local history lookup cannot decide steerability.
        const receipt=await runtime.steerTurn(binding,turnId,record.content,record.inputId);
        return publicDirectInput(await this.deps.store.accept(projectId,record.inputId,receipt.turnId,receipt.itemId));
      }
      const input=`${marker(record.operationId)}\nOrdinary Session conversation using this Session's normal tools and full execution permissions. Act within the user's request and project identity. A reply does not itself record Task delivery or acceptance.\n${record.content}`;
      const turn=await runtime.startConversationTurn(binding,input,record.inputId);
      const accepted=publicDirectInput(await this.deps.store.accept(projectId,record.inputId,turn.id,null));
      await this.deps.observeEffort?.(projectId,record.sessionId,record.inputId,turn,binding.resumeProfile?.reasoningEffort??null).catch(()=>undefined);
      return accepted;
    }catch(error){
      if(error instanceof RuntimeLocalBusyError){
        // Adapter-level in-flight admission refused before writing; keep the durable intent retryable.
        provedBusy=true;this.provedUnsent.add(key);
        throw new DomainError("SESSION_INPUT_BUSY","该会话正在开始另一轮或接收另一条输入；稍后用同一输入编号重试");
      }
      if(error instanceof RuntimeServerError&&error.steerRejection==="non_steerable_turn"&&record.mode==="steer")
        return publicDirectInput(await this.deps.store.rejectSteerAndQueue(projectId,record.inputId,
          "Native Turn kind cannot accept input; saved as a queued ordinary message",{provedUnsent:true}));
      // The runtime answered the steer with an error of its own (-32600: no active Turn, or another one): the Turn ended or changed in the
      // window before the database knew. The answer proves the steer was not applied, so the text is saved as one queued message.
      if(error instanceof RuntimeServerError&&error.method==="turn/steer"&&record.mode==="steer")
        return publicDirectInput(await this.deps.store.rejectSteerAndQueue(projectId,record.inputId,
          "TURN_CHANGED: the runtime refused the input because the Turn is no longer current; saved as a queued ordinary message",{provedUnsent:true}));
      if(error instanceof RuntimeProtocolError&&!(error instanceof RuntimeUnknownError)&&
        !(error instanceof RuntimeServerError&&error.preTurnWriterConflict))
        return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,"Native request was explicitly rejected"));
      return publicDirectInput(await this.deps.store.unknown(projectId,record.inputId,"Native acknowledgement unavailable; reconcile original input"));
    }
    }finally{release();if(!provedBusy)this.provedUnsent.delete(key);}
  }
  /** Read only: a crash or lost reply never causes a second native send. */
  async reconcile(principal:Principal,projectId:string,inputId:string):Promise<DirectInputReceipt>{
    if(!principal.permissions.includes("write")||!this.deps.canWrite())
      throw new DomainError("FORBIDDEN","Current writer is required to reconcile direct input");
    const record=await this.deps.store.get(projectId,inputId);
    if(!record)throw new DomainError("NOT_FOUND","Direct input was not found");
    this.requireReader(principal,record);
    if(!["attempted","unknown","accepted"].includes(record.state)||record.state==="accepted"&&record.nativeItemId)
      return publicDirectInput(record);
    const binding=await this.deps.bindingFor(projectId,record.sessionId);
    const runtime=this.deps.runtime();
    await runtime.registerBinding(binding);
    let matches:{turnId:string;itemId:string|null}[];
    try{matches=await this.matchOriginal(runtime,binding,record);}
    catch(error){
      // Zero-Turn history can be unmaterialized; other native history reads may be unsupported.
      // Neither condition proves that the original send was rejected.
      if(error instanceof RuntimeServerError&&
        (error.method==="thread/turns/list"&&error.code===-32600||
          error.method==="thread/items/list"&&error.code===-32601))
        return publicDirectInput(record.state==="attempted"?
          await this.deps.store.unknown(projectId,inputId,"Native history unavailable; original input remains unresolved"):record);
      throw error;
    }
    if(matches.length===1)return publicDirectInput(await this.deps.store.accept(projectId,inputId,matches[0]!.turnId,matches[0]!.itemId));
    if(record.state==="attempted")return publicDirectInput(await this.deps.store.unknown(projectId,inputId,"No unique original input in bounded native history"));
    return publicDirectInput(record);
  }
  /** The Items of the bounded native history that are this input: by exact client ID, or for a start by its operation marker. */
  private async matchOriginal(runtime:Native,binding:RuntimeBinding,record:DirectInputRecord):Promise<{turnId:string;itemId:string|null}[]>{
    const matches:{turnId:string;itemId:string|null}[]=[];
    const turns=(record.actualTurnId??record.expectedTurnId)?
      [await this.findTurn(runtime,binding,(record.actualTurnId??record.expectedTurnId)!)].filter(Boolean) as RuntimeTurn[]:
      (await runtime.listTurns(binding)).data.slice(0,20);
    for(const turn of turns){
      let cursor:string|undefined;
      for(let page=0;page<10;page++){
        const items=await runtime.listItems(binding,turn.id,cursor);
        for(const item of items.data){
          const x=object(item);
          if(x?.type!=="userMessage")continue;
          // Materialized alpha.6 Items use clientId for clientUserMessageId.
          const clientId=x.clientUserMessageId??x.client_user_message_id??x.clientId;
          if(clientId===record.inputId||record.mode==="start"&&textOf(item).startsWith(marker(record.operationId)))
            matches.push({turnId:turn.id,itemId:typeof x.id==="string"?x.id:null});
        }
        if(!items.nextCursor)break;
        cursor=items.nextCursor;
      }
    }
    return matches;
  }
  /**
   * After a Turn has ended, read its history once (read only, never a send) and record the native Item of every accepted input that
   * does not have one yet. A start learns its Item only this way; a steer whose acknowledgement carried none does too. Nothing here
   * claims the agent read or adopted the input: it records which native Item the runtime holds for it.
   */
  async backfillItems(limit=20):Promise<number>{
    if(!this.deps.canWrite())return 0;
    const runtime=this.deps.runtime();
    if(!runtime.isReady())return 0;
    let recorded=0;
    for(const record of await this.deps.store.unboundAccepted(limit)){
      try{
        const binding=await this.deps.bindingFor(record.projectId,record.sessionId);
        await runtime.registerBinding(binding);
        const turn=await this.findTurn(runtime,binding,record.actualTurnId!);
        // Only a finished Turn has a settled history; an unfinished one is looked at again later.
        if(!turn||turn.completedAtUtc==null||!["completed","failed","interrupted"].includes(turn.status))continue;
        const matches=await this.matchOriginal(runtime,binding,record);
        if(matches.length===1&&matches[0]!.itemId&&matches[0]!.turnId===record.actualTurnId){
          await this.deps.store.accept(record.projectId,record.inputId,matches[0]!.turnId,matches[0]!.itemId);recorded++;
        }
      }catch{ /* a read that fails is tried again next time; it proves nothing */ }
    }
    return recorded;
  }
  private async findTurn(runtime:Native,binding:RuntimeBinding,id:string):Promise<RuntimeTurn|null>{
    const first=await runtime.listTurns(binding);
    const found=first.data.find(x=>x.id===id);
    if(found)return found;
    return first.nextCursor?(await runtime.listTurns(binding,first.nextCursor)).data.find(x=>x.id===id)??null:null;
  }
  private requireReader(principal:Principal,record:DirectInputRecord){
    if(!principal.projectIds.includes(record.projectId)||!principal.permissions.includes("read")||
      record.actorId!==principal.actorId&&!principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN","Input belongs to another actor");
  }
  private requireSameIntent(principal:Principal,sessionId:string,command:DirectInputCommand,old:DirectInputRecord){
    this.requireReader(principal,old);
    if(old.actorId!==principal.actorId||old.sessionId!==sessionId||old.inputId!==command.inputId||
      old.operationId!==command.operationId||old.content!==command.content||old.expectedTurnId!==command.expectedTurnId)
      throw new DomainError("INPUT_ID_CONFLICT","Read the original input intent before retrying");
  }
}
