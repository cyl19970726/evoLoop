import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '@evoloop/contracts';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import { DomainError } from '@evoloop/contracts/ports';
import type { NativeInputSource } from '@evoloop/contracts/native-input';
import type { SessionMessageRecord, SessionMessageProcessing } from '@evoloop/contracts/session-messages';
import type { SessionTarget } from '@evoloop/contracts/session-work';
import type { NativeWorkspacePage, SessionTimelinePage, WorkspaceEntry, WorkspaceLiveRead,
  WorkspaceMessage, WorkspaceOrigin, WorkspaceRuntimeUpdate, WorkspaceTurn, NativeWorkspaceReadOptions } from '@evoloop/contracts/session-timeline';
import type { RuntimeBinding, RuntimePort } from '@evoloop/contracts/runtime';
import type { SessionObservationService } from '@evoloop/core/session-observation';

/** A started runner or a separately opened read-only adapter can own these exact reads. */
export interface WorkspaceHistoryOwner {
  workspaceBinding(principal:Principal,projectId:string,sessionId:string):Promise<RuntimeBinding>;
  workspaceHistory(principal:Principal,projectId:string,sessionId:string,options:NativeWorkspaceReadOptions):Promise<NativeWorkspacePage>;
  onWorkspaceUpdate(listener:(event:WorkspaceRuntimeUpdate)=>void):()=>void;
  onWorkspaceDisconnect(listener:(reason:string)=>void):()=>void;
  nativeAdapter():Pick<RuntimePort,'readWorkspaceHistory'|'onWorkspaceUpdate'>;
  status(projectId?:string):{available:boolean};
}

type Query = {cursor?:string|undefined; messagesCursor?:string|undefined; limit:number;
  turnId?:string|undefined; itemId?:string|undefined; source?:'native'|'messages'|'both'|undefined};
type Scope = {projectId:string; key:string; sessionId:string|null; threadId:string|null;
  nativeSessionId:string|null;target:SessionTarget; title:string};
type LiveEvent = {seq:number; entry?:WorkspaceEntry; turn?:WorkspaceTurn};
type LiveState = {generation:string; seq:number; events:LiveEvent[]; entries:Map<string,WorkspaceEntry>;
  turns:Map<string,WorkspaceTurn>; activeTurnId:string|null; terminalTurns:Set<string>;
  stale:boolean; qualified:boolean; resetReason:string|null};
type InputBinding = {itemId:string|null; ambiguous:boolean};
type InputRead = {remaining:number; proofs:Map<string,InputBinding>; limitations:Set<string>};
// Proofs belong to one read request; a display page or the process's first observed Item grants no binding.
const inputRead=():InputRead=>({remaining:10,proofs:new Map(),limitations:new Set()});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=(value:string):Record<string,unknown>=>{
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.from(value,'base64url').toString())}
  catch{throw new DomainError('INVALID_CURSOR','读取位置无效或不属于当前会话。')}
  if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed)||Object.getPrototypeOf(parsed)!==Object.prototype)
    throw new DomainError('INVALID_CURSOR','读取位置无效或不属于当前会话。');
  return parsed as Record<string,unknown>;
};
const bounded=(text:string,max=16000)=>text.length>max?text.slice(0,max):text;
const messageState=(state:SessionMessageRecord['state']):WorkspaceMessage['state']=>
  state==='queued'||state==='manual_pending'?'pending':state==='processing'?'running':
  state==='replied'||state==='completed_without_reply'?'completed':state==='failed'?'failed':
  state==='cancelled'?'declined':'unknown';
const messageEntry=(m:SessionMessageRecord,turnId:string|null=null):WorkspaceMessage=>({
  id:`message:${m.id}`,kind:'message',role:'input',phase:'unknown',body:m.content,
  clientId:null,state:messageState(m.state),turnId,nativeItemId:null,nativeKind:null,
  author:{kind:'actor',id:m.senderActorId,label:m.senderActorId},
  origin:{kind:'message',id:m.id,taskId:m.context?.taskId??null,taskRevisionId:m.context?.taskRevisionId??null,
    initiatingActorId:m.senderActorId},occurredAt:m.createdAt,observedAt:m.updatedAt,freshness:'persisted',truncated:false,
  order:{kind:'saved-message',key:`message:${m.id}`,position:null,generation:null},
});
const originOf=(source:NativeInputSource|null):WorkspaceOrigin|null=>source?.kind==='run'?{
  kind:'run',id:source.runId,taskId:source.taskId,taskRevisionId:source.taskRevisionId,initiatingActorId:source.actorId
}:source?.kind==='message'?{kind:'message',id:source.messageId,taskId:null,taskRevisionId:null,
  initiatingActorId:source.actorId}:null;
