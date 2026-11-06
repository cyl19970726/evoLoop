import type { Principal } from "@evoloop/contracts";
import type { DirectInputCommand, DirectInputGrant, DirectInputReceipt, DirectInputRecord, DirectInputCapability } from "@evoloop/contracts/direct-input";
import { publicDirectInput } from "@evoloop/contracts/direct-input";
import type { RuntimeBinding, RuntimePage, RuntimeTurn } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/adapter-codex-app-server";
import type { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";

type Native = {
  isReady():boolean;
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
  /** Re-reads the current direct grant, writer identities and Session execution authority. */
  admission(principal:Principal,projectId:string,sessionId:string):Promise<{grant:DirectInputGrant;binding:RuntimeBinding}>;
  /** Existing owned binding for read-only reconciliation; a revoked sender grant cannot erase prior evidence. */
  bindingFor(projectId:string,sessionId:string):Promise<RuntimeBinding>;
}

/** The HTTP caller never controls the native binding, source or mode. */
export class DirectInputService {
  constructor(private readonly deps:DirectInputServiceDeps){}
  async capability(principal:Principal,projectId:string,sessionId:string):Promise<DirectInputCapability>{
    const result=(available:boolean,mode:DirectInputCapability["mode"],expectedTurnId:string|null,reasonCode:string):DirectInputCapability=>
      ({available,mode,expectedTurnId,reasonCode,observedAt:new Date().toISOString()});
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read")||
      !principal.permissions.includes("write"))return result(false,null,null,"FORBIDDEN");
    let runtime:Native;
    try{runtime=this.deps.runtime();if(!this.deps.canWrite()||!runtime.isReady())
      return result(false,null,null,"NATIVE_UNAVAILABLE");}
    catch{return result(false,null,null,"NATIVE_UNAVAILABLE");}
    let grant:DirectInputGrant,binding:RuntimeBinding;
    try{({grant,binding}=await this.deps.admission(principal,projectId,sessionId));}
    catch{return result(false,null,null,"DIRECT_GRANT_MISSING");}
    const state=await this.deps.store.inspect(projectId,sessionId,principal.actorId);
    if(state.state==="busy")return result(false,null,null,"SESSION_BUSY");
    if(state.state==="running"){
      if(!grant.canSteer)return result(false,null,null,"DIRECT_STEER_DISABLED");
      try{
        await runtime.registerBinding(binding);
        const turn=await this.findTurn(runtime,binding,state.turnId!);
        return turn?.status==="inProgress"?result(true,"steer",state.turnId,"READY_TO_STEER"):
          result(false,null,null,"NATIVE_TURN_NOT_ACTIVE");
      }catch{return result(false,null,null,"NATIVE_TURN_UNKNOWN");}
    }
    if(!grant.canStart)return result(false,null,null,"DIRECT_START_DISABLED");
    if(state.used>=grant.maxTurns)return result(false,null,null,"MESSAGE_BUDGET_EXHAUSTED");
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
    const prior=await this.deps.store.get(projectId,command.inputId);
    if(prior){this.requireSameIntent(principal,sessionId,command,prior);return publicDirectInput(prior);}
    const {grant,binding}=await this.deps.admission(principal,projectId,sessionId);
    const runtime=this.deps.runtime();
    if(!runtime.isReady())throw new DomainError("NATIVE_UNAVAILABLE","Owned native connection is unavailable");
    await runtime.registerBinding(binding);
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
    if(!reserved.created)return publicDirectInput(record); // Never replay an uncertain native attempt.
    // A revoked grant between reservation and transport rejects this original intent.
    try{await this.deps.admission(principal,projectId,sessionId);}
    catch(error){return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,"Authorization changed before native send"));}
    try{
      if(record.mode==="steer"){
        const turnId=record.expectedTurnId!;
        const turn=await this.findTurn(runtime,binding,turnId);
        if(turn?.status!=="inProgress")
          return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,"Expected native Turn is no longer in progress"));
        const receipt=await runtime.steerTurn(binding,turnId,record.content,record.inputId);
        return publicDirectInput(await this.deps.store.accept(projectId,record.inputId,receipt.turnId,receipt.itemId));
      }
      const input=`${marker(record.operationId)}\nOrdinary Session conversation using this Session's normal tools and full execution permissions. Act within the user's request and project identity. A reply does not itself record Task delivery or acceptance.\n${record.content}`;
      const turn=await runtime.startConversationTurn(binding,input,record.inputId);
      return publicDirectInput(await this.deps.store.accept(projectId,record.inputId,turn.id,null));
    }catch(error){
      if(error instanceof RuntimeProtocolError&&!(error instanceof RuntimeUnknownError)&&
        !(error instanceof RuntimeServerError&&error.preTurnWriterConflict))
        return publicDirectInput(await this.deps.store.reject(projectId,record.inputId,"Native request was explicitly rejected"));
      return publicDirectInput(await this.deps.store.unknown(projectId,record.inputId,"Native acknowledgement unavailable; reconcile original input"));
    }
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
    const turns=(record.actualTurnId??record.expectedTurnId)?
      [await this.findTurn(runtime,binding,(record.actualTurnId??record.expectedTurnId)!)].filter(Boolean) as RuntimeTurn[]:
      (await runtime.listTurns(binding)).data.slice(0,20);
    const matches:{turnId:string;itemId:string|null}[]=[];
    for(const turn of turns){
      let cursor:string|undefined;
      for(let page=0;page<10;page++){
        const items=await runtime.listItems(binding,turn.id,cursor);
        for(const item of items.data){
          const x=object(item);
          if(x?.type!=="userMessage")continue;
          const clientId=x.clientUserMessageId??x.client_user_message_id;
          if(clientId===record.inputId||record.mode==="start"&&textOf(item).startsWith(marker(record.operationId)))
            matches.push({turnId:turn.id,itemId:typeof x.id==="string"?x.id:null});
        }
        if(!items.nextCursor)break;
        cursor=items.nextCursor;
      }
    }
    if(matches.length===1)return publicDirectInput(await this.deps.store.accept(projectId,inputId,matches[0]!.turnId,matches[0]!.itemId));
    if(record.state==="attempted")return publicDirectInput(await this.deps.store.unknown(projectId,inputId,"No unique original input in bounded native history"));
    return publicDirectInput(record);
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
