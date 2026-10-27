import type { AppliedResult, Command, Principal } from "@evoloop/contracts";
import type { NativeInputCapture, NativeInputRecord } from "@evoloop/contracts/native-input";
import type { Clock, IdFactory, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
export type NativeInputReplyCommand = Extract<Command,{type:'session.input.reply'}>;
const required = <T>(value:T|null,label:string):T => {if(value===null)throw new DomainError('NOT_FOUND',`${label} not found`);return value;};
const validText = (value:string,max:number) => value.length>0 && value.trim().length>0 && value.length<=max;
const latestUtc=(...values:string[]):string=>new Date(Math.max(...values.map(value=>Date.parse(value)))).toISOString();
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:
  value&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:
  JSON.stringify(value);

function validateCapture(c:NativeInputCapture):void {
  if(!c.id||!c.sessionId||!c.connectionId||!validText(c.threadId,1024)||
    (c.turnId!==null&&!validText(c.turnId,1024))||(c.itemId!==null&&!validText(c.itemId,1024))||
    (c.supported&&(c.turnId===null||c.itemId===null))||
    !(typeof c.nativeRequestId==='number' ? Number.isSafeInteger(c.nativeRequestId) : validText(c.nativeRequestId,1024))||
    (c.supported&&c.questions.length<1)||c.questions.length>3||c.unavailableReason?.length && c.unavailableReason.length>4000)
    throw new DomainError('INPUT_INVALID','Native input identity or size is invalid');
  const seen=new Set<string>();
  for(const q of c.questions){
    if(!validText(q.id,120)||seen.has(q.id)||!validText(q.header,120)||!validText(q.question,4000)||
      q.options && (q.options.length<1||q.options.length>8))throw new DomainError('INPUT_INVALID','Native question is invalid');
    seen.add(q.id);
    if(q.options){const labels=new Set<string>();for(const option of q.options){
      if(!validText(option.label,240)||option.description.length>1000||labels.has(option.label))
        throw new DomainError('INPUT_INVALID','Native option is invalid');labels.add(option.label);
    }}
  }
  if(new TextEncoder().encode(JSON.stringify(c)).byteLength>32768)throw new DomainError('INPUT_TOO_LARGE','Native input exceeds storage budget');
}

export async function applyNativeInputReply(tx:Transaction,principal:Principal,c:NativeInputReplyCommand,now:string):Promise<{result:AppliedResult;effects:{kind:string;entityId:string;version:number}[]}>{
  const store=tx.nativeInputs;if(!store)throw new DomainError('NATIVE_INPUT_UNAVAILABLE','Native input persistence is unavailable');
  const value=required(await store.get(c.projectId,c.inputRequestId),'native input');
  if(value.version!==c.expectedVersion)throw new DomainError('VERSION_CONFLICT','Native input changed',value.version);
  if(value.state!=='pending'||!value.supported||!value.source)throw new DomainError('INPUT_NOT_REPLYABLE','Native input is not awaiting a supported reply');
  if(principal.actorId!==value.source.actorId&&!principal.permissions.includes('review'))
    throw new DomainError('FORBIDDEN','Only the initiating actor or project reviewer may reply');
  const keys=Object.keys(c.answers);
  if(keys.length!==value.questions.length||value.questions.some(q=>!Object.hasOwn(c.answers,q.id)))
    throw new DomainError('INPUT_ANSWERS','Every native question requires exactly one answer entry');
  for(const q of value.questions){
    const answers=c.answers[q.id]!;
    if(answers.length<1||answers.length>8||answers.some(a=>!validText(a,4000)))
      throw new DomainError('INPUT_ANSWERS','Answers must contain one to eight nonblank strings');
    if(q.options&&!q.isOther){const labels=new Set(q.options.map(o=>o.label));
      if(answers.some(a=>!labels.has(a)))throw new DomainError('INPUT_ANSWERS','Answer must match a native option');
    }
  }
  if(new TextEncoder().encode(JSON.stringify(c.answers)).byteLength>16384)
    throw new DomainError('INPUT_TOO_LARGE','Answers exceed 16 KiB');
  const next:NativeInputRecord={...value,state:'response_saved',version:value.version+1,
    response:{operationId:c.operationId,actorId:principal.actorId,answers:c.answers,savedAt:now,attemptedAt:null,submittedAt:null,outcome:'pending'},updatedAt:now};
  await store.update(next,value.version);
  return{result:{status:'applied',operationId:c.operationId,entityId:value.id,version:next.version},
    effects:[{kind:'session.input',entityId:value.id,version:next.version}]};
}

export class NativeInputService {
  constructor(private readonly deps:{uow:UnitOfWork;clock:Clock;ids:IdFactory}){}
  async get(projectId:string,id:string){return this.deps.uow.read(projectId,async r=>r.nativeInputs?.get(projectId,id)??null);}
  async list(projectId:string,sessionId:string,limit=20){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_PAGE','Limit must be 1..100');
    return this.deps.uow.read(projectId,async r=>r.nativeInputs?.list(projectId,sessionId,limit)??[]);
  }
  async pendingResponses(projectId:string,limit=20){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_PAGE','Limit must be 1..100');
    return this.deps.uow.read(projectId,async r=>r.nativeInputs?.pendingResponses(projectId,limit)??[]);
  }
  async capture(c:NativeInputCapture):Promise<NativeInputRecord>{
    validateCapture(c);
    return this.deps.uow.transaction(c.projectId,async tx=>{
      const store=tx.nativeInputs;if(!store)throw new DomainError('NATIVE_INPUT_UNAVAILABLE','Native input persistence is unavailable');
      const existing=await store.get(c.projectId,c.id);
      if(existing){const {version,state,source,response,reason,createdAt,updatedAt,...original}=existing;
        if(canonical(original)!==canonical(c))throw new DomainError('INPUT_ID_REUSED','Native input ID identifies different content');
        return existing;
      }
      const session=required(await tx.getRuntimeSession(c.sessionId),'Session');
      if(session.projectId!==c.projectId||session.state!=='ready'||session.nativeThreadId!==c.threadId)
        throw new DomainError('SESSION_NOT_READY','Native input must belong to a ready owned Session and exact Thread');
      const source=c.turnId?await store.findSource(c.projectId,c.sessionId,c.turnId):null;
      const value:NativeInputRecord={...c,version:1,state:c.supported?'pending':'unavailable',source,response:null,
        reason:c.supported?null:c.unavailableReason??'unsupported',createdAt:c.observedAt,updatedAt:c.observedAt};
      await store.insert(value);return value;
    });
  }
  async refreshSources(projectId:string,sessionId:string):Promise<number>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.nativeInputs;if(!store)return 0;let count=0;
      for(const value of await store.unlinked(projectId,sessionId,100)){
        const source=value.turnId?await store.findSource(projectId,sessionId,value.turnId):null;
        if(source){await store.update({...value,source,version:value.version+1,updatedAt:this.deps.clock.now()},value.version);count++;}
      }return count;
    });
  }
  async closed(projectId:string,id:string,connectionId:string,reason:'native_resolved'|'disconnected'|'unsupported'|'request_unavailable'|'authorization_revoked',at:string):Promise<NativeInputRecord|null>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.nativeInputs;if(!store)return null;const value=await store.get(projectId,id);
      if(!value||value.connectionId!==connectionId||['resolved','unavailable'].includes(value.state))return value;
      const next:NativeInputRecord={...value,state:reason==='native_resolved'?'resolved':'unavailable',reason,
        version:value.version+1,updatedAt:latestUtc(value.updatedAt,at,this.deps.clock.now())};await store.update(next,value.version);return next;
    });
  }
  async invalidateConnections(projectId:string,currentConnectionId:string):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{await tx.nativeInputs?.invalidateConnections(projectId,currentConnectionId,this.deps.clock.now());});
  }
  async claimResponse(projectId:string,id:string,connectionId:string):Promise<NativeInputRecord|null>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.nativeInputs;if(!store)return null;const v=await store.get(projectId,id);
      if(!v||v.connectionId!==connectionId||v.state!=='response_saved'||v.response?.outcome!=='pending')return null;
      const at=this.deps.clock.now();const next:NativeInputRecord={...v,version:v.version+1,updatedAt:at,
        response:{...v.response,attemptedAt:at,outcome:'attempted'}};await store.update(next,v.version);return next;
    });
  }
  async finishResponse(projectId:string,id:string,connectionId:string,outcome:'submitted'|'unknown',at:string):Promise<NativeInputRecord|null>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.nativeInputs;if(!store)return null;const v=await store.get(projectId,id);
      if(!v||v.connectionId!==connectionId||v.response?.outcome!=='attempted')return v;
      const next:NativeInputRecord={...v,version:v.version+1,updatedAt:latestUtc(v.updatedAt,at,this.deps.clock.now()),
        response:{...v.response,outcome,submittedAt:outcome==='submitted'?at:null}};
      await store.update(next,v.version);return next;
    });
  }
}
