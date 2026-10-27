import { randomUUID } from 'node:crypto';
import type { RuntimeBinding, RuntimePage, RuntimeTurn } from '@evoloop/contracts/runtime';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import { SessionMessageService } from '@evoloop/core/session-messages';
import { DomainError } from '@evoloop/contracts/ports';
import { RuntimeProtocolError, RuntimeUnknownError } from '@evoloop/adapter-codex-app-server';
import { bindingOf, finalMessages } from '../runtime/runner.js';

type MessageRuntime={isReady():boolean;registerBinding(binding:RuntimeBinding):Promise<void>;
  qualifyConversationThread?(binding:RuntimeBinding):Promise<{available:boolean;reason:string;fingerprint:string|null}>;
  startConversationTurn?(binding:RuntimeBinding,input:string,operationId:string):Promise<RuntimeTurn>;
  listTurns(binding:RuntimeBinding,cursor?:string):Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding:RuntimeBinding,turnId:string,cursor?:string):Promise<RuntimePage<unknown>>};
const marker=(operationId:string)=>`[evoloop-message-operation:${operationId}]`;
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const textOf=(v:unknown):string=>{const x=object(v);if(typeof x?.text==='string')return x.text;
  return Array.isArray(x?.content)?x.content.map(p=>object(p)?.text).filter(p=>typeof p==='string').join('\n'):'';};