const toolDetailDenied='原始工具详情需要本项目读取与复核权限。';
const exactInput=(raw:WorkspaceEntry,source:NativeInputSource|null):raw is WorkspaceMessage=>{
  if(raw.kind!=='message'||raw.role!=='input'||!source)return false;
  const marker=raw.inputReference;
  const markerMatches=!!marker&&marker.kind==='operation-marker'&&marker.source===source.kind&&
    marker.operationId===source.operationId;
  if(raw.clientId!==null)return raw.clientId===source.operationId&&(!marker||markerMatches);
  return markerMatches;
};
const nativeInputNotice=(raw:WorkspaceMessage,reason:'unassociated'|'duplicate'|'conflict'='unassociated'):WorkspaceEntry=>({
  id:raw.id,turnId:raw.turnId,nativeItemId:raw.nativeItemId,nativeKind:raw.nativeKind,
  author:{kind:'native',id:null,label:'原生输入'},origin:null,occurredAt:raw.occurredAt,
  observedAt:raw.observedAt,freshness:raw.freshness,truncated:false,
  ...(raw.order?{order:raw.order}:{}),kind:'notice',
  label:reason==='duplicate'?'重复的原生输入':reason==='conflict'?'标识冲突的原生输入':'未关联的原生输入',
  body:reason==='duplicate'?'此原生输入重复指向同一业务来源；其独立身份未核实。':
    reason==='conflict'?'原生输入的标识互相冲突，无法核实发送者。':'未能核实此原生输入的业务发送者。',
  state:raw.state,
});
const inputNoticeReason=(raw:WorkspaceMessage,source:NativeInputSource|null,duplicate=false):'unassociated'|'duplicate'|'conflict'=>{
  if(duplicate)return 'duplicate';
  if(raw.clientId!==null&&raw.inputReference&&source&&
      (raw.clientId!==source.operationId||raw.inputReference.source!==source.kind||
        raw.inputReference.operationId!==source.operationId))return 'conflict';
  return 'unassociated';
};
const runInput=(raw:WorkspaceMessage,source:Extract<NativeInputSource,{kind:'run'}>):WorkspaceMessage=>{
  const {inputReference:_,...publicInput}=raw;
  return {...publicInput,body:'项目派发任务',clientId:null,
    author:{kind:'actor',id:source.actorId,label:source.actorId},origin:originOf(source),truncated:false};
};
const safeEntry=(entry:WorkspaceEntry,allowDetail:boolean):WorkspaceEntry=>{
  if(entry.kind==='tool'){
    // Provider summaries are bounded public projections; original fields are never copied into the ordinary feed.
    const summary=bounded(entry.summary,300).replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi,'[redacted]');
    const {detail:originalDetail,...publicTool}=entry;
    return {...publicTool,origin:null,name:bounded(entry.name,120),summary,detailAvailable:allowDetail&&entry.detailAvailable,
      detailReason:allowDetail?entry.detailReason:toolDetailDenied,
      ...(allowDetail&&originalDetail?{detail:originalDetail}:{})};
  }
  if(entry.kind==='message')return entry.role==='assistant'
    ? {...entry,origin:null,body:bounded(entry.body),truncated:entry.truncated||entry.body.length>16000}
    : nativeInputNotice(entry);
  return {...entry,origin:null,body:entry.kind==='plan'?bounded(entry.body):'',label:bounded(entry.label,120),
    truncated:entry.truncated||entry.kind==='plan'&&entry.body.length>16000};
};
const publicEntry=(entry:WorkspaceEntry,principal:Principal):WorkspaceEntry=>{
  const projected=safeEntry(entry,false);
  if(entry.kind!=='tool'||projected.kind!=='tool')return projected;
  const authorized=principal.permissions.includes('read')&&principal.permissions.includes('review');
  return {...projected,detailAvailable:authorized&&entry.detailAvailable,
    detailReason:authorized?entry.detailReason:toolDetailDenied};
};
const bufferEntry=(entry:WorkspaceEntry):WorkspaceEntry=>{
  if(entry.kind==='message'&&entry.role==='input')
    return {...entry,body:'',origin:null,author:{kind:'native',id:null,label:'原生输入'},truncated:false};
  const projected=safeEntry(entry,false);
  // The shared buffer has no reader identity. Keep source availability, never the original payload.
  return entry.kind==='tool'&&projected.kind==='tool'
    ? {...projected,detailAvailable:entry.detailAvailable,detailReason:entry.detailReason}:projected;
};
const liveKey=(p:string,s:string,t:string)=>`${p}:${s}:${t}`;