async function collect<T>(load:(cursor?:string)=>Promise<RuntimePage<T>>,maxPages:number):Promise<T[]>{
  const result:T[]=[];let cursor:string|undefined;const seen=new Set<string>();
  for(let i=0;i<maxPages;i++){const page=await load(cursor);result.push(...page.data);
    if(!page.nextCursor)return result;if(seen.has(page.nextCursor))throw new Error('native history cursor repeated');
    seen.add(page.nextCursor);cursor=page.nextCursor;}
  throw new Error('native history exceeds bounded recovery window');
}
export interface SessionMessagePumpDeps {
  service:SessionMessageService;runtime():MessageRuntime;projects():Promise<string[]>;
  /** Must honor original Task answer first and one ready business turn after an ordinary turn. */
  canStart(message:SessionMessageRecord):Promise<boolean>;
  canWrite():boolean;pollIntervalMs:number;onError(error:unknown):void;
}
/** One message at a time per owned thread; only the original operation marker can heal an unknown start. */
export class SessionMessagePump {
  private timer:ReturnType<typeof setInterval>|null=null;private busy:Promise<void>|null=null;
  private nextOffset=new Map<string,number>();
  private nextProjectIndex=0;
  constructor(private readonly deps:SessionMessagePumpDeps){}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick();},this.deps.pollIntervalMs);this.timer.unref();void this.tick();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void>{if(this.busy)return this.busy;this.busy=this.cycle().catch(this.deps.onError).finally(()=>{this.busy=null;});return this.busy;}
  private async cycle():Promise<void>{
    if(!this.deps.canWrite()||!this.deps.runtime().isReady())return;
    let processed=0;
    const projects=await this.deps.projects();
    if(!projects.length)return;
    const start=this.nextProjectIndex%projects.length;
    this.nextProjectIndex=(start+1)%projects.length;
    for(const projectId of [...projects.slice(start),...projects.slice(0,start)]){
      if(processed>=30)return;
      const pageLimit=30-processed;
      let offset=this.nextOffset.get(projectId)??0;
      let page=await this.deps.service.pending(projectId,pageLimit,offset);
      if(!page.length&&offset>0){offset=0;page=await this.deps.service.pending(projectId,pageLimit,offset);}
      const nextOffset=offset+page.length;
      this.nextOffset.set(projectId,page.length<pageLimit||!Number.isSafeInteger(nextOffset)?0:nextOffset);
      for(const message of page){
        processed++;
        try{await this.process(message);}catch(error){this.deps.onError(error);}
      }
    }
  }
  private async process(message:SessionMessageRecord):Promise<void>{
    if(message.target.kind!=='owned')return;
    const session=await this.deps.service.session(message.projectId,message.target.sessionId);
    if(session.state!=='ready'||!session.nativeThreadId||!session.nativeSessionId)return;
    const binding=bindingOf(session);
    const runtime=this.deps.runtime();
    let record=await this.deps.service.processing(message.projectId,message.id);
    if(message.state==='queued'){
      if(record)return;
      try{await this.deps.service.preflightDispatch(message.projectId,message.id);}
      catch(error){
        if(error instanceof DomainError){await this.deps.service.noteBlocked(message.projectId,message.id,error.message);return;}
        throw error;
      }
      if(!await this.deps.canStart(message))return;
      await runtime.registerBinding(binding);
      if(!runtime.startConversationTurn||!runtime.qualifyConversationThread){
        await this.deps.service.noteBlocked(message.projectId,message.id,'Native Session execution profile verification is unavailable');return;
      }
      const qualification=await runtime.qualifyConversationThread(binding);
      if(!qualification.available||!qualification.fingerprint){
        await this.deps.service.noteBlocked(message.projectId,message.id,qualification.reason);return;
      }
      // Persist before any native resume or Turn start. A lost response is never a retry signal.
      try{record=await this.deps.service.beginDispatch(message.projectId,message.id,randomUUID(),randomUUID(),qualification.fingerprint);}
      catch(error){
        if(error instanceof DomainError&&['SESSION_BUSY','MESSAGE_GRANT_MISSING','MESSAGE_BUDGET_EXHAUSTED','SESSION_NOT_READY','MESSAGE_NOT_QUEUED'].includes(error.code)){
          await this.deps.service.noteBlocked(message.projectId,message.id,error.message);return;
        }
        throw error;
      }
      const input=`${marker(record.operationId)}\nOrdinary Session conversation using this Session's normal tools and full execution permissions. Act within the user's request and project identity. A reply does not by itself record Task delivery or acceptance.\n${message.context?`Fixed Task context: ${message.context.taskId}@${message.context.taskRevisionId}\n`:''}${message.content}`;
      try{const turn=await runtime.startConversationTurn(binding,input,record.operationId);
        await this.deps.service.bindTurn(message.projectId,message.id,turn);}
      catch(error){
        if(error instanceof RuntimeProtocolError && !(error instanceof RuntimeUnknownError))
          await this.deps.service.failBeforeStart(message.projectId,message.id,`Native pre-turn rejection: ${error.message}`);
        else await this.deps.service.markUnknown(message.projectId,message.id,'Native start acknowledgement unavailable; reconcile original marker before any retry');
      }
      return;
    }
    if(!record)return;
    await runtime.registerBinding(binding);
    // Bound the automatic native read: at most two pages for a known Turn and
    // the first 20 listed Turns for an unknown start. A miss remains unknown.
    const first=await runtime.listTurns(binding);
    let nativeTurnId=record.nativeTurnId;
    if(!nativeTurnId){
      const matches:RuntimeTurn[]=[];
      for(const turn of first.data.slice(0,20)){
        const items=await collect(cursor=>runtime.listItems(binding,turn.id,cursor),10);
        if(items.some(item=>object(item)?.type==='userMessage'&&textOf(item).startsWith(marker(record!.operationId))))matches.push(turn);
      }
      if(matches.length!==1){if(record.state==='dispatching')await this.deps.service.markUnknown(message.projectId,message.id,'No unique original operation marker in owned native history');return;}
      await this.deps.service.bindTurn(message.projectId,message.id,matches[0]!);
      nativeTurnId=matches[0]!.id;
    }
    let turn=first.data.find(t=>t.id===nativeTurnId);
    if(!turn&&first.nextCursor)turn=(await runtime.listTurns(binding,first.nextCursor)).data.find(t=>t.id===nativeTurnId);
    if(!turn){await this.deps.service.markUnknown(message.projectId,message.id,'Bound native Turn is not currently readable');return;}
    if(!turn.completedAtUtc||!['completed','failed','interrupted'].includes(turn.status))return;
    const items=await collect(cursor=>runtime.listItems(binding,turn.id,cursor),10);
    await this.deps.service.settle(message.projectId,message.id,turn,finalMessages(items).join('\n\n')||null);
  }
}