/** Project reads and exact owned binding checks occur on every request; the buffer grants no authority. */
export class SessionTimelineService {
  private readonly live=new Map<string,LiveState>();
  private readonly waiters=new Map<string,Set<()=>void>>();
  private readonly historyAvailability=new Map<string,boolean>();
  private readonly instance=randomUUID();
  private unsubscribeUpdate:()=>void;
  private unsubscribeDisconnect:()=>void;
  constructor(private readonly deps:{uow:UnitOfWork; observation:SessionObservationService; runner?:WorkspaceHistoryOwner}){
    this.unsubscribeUpdate=deps.runner?.onWorkspaceUpdate(event=>this.accept(event))??(()=>{});
    this.unsubscribeDisconnect=deps.runner?.onWorkspaceDisconnect(()=>this.disconnect())??(()=>{});
  }
  close(){this.unsubscribeUpdate();this.unsubscribeDisconnect();for(const key of this.waiters.keys())this.wake(key);
    this.live.clear();this.historyAvailability.clear()}
  private wake(key:string){const listeners=this.waiters.get(key);this.waiters.delete(key);
    for(const listener of listeners??[])listener()}
  private wait(key:string,ms:number):Promise<void>{return new Promise(resolve=>{
    const listeners=this.waiters.get(key)??new Set<()=>void>();this.waiters.set(key,listeners);
    let timer:ReturnType<typeof setTimeout>;
    const done=()=>{clearTimeout(timer);listeners.delete(done);if(!listeners.size)this.waiters.delete(key);resolve()};
    listeners.add(done);timer=setTimeout(done,ms);
  })}
  private state(key:string):LiveState{
    let state=this.live.get(key);
    if(!state){state={generation:`${this.instance}:${randomUUID()}`,seq:0,events:[],entries:new Map(),turns:new Map(),
      activeTurnId:null,terminalTurns:new Set(),stale:false,qualified:false,resetReason:null};this.live.set(key,state);
      while(this.live.size>64)this.live.delete(this.live.keys().next().value!);
    }else{this.live.delete(key);this.live.set(key,state)}
    return state;
  }
  private accept(event:WorkspaceRuntimeUpdate){
    if(!event.projectId||!event.sessionId||!event.threadId)return;
    const key=liveKey(event.projectId,event.sessionId,event.threadId),state=this.state(key);
    if(event.kind==='reset'){
      state.generation=`${this.instance}:${randomUUID()}`;state.seq=0;state.events=[];state.entries.clear();state.turns.clear();
      state.activeTurnId=null;state.terminalTurns.clear();
      state.stale=true;state.qualified=false;state.resetReason=event.reason;this.wake(key);return;
    }
    let entry:WorkspaceEntry|undefined,turn:WorkspaceTurn|undefined;
    if(event.kind==='entry'){
      if(event.entry.turnId!==event.turnId||!event.entry.id||
          !event.entry.nativeItemId&&!event.entry.order?.key)return;
      entry=bufferEntry({...event.entry,freshness:'live'});
      state.entries.delete(entry.id);state.entries.set(entry.id,entry);
    }else if(event.kind==='text-delta'){
      const old=[...state.entries.values()].find(x=>x.turnId===event.turnId&&x.nativeItemId===event.itemId);
      if(old?.kind!=='message'||old.role!=='assistant')return;
      entry={...old,body:bounded(old.body+event.delta),truncated:old.truncated||event.truncated===true||
        old.body.length+event.delta.length>16000,
        observedAt:event.observedAt};state.entries.set(entry.id,entry);
    }else if(event.kind==='turn'){
      if(event.turn.id!==event.turnId)return;
      turn=event.turn;
      const start=turn.state==='running'&&turn.order?.kind==='turn-boundary'&&
        turn.order.key===`boundary:${event.threadId}:${turn.id}:start`;
      if(start&&state.terminalTurns.has(turn.id))return;
      const terminal=['completed','failed','interrupted','declined'].includes(turn.state)||
        turn.order?.key===`boundary:${event.threadId}:${turn.id}:complete`;
      if(terminal){state.terminalTurns.add(turn.id);
        while(state.terminalTurns.size>128)state.terminalTurns.delete(state.terminalTurns.values().next().value!);
        if(state.activeTurnId===turn.id)state.activeTurnId=null;
      }else if(start)state.activeTurnId=turn.id;
      state.turns.set(turn.id,turn);
    }
    state.stale=false;state.qualified=true;state.seq++;state.events.push({seq:state.seq,...(entry?{entry}:{}),...(turn?{turn}:{})});
    if(state.events.length>256)state.events.shift();
    while(state.entries.size>128)state.entries.delete(state.entries.keys().next().value!);
    while(state.turns.size>64)state.turns.delete(state.turns.keys().next().value!);
    this.wake(key);
  }
  private disconnect(){for(const [key,state] of this.live){
    state.generation=`${this.instance}:${randomUUID()}`;state.seq=0;state.events=[];state.stale=true;state.qualified=false;
    state.activeTurnId=null;state.terminalTurns.clear();
    state.resetReason='Native connection disconnected';
    for(const [id,entry] of state.entries)state.entries.set(id,{...entry,freshness:'stale'});
    this.wake(key);
  }}
  private async scope(principal:Principal,projectId:string,key:string):Promise<Scope>{
    const snapshot=await this.deps.observation.snapshot(principal,projectId,key);
    if(snapshot.session.key!==key)throw new DomainError('FORBIDDEN','Session key changed');
    const target=snapshot.session.target;
    if(target.kind==='external')return {projectId,key,sessionId:null,threadId:null,nativeSessionId:null,target,title:snapshot.session.title};
    const session=await this.deps.uow.read(projectId,r=>r.getRuntimeSession(target.sessionId));
    if(!session||session.projectId!==projectId||session.id!==target.sessionId)
      throw new DomainError('FORBIDDEN','Owned Session binding is missing');
    if(this.deps.runner&&session.nativeThreadId){
      const binding=await this.deps.runner.workspaceBinding(principal,projectId,session.id);
      if(binding.nativeThreadId!==session.nativeThreadId||binding.nativeSessionId!==session.nativeSessionId)
        throw new DomainError('FORBIDDEN','Native binding changed');
    }
    return {projectId,key,sessionId:session.id,threadId:session.nativeThreadId,nativeSessionId:session.nativeSessionId,
      target,title:snapshot.session.title};
  }
  private fence(principal:Principal,scope:Scope,mode:string,turnId?:string,itemId?:string){
    return hash([scope.projectId,principal.actorId,[...principal.permissions].sort(),scope.key,scope.sessionId,
      scope.threadId,scope.nativeSessionId,mode,turnId??null,itemId??null]);
  }
  private position(value:string|undefined,fence:string):string|undefined{
    if(!value)return undefined;
    const parsed=decode(value);
    if(parsed.v!==1||parsed.fence!==fence||typeof parsed.position!=='string'||parsed.position.length>4096)
      throw new DomainError('INVALID_CURSOR','读取位置与当前身份、项目、会话或读取范围不符。');
    return parsed.position;
  }
  private token(position:string|null,fence:string){return position?encode({v:1,fence,position}):null}
  private liveRead(principal:Principal,scope:Scope,after?:string):WorkspaceLiveRead{
    if(!scope.sessionId||!scope.threadId||!this.deps.runner?.nativeAdapter().onWorkspaceUpdate)
      return {cursor:'',resetRequired:false,entries:[],turns:[],freshness:'unavailable',activeTurnId:null,
        limitations:['Live native updates unavailable']};
    const state=this.state(liveKey(scope.projectId,scope.sessionId,scope.threadId));
    const fence=this.fence(principal,scope,'live');
    const current=this.token(`${state.generation}|${state.seq}`,fence)!;
    let resetRequired=!after,events=state.events;
    if(after){
      const position=this.position(after,fence)!;const separator=position.lastIndexOf('|');
      const generation=position.slice(0,separator),sequence=Number(position.slice(separator+1));
      if(separator<0||!Number.isSafeInteger(sequence)||sequence<0||generation!==state.generation||
        sequence>state.seq||sequence<(state.events[0]?.seq??state.seq+1)-1)resetRequired=true;
      else {resetRequired=false;events=state.events.filter(x=>x.seq>sequence)};
    }
    const entries=resetRequired?[...state.entries.values()]:[...new Map(events.flatMap(x=>x.entry?[[x.entry.id,x.entry] as const]:[])).values()];
    const turns=resetRequired?[...state.turns.values()]:[...new Map(events.flatMap(x=>x.turn?[[x.turn.id,x.turn] as const]:[])).values()];
    const connected=this.deps.runner.status(scope.projectId).available;
    return {cursor:current,resetRequired,entries,turns,freshness:state.stale?'stale':connected&&state.qualified?'live':'unavailable',
      activeTurnId:connected&&state.qualified&&!state.stale?state.activeTurnId:null,
      limitations:[...(state.resetReason?[state.resetReason]:[]),...(!connected?['Native connection is unavailable']:[]),
        ...(!state.qualified&&!state.stale?['No scoped native update has been observed for this Thread']:[]),
        'Live updates are bounded to this service process']};
  }
  async updates(principal:Principal,projectId:string,key:string,after?:string,waitMs=0):Promise<WorkspaceLiveRead>{
    const scope=await this.scope(principal,projectId,key);
    let view=this.liveRead(principal,scope,after);
    if(after&&!view.resetRequired&&!view.entries.length&&!view.turns.length&&view.freshness!=='stale'&&
        !!this.deps.runner?.nativeAdapter().onWorkspaceUpdate&&this.deps.runner.status(projectId).available&&
        waitMs>0&&scope.sessionId&&scope.threadId){
      await this.wait(liveKey(projectId,scope.sessionId,scope.threadId),Math.min(waitMs,20000));
      view=this.liveRead(principal,scope,after);
    }
    const live=await this.decorateLive(principal,scope,view);
    const current=await this.scope(principal,projectId,key);
    if(current.threadId!==scope.threadId||current.nativeSessionId!==scope.nativeSessionId)
      throw new DomainError('FORBIDDEN','Session binding changed during live read');
    return live;
  }
  private async decorateLive(principal:Principal,scope:Scope,live:WorkspaceLiveRead,read:InputRead=inputRead()):Promise<WorkspaceLiveRead>{
    if(!scope.sessionId||!live.entries.length&&!live.turns.length)return live;
    const turns=[...new Set([...live.entries.flatMap(e=>e.turnId?[e.turnId]:[]),...live.turns.map(t=>t.id)])];
    const associations=await this.sources(scope.projectId,scope.sessionId,turns);
    const bindings=await this.inputBindings(principal,scope,live.entries,associations.found,read);
    const entries=live.entries.map(raw=>{
      const source=raw.turnId?associations.found.get(raw.turnId)??null:null;
      const origin=originOf(source);
      if(raw.kind==='message'&&raw.role==='input'){
        return this.projectInput(raw,source,source?.kind==='message'?associations.messages.get(source.messageId):undefined,
          raw.turnId?bindings.get(raw.turnId):undefined);
      }
      return {...publicEntry(raw,principal),origin,...(raw.kind==='message'&&raw.role==='assistant'?{
        author:{kind:'session' as const,id:scope.sessionId,label:scope.title}}:{})};
    });
    return {...live,entries,turns:live.turns.map(turn=>({...turn,origin:originOf(associations.found.get(turn.id)??null)})),
      limitations:[...live.limitations,...read.limitations]};
  }
  private async sources(projectId:string,sessionId:string,turnIds:string[]){
    return this.deps.uow.read(projectId,async r=>{
      const native=r.nativeInputs;
      if(!native)throw new DomainError('CAPABILITY_UNAVAILABLE','Native source storage is unavailable');
      const found=native.findSources?await native.findSources(projectId,sessionId,turnIds):new Map<string,NativeInputSource>();
      if(!native.findSources)for(const turnId of turnIds){const source=await native.findSource(projectId,sessionId,turnId);
        if(source)found.set(turnId,source)}
      const ids=[...found.values()].flatMap(source=>source.kind==='message'?[source.messageId]:[]);
      const messages=r.sessionMessages?.getSessionMessages?await r.sessionMessages.getSessionMessages(ids):
        (await Promise.all(ids.map(id=>r.sessionMessages?.getSessionMessage(id)))).filter((x):x is SessionMessageRecord=>!!x);
      const byId=new Map(messages.map(m=>[m.id,m]));
      for(const source of found.values())if(source.kind==='message'){
        const message=byId.get(source.messageId);
        if(!message||message.projectId!==projectId||message.target.kind!=='owned'||message.target.sessionId!==sessionId||
          message.senderActorId!==source.actorId)
          throw new DomainError('INPUT_SOURCE_INVALID','Native message source does not match its saved sender and Session');
      }
      return {found,messages:byId};
    });
  }
  async page(principal:Principal,projectId:string,key:string,query:Query):Promise<SessionTimelinePage>{
    const scope=await this.scope(principal,projectId,key),limit=Math.max(1,Math.min(50,query.limit));
    const inputReading=inputRead();
    const readNative=query.source!=='messages',readMessages=query.source!=='native';
    if(!readNative)inputReading.remaining=0;
    const nativeFence=this.fence(principal,scope,'history',query.turnId,query.itemId);
    const messageFence=this.fence(principal,scope,'messages');
    const nativeCursor=readNative?this.position(query.cursor,nativeFence):undefined;
    const messagesCursor=readMessages?this.position(query.messagesCursor,messageFence):undefined;
    const historyKey=scope.sessionId&&scope.threadId?liveKey(projectId,scope.sessionId,scope.threadId):null;
    const now=new Date().toISOString();let native:NativeWorkspacePage|null=null;
    const limitations:string[]=[];
    if(!readNative){/* source-specific continuation leaves native history untouched */}
    else if(scope.sessionId&&scope.threadId&&this.deps.runner){
      try {native=await this.deps.runner.workspaceHistory(principal,projectId,scope.sessionId,{
        ...(nativeCursor?{cursor:nativeCursor}:{}),limit,...(query.turnId?{turnId:query.turnId}:{}),
        ...(query.itemId?{itemId:query.itemId}:{})});
        if(historyKey)this.historyAvailability.set(historyKey,true);
      }
      catch(error){if(error instanceof DomainError&&error.code==='FORBIDDEN')throw error;
        if(historyKey)this.historyAvailability.set(historyKey,false);
        limitations.push(error instanceof Error?error.message:'Native history unavailable');}
    }else limitations.push('Native history is unsupported for this Session');
    while(this.historyAvailability.size>64)this.historyAvailability.delete(this.historyAvailability.keys().next().value!);
    const turnIds=[...new Set([...(native?.turns.map(t=>t.id)??[]),...(native?.entries.flatMap(e=>e.turnId?[e.turnId]:[])??[])])];
    const associations=scope.sessionId?await this.sources(projectId,scope.sessionId,turnIds):
      {found:new Map<string,NativeInputSource>(),messages:new Map<string,SessionMessageRecord>()};
    const bindings=await this.inputBindings(principal,scope,native?.entries??[],associations.found,inputReading);
    const page=readMessages?await this.deps.uow.read(projectId,async r=>{
      if(!r.sessionMessages)throw new DomainError('CAPABILITY_UNAVAILABLE','Session message storage unavailable');
      const messages=await r.sessionMessages.listSessionMessages(scope.target,limit,messagesCursor);
      const processing=await r.sessionMessages.listSessionMessageProcessing?.(messages.items.map(m=>m.id))??
        (await Promise.all(messages.items.map(m=>r.sessionMessages!.getSessionMessageProcessing(m.id)))).filter((x):x is SessionMessageProcessing=>!!x);
      return {messages,processing};
    }):{messages:{items:[] as SessionMessageRecord[],nextCursor:null},processing:[] as SessionMessageProcessing[]};
    const processing=new Map(page.processing.map(p=>[p.messageId,p]));
    const displayed=new Set<string>();
    let entries:WorkspaceEntry[]=[],turns:WorkspaceTurn[]=[];
    if(native){
      entries=native.entries.flatMap((raw):WorkspaceEntry[]=>{
        const source=raw.turnId?associations.found.get(raw.turnId)??null:null;
        const origin=originOf(source);
        if(raw.kind==='message'&&raw.role==='input'){
          const projected=this.projectInput(raw,source,
            source?.kind==='message'?associations.messages.get(source.messageId):undefined,
            raw.turnId?bindings.get(raw.turnId):undefined);
          if(projected.kind==='message'&&source?.kind==='message')displayed.add(source.messageId);
          return [projected];
        }
        const entry=publicEntry(raw,principal);
        return [{...entry,
          origin,...(entry.kind==='message'&&entry.role==='assistant'?{
            author:{kind:'session' as const,id:scope.sessionId,label:scope.title}}:{})}];
      });
      turns=native.turns.map(turn=>({...turn,origin:originOf(associations.found.get(turn.id)??null)}));
    }else if(readMessages&&(readNative||!scope.threadId||!this.deps.runner?.status(projectId).available||
      !this.deps.runner?.nativeAdapter().readWorkspaceHistory||historyKey&&this.historyAvailability.get(historyKey)===false))
      for(const m of [...page.messages.items].reverse()){
      const p=processing.get(m.id);
      if(p?.response&&p.nativeTurnId)entries.push({...messageEntry(m,p.nativeTurnId),id:`message-response:${m.id}`,
        role:'assistant',body:bounded(p.response),phase:'unknown',state:p.state==='completed'?'completed':'unknown',
        author:{kind:'session',id:scope.sessionId,label:scope.title},occurredAt:p.updatedAt,
        truncated:p.response.length>16000});
    }
    const live=await this.decorateLive(principal,scope,this.liveRead(principal,scope),inputReading);
    const pendingById=new Map<string,WorkspaceMessage>();
    for(const m of page.messages.items)if(!displayed.has(m.id))
      pendingById.set(m.id,messageEntry(m,processing.get(m.id)?.nativeTurnId??null));
    for(const [turnId,source] of associations.found)if(source.kind==='message'&&!displayed.has(source.messageId)){
      const message=associations.messages.get(source.messageId);
      if(message)pendingById.set(message.id,messageEntry(message,turnId));
    }
    const pending=[...pendingById.values()];
    // Recheck project observation and the exact owned binding after asynchronous native and PG reads.
    const current=await this.scope(principal,projectId,key);
    if(current.sessionId!==scope.sessionId||current.threadId!==scope.threadId||
        current.nativeSessionId!==scope.nativeSessionId)
      throw new DomainError('FORBIDDEN','Session binding changed during read');
    return {sessionKey:key,sessionTitle:scope.title,entries,pending,turns,
      nextCursor:readNative?this.token(native?.nextCursor??null,nativeFence):null,
      messagesCursor:readMessages?this.token(page.messages.nextCursor,messageFence):null,
      observedAt:native?.observedAt??now,partial:(readNative&&(!native||native.partial||!!native.nextCursor))||
        (readMessages&&!!page.messages.nextCursor)||(readNative&&inputReading.limitations.size>0),
      limitations:[...limitations,...(native?.limitations??[]),...(readNative?[...inputReading.limitations]:[]),
        ...(scope.target.kind==='external'?['Manual handoff records do not prove native delivery or reading']:[])],
      unsupportedKinds:native?.unsupportedKinds??[],live,
      capabilities:{history:!readNative?!!scope.threadId&&!!this.deps.runner?.nativeAdapter().readWorkspaceHistory&&
          this.historyAvailability.get(historyKey!)!==false:!!native,
        live:!!scope.threadId&&!!this.deps.runner?.nativeAdapter().onWorkspaceUpdate,
        originalToolDetail:principal.permissions.includes('review'),reason:!readNative||native?null:'Native history unavailable or unsupported'}};
  }
  async item(principal:Principal,projectId:string,key:string,turnId:string,itemId:string,
    workerRunId?:string):Promise<WorkspaceEntry>{
    const scope=await this.scope(principal,projectId,key);
    if(!scope.sessionId||!scope.threadId||!this.deps.runner)throw new DomainError('RUNTIME_READ_UNAVAILABLE','Native Item unavailable');
    const associations=await this.sources(projectId,scope.sessionId,[turnId]);
    const source=associations.found.get(turnId)??null;
    const reviewer=principal.permissions.includes('read')&&principal.permissions.includes('review')&&!workerRunId;
    const worker=!!workerRunId&&source?.kind==='run'&&source.runId===workerRunId;
    const detail=reviewer||worker;
    if(workerRunId&&!worker)throw new DomainError('FORBIDDEN','Worker Run does not own this Turn');
    const native=await this.deps.runner.workspaceHistory(principal,projectId,scope.sessionId,{turnId,itemId,limit:1,detail});
    const raw=native.entries.find(e=>e.turnId===turnId&&e.nativeItemId===itemId);
    if(!raw)throw new DomainError('NOT_FOUND','Native Item was not found in the exact Turn');
    const binding=source&&exactInput(raw,source)
      ? await this.inputBinding(principal,scope,turnId,source,inputRead()):undefined;
    const current=await this.scope(principal,projectId,key);
    if(current.threadId!==scope.threadId||current.nativeSessionId!==scope.nativeSessionId)
      throw new DomainError('FORBIDDEN','Session binding changed during Item read');
    if(raw.kind==='tool'&&!detail)throw new DomainError('FORBIDDEN','Original tool detail requires project review access');
    if(raw.kind==='message'&&raw.role==='assistant')return {...raw,origin:originOf(source),
      author:{kind:'session',id:scope.sessionId,label:scope.title}};
    if(raw.kind==='message'&&raw.role==='input')return this.projectInput(raw,source,
      source?.kind==='message'?associations.messages.get(source.messageId):undefined,binding);
    return {...safeEntry(raw,detail),origin:originOf(source)};
  }
  private projectInput(raw:WorkspaceMessage,source:NativeInputSource|null,message:SessionMessageRecord|undefined,
    binding:InputBinding|undefined):WorkspaceEntry{
    if(!source||!exactInput(raw,source))return nativeInputNotice(raw,inputNoticeReason(raw,source));
    if(!binding?.itemId||binding.itemId!==raw.nativeItemId)
      return nativeInputNotice(raw,binding?.ambiguous||binding?.itemId?'duplicate':'unassociated');
    if(source.kind==='run')return runInput(raw,source);
    if(!message||message.id!==source.messageId)
      throw new DomainError('INPUT_SOURCE_INVALID','Native message source does not match its saved message');
    return {...messageEntry(message,raw.turnId),nativeItemId:raw.nativeItemId,nativeKind:raw.nativeKind,
      occurredAt:raw.occurredAt??message.createdAt,observedAt:raw.observedAt,freshness:raw.freshness,
      ...(raw.order?{order:raw.order}:{})};
  }
  private async inputBindings(principal:Principal,scope:Scope,entries:WorkspaceEntry[],
    sources:ReadonlyMap<string,NativeInputSource>,read:InputRead):Promise<Map<string,InputBinding>>{
    const bindings=new Map<string,InputBinding>();
    for(const raw of entries){
      const source=raw.turnId?sources.get(raw.turnId):undefined;
      if(raw.turnId&&raw.nativeItemId&&source&&exactInput(raw,source)&&!bindings.has(raw.turnId))
        bindings.set(raw.turnId,await this.inputBinding(principal,scope,raw.turnId,source,read));
    }
    return bindings;
  }
  private async inputBinding(principal:Principal,scope:Scope,turnId:string,source:NativeInputSource,
    read:InputRead):Promise<InputBinding>{
    const key=JSON.stringify([turnId,source]);
    const cached=read.proofs.get(key);if(cached)return cached;
    const proof=await this.proveInputBinding(principal,scope,turnId,source,read);
    read.proofs.set(key,proof);
    if(!proof.itemId)read.limitations.add(proof.ambiguous?
      '同一原生 Turn 有多个精确匹配的输入 Item，无法核实唯一发送者绑定。':
      '未能在有界的完整已终结 Turn 中核实唯一输入 Item；业务消息仍可独立读取。');
    return proof;
  }
  private async proveInputBinding(principal:Principal,scope:Scope,turnId:string,source:NativeInputSource,
    read:InputRead):Promise<InputBinding>{
    const unverified:InputBinding={itemId:null,ambiguous:false};
    if(!scope.sessionId||!this.deps.runner)return unverified;
    let cursor:string|undefined,itemId:string|null=null,completedAt:string|null=null;
    const seen=new Set<string>();
    while(read.remaining>0){
      read.remaining--;
      let page:NativeWorkspacePage;
      try{page=await this.deps.runner.workspaceHistory(principal,scope.projectId,scope.sessionId,
        {turnId,limit:50,...(cursor?{cursor}:{})})}
      catch(error){if(error instanceof DomainError&&error.code==='FORBIDDEN')throw error;return unverified}
      // Active or incomplete projections cannot prove a stable unique Item. No timestamp or page-order choice is made.
      const turns=page.turns.filter(turn=>turn.id===turnId),turn=turns[0];
      if(turns.length!==1||!turn?.completedAt||!['completed','failed','interrupted'].includes(turn.state)||
        completedAt!==null&&completedAt!==turn.completedAt||page.entries.length>50||
        page.entries.some(entry=>entry.turnId!==turnId)||page.limitations.length||page.unsupportedKinds.length)return unverified;
      completedAt=turn.completedAt;
      for(const entry of page.entries)if(exactInput(entry,source)){
        if(!entry.nativeItemId)return unverified;
        if(itemId&&itemId!==entry.nativeItemId)return {itemId:null,ambiguous:true};
        itemId=entry.nativeItemId;
      }
      if(!page.nextCursor)return (page.itemEnumerationComplete??!page.partial)?{itemId,ambiguous:false}:unverified;
      if(!page.entries.length||seen.has(page.nextCursor))return unverified;
      seen.add(page.nextCursor);cursor=page.nextCursor;
    }
    return unverified;
  }
}
