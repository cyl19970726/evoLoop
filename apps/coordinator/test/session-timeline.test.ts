import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeInputSource } from '@evoloop/contracts/native-input';
import type { SessionMessageRecord, SessionMessageProcessing } from '@evoloop/contracts/session-messages';
import type { NativeWorkspacePage, WorkspaceEntry, WorkspaceRuntimeUpdate } from '@evoloop/contracts/session-timeline';
import { DomainError } from '@evoloop/contracts/ports';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import type { RuntimeRunner } from '../src/runtime/runner.js';
import { SessionTimelineService } from '../src/session-timeline/index.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),sessionId=id(2),key=`owned:${sessionId}`,thread='native-thread',now='2026-11-01T00:00:00.000Z';
const reader:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
const reviewer:Principal={...reader,actorId:'reviewer',permissions:['read','review']};
const nativeInput=(itemId:string,turnId:string,clientId:string|null=null,body='private dispatch credential'):WorkspaceEntry=>({id:`native:${thread}:${turnId}:${itemId}`,
  kind:'message',role:'input',phase:'unknown',body,clientId,state:'completed',
  turnId,nativeItemId:itemId,nativeKind:'userMessage',author:{kind:'native',id:null,label:'Native input'},origin:null,
  occurredAt:null,observedAt:now,freshness:'persisted',truncated:false,
  order:{kind:'native-item',key:`${turnId}:${itemId}`,position:1,generation:'test-history'}});
const agent=(itemId:string,turnId:string):WorkspaceEntry=>({id:`native:${thread}:${turnId}:${itemId}`,
  kind:'message',role:'assistant',phase:'final_answer',body:'Public answer',clientId:null,state:'completed',
  turnId,nativeItemId:itemId,nativeKind:'agentMessage',author:{kind:'session',id:sessionId,label:'Agent'},origin:null,
  occurredAt:null,observedAt:now,freshness:'persisted',truncated:false});
const tool:WorkspaceEntry={id:`native:${thread}:turn-run:tool-1`,kind:'tool',turnId:'turn-run',nativeItemId:'tool-1',
  nativeKind:'commandExecution',author:{kind:'session',id:sessionId,label:'Agent'},origin:null,occurredAt:null,
  observedAt:now,freshness:'persisted',truncated:false,name:'command',summary:'Read 2 files',state:'completed',
  durationMs:10,exitCode:0,detailAvailable:true,detailReason:null,
  detail:{input:'private command',output:'private output',error:null,resources:[]}};
const pg=(n:number,state:SessionMessageRecord['state'],sender:string):SessionMessageRecord=>({projectId:project,id:id(n),
  operationId:id(n+100),target:{kind:'owned',sessionId},senderActorId:sender,content:`Message ${n} from ${sender}`,
  context:null,replyToMessageId:null,state,version:1,blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now});
const sourceMessage:NativeInputSource={kind:'message',messageId:id(10),processingId:id(110),operationId:id(210),actorId:'human-a'};
const sourceRun:NativeInputSource={kind:'run',runId:id(30),operationId:id(130),actorId:'dispatcher',taskId:id(40),taskRevisionId:id(41)};
const session:RuntimeSessionRecord={projectId:project,id:sessionId,roleId:'role',cwd:'/tmp',authorizationScope:'scope',
  model:null,sandbox:'read-only',approvalPolicy:'on-request',state:'ready',version:1,nativeThreadId:thread,
  nativeSessionId:'native-session',operationId:id(99),actorId:'agent',createdAt:now,updatedAt:now};
function harness(){
  const messages=[pg(10,'replied','human-a'),pg(11,'queued','other-agent')];
  const process:SessionMessageProcessing={projectId:project,id:id(110),messageId:id(10),sessionId,
    operationId:id(210),state:'completed',nativeTurnId:'turn-message',response:'Public answer',failure:null,
    version:1,startedAt:now,updatedAt:now};
  let revoked=false,historyAvailable=true,historicalRunning=false,ambiguous=false,historyCalls=0,starts=0,withoutProof=false,
    lateBinding=false,conflictingProof=false,duplicateInput=false;
  let update:((event:WorkspaceRuntimeUpdate)=>void)|null=null,disconnect:(()=>void)|null=null;
  const sources=new Map([['turn-message',sourceMessage],['turn-run',sourceRun]]);
  const uow={read:async (_project:string,fn:(r:unknown)=>Promise<unknown>)=>fn({
    getRuntimeSession:async()=>revoked?null:session,
    nativeInputs:{findSources:async (_p:string,_s:string,turnIds:string[])=>{
      if(ambiguous)throw new DomainError('INPUT_SOURCE_AMBIGUOUS','two sources');
      return new Map(turnIds.flatMap(turnId=>sources.has(turnId)?[[turnId,sources.get(turnId)!]]:[]));}},
    sessionMessages:{listSessionMessages:async (_target:unknown,limit:number,cursor?:string)=>{
      const start=cursor?messages.findIndex(m=>m.id===cursor)+1:0;
      return {items:messages.slice(start,start+limit),nextCursor:start+limit<messages.length?messages[start+limit-1]!.id:null};},
      listSessionMessageProcessing:async(ids:string[])=>ids.includes(process.messageId)?[process]:[],
      getSessionMessages:async(ids:string[])=>messages.filter(m=>ids.includes(m.id))}
  })} as unknown as UnitOfWork;
  const observation={snapshot:async(p:Principal,projectId:string,requestKey:string)=>{
    if(revoked||!p.projectIds.includes(projectId)||!p.permissions.includes('read')||requestKey!==key)
      throw new DomainError('FORBIDDEN','scope');
    return {session:{key,target:{kind:'owned',sessionId},title:'Session'}};
  }} as unknown as SessionObservationService;
  const runner={workspaceBinding:async()=>{
    if(revoked)throw new DomainError('FORBIDDEN','binding revoked');
    return {nativeThreadId:thread,nativeSessionId:'native-session'};},
    workspaceHistory:async(_p:Principal,_project:string,_session:string,options:{cursor?:string;turnId?:string;itemId?:string;detail?:boolean})=>{
      historyCalls++;
      if(!historyAvailable)throw new DomainError('RUNTIME_READ_UNAVAILABLE','offline');
      const firstInput={...nativeInput('input-1','turn-message',withoutProof?null:
        conflictingProof?id(211):sourceMessage.operationId,
        withoutProof?'Message 10 from human-a':'private dispatch credential'),
        ...(conflictingProof?{inputReference:{kind:'operation-marker' as const,source:'message' as const,
          operationId:sourceMessage.operationId}}:{})};
      const duplicate=nativeInput('input-duplicate','turn-message',sourceMessage.operationId);
      const inputs=duplicateInput?[firstInput,duplicate]:[firstInput];
      const entries=options.itemId?[tool,...inputs,nativeInput('input-other','turn-message'),agent('answer-1','turn-message')]
        .filter(e=>e.nativeItemId===options.itemId):
        lateBinding?options.cursor?[firstInput]:[{
          ...tool,id:`native:${thread}:turn-message:tool-source`,turnId:'turn-message',nativeItemId:'tool-source'}]:
        options.cursor?[nativeInput('input-2','turn-run',sourceRun.operationId),tool,agent('answer-2','turn-run')]:
        [...inputs,nativeInput('input-other','turn-message'),agent('answer-1','turn-message')];
      const turnId=options.itemId?'turn-run':lateBinding?'turn-message':options.cursor?'turn-run':'turn-message';
      return {entries,turns:[{id:turnId,state:historicalRunning?'running':'completed',startedAt:now,completedAt:now,origin:null}],
        nextCursor:options.itemId||options.cursor?null:'native-next',observedAt:now,historyMode:'paginated',
        method:'items',partial:false,limitations:[],unsupportedKinds:[]} satisfies NativeWorkspacePage;
    },
    nativeAdapter:()=>({onWorkspaceUpdate:true,startTurn:()=>{starts++}}),
    status:()=>({available:true}),
    onWorkspaceUpdate:(fn:(event:WorkspaceRuntimeUpdate)=>void)=>{update=fn;return()=>{update=null}},
    onWorkspaceDisconnect:(fn:()=>void)=>{disconnect=fn;return()=>{disconnect=null}},
  } as unknown as RuntimeRunner;
  const service=new SessionTimelineService({uow,observation,runner});
  return {service,messages,runner,emit:(event:WorkspaceRuntimeUpdate)=>update?.(event),
    disconnect:()=>disconnect?.(),setHistory:(v:boolean)=>{historyAvailable=v},revoke:()=>{revoked=true},
    historicalRunning:()=>{historicalRunning=true},
    ambiguous:()=>{ambiguous=true},unlink:()=>{sources.delete('turn-message')},
    withoutProof:()=>{withoutProof=true},lateBinding:()=>{lateBinding=true},
    conflictingProof:()=>{conflictingProof=true},duplicateInput:()=>{duplicateInput=true},
    calls:()=>({historyCalls,starts})};
}

test('exact PG sender replaces native input, Run context hides envelope, and paging advances independently',async()=>{
  const h=harness();
  const first=await h.service.page(reader,project,key,{limit:1});
  assert.equal(first.entries[0]?.kind,'message');
  assert.equal((first.entries[0] as {body:string}).body,'Message 10 from human-a');
  assert.equal(first.entries[0]?.author.id,'human-a');
  assert.equal(first.entries[1]?.kind,'notice');
  assert.equal(first.entries[1]?.id,`native:${thread}:turn-message:input-other`);
  assert.equal(first.entries[1]?.origin,null);
  assert.equal(first.entries.filter(e=>e.id===`message:${id(10)}`).length,1);
  const exactDetail=await h.service.item(reader,project,key,'turn-message','input-1');
  assert.equal(exactDetail.id,`message:${id(10)}`);
  const unrelatedDetail=await h.service.item(reader,project,key,'turn-message','input-other');
  assert.equal(unrelatedDetail.kind,'notice');
  assert.equal(unrelatedDetail.author.id,null);
  assert.equal(first.pending.length,0);
  assert.ok(first.nextCursor&&first.messagesCursor);
  const second=await h.service.page(reader,project,key,{limit:1,cursor:first.nextCursor!,messagesCursor:first.messagesCursor!});
  assert.equal((second.entries[0] as {body:string}).body,'项目派发任务');
  assert.equal(second.entries[0]?.author.id,'dispatcher');
  assert.equal(second.entries[0]?.origin?.kind,'run');
  assert.equal(second.entries[0]?.origin?.taskId,id(40));
  assert.equal(second.pending[0]?.author.id,'other-agent');
  assert.equal(second.pending[0]?.state,'pending');
  assert.equal(second.nextCursor,null);
  assert.equal(second.messagesCursor,null);
  const nativeOnly=await h.service.page(reader,project,key,{limit:1,source:'native',cursor:first.nextCursor!});
  assert.equal(nativeOnly.pending.length,0);
  assert.equal(nativeOnly.messagesCursor,null);
  const readsBeforeMessages=h.calls().historyCalls;
  const messagesOnly=await h.service.page(reader,project,key,{limit:1,source:'messages',messagesCursor:first.messagesCursor!});
  assert.equal(h.calls().historyCalls,readsBeforeMessages,'message continuation never reopens native history');
  assert.equal(messagesOnly.entries.length,0);
  assert.equal(messagesOnly.nextCursor,null);
  assert.equal(messagesOnly.pending[0]?.id,`message:${id(11)}`);
  assert.equal(h.calls().starts,0);
  h.service.close();
});

test('source ambiguity, cursor scope, revoked binding and original detail remain fenced',async()=>{
  const h=harness();
  const page=await h.service.page(reader,project,key,{limit:1});
  await assert.rejects(h.service.page({...reader,actorId:'someone-else'},project,key,{limit:1,cursor:page.nextCursor!}),
    (error:unknown)=>error instanceof DomainError&&error.code==='INVALID_CURSOR');
  await assert.rejects(h.service.page(reader,id(9),key,{limit:1}),DomainError);
  await assert.rejects(h.service.page(reader,project,`owned:${id(9)}`,{limit:1,cursor:page.nextCursor!}),DomainError);
  await assert.rejects(h.service.page({...reader,permissions:[]},project,key,{limit:1}),DomainError);
  await assert.rejects(h.service.item(reader,project,key,'turn-run','tool-1'),
    (error:unknown)=>error instanceof DomainError&&error.code==='FORBIDDEN');
  const publicAnswer=await h.service.item(reader,project,key,'turn-message','answer-1');
  assert.equal((publicAnswer as {body:string}).body,'Public answer');
  const detail=await h.service.item(reviewer,project,key,'turn-run','tool-1');
  assert.equal(detail.kind,'tool');if(detail.kind==='tool')assert.equal(detail.detail?.output,'private output');
  const reviewerPage=await h.service.page(reviewer,project,key,{limit:1,cursor:(await h.service.page(reviewer,project,key,{limit:1})).nextCursor!});
  const reviewedTool=reviewerPage.entries.find(e=>e.kind==='tool');
  assert.equal(reviewedTool?.kind,'tool');
  if(reviewedTool?.kind==='tool'){assert.equal(reviewedTool.detailAvailable,true);assert.equal(reviewedTool.detail,undefined)}
  await assert.rejects(h.service.item(reviewer,project,key,'turn-run','tool-1',id(999)),DomainError);
  h.ambiguous();
  await assert.rejects(h.service.page(reader,project,key,{limit:1}),
    (error:unknown)=>error instanceof DomainError&&error.code==='INPUT_SOURCE_AMBIGUOUS');
  h.revoke();
  await assert.rejects(h.service.updates(reader,project,key),DomainError);
  h.service.close();
});

test('JSON cursors must decode to objects and valid continuation still resumes',async()=>{
  const h=harness();
  const first=await h.service.page(reader,project,key,{limit:1});
  assert.ok(first.nextCursor&&first.messagesCursor);
  for(const invalid of ['bnVsbA','MA','W10']){
    for(const query of [{source:'native' as const,cursor:invalid},
      {source:'messages' as const,messagesCursor:invalid}]){
      await assert.rejects(h.service.page(reader,project,key,{limit:1,...query}),
        (error:unknown)=>error instanceof DomainError&&error.code==='INVALID_CURSOR');
    }
    await assert.rejects(h.service.updates(reader,project,key,invalid),
      (error:unknown)=>error instanceof DomainError&&error.code==='INVALID_CURSOR');
  }
  const next=await h.service.page(reader,project,key,{limit:1,cursor:first.nextCursor,
    messagesCursor:first.messagesCursor});
  assert.equal(next.nextCursor,null);
  assert.equal(next.messagesCursor,null);
  assert.equal(h.calls().starts,0);
  h.service.close();
});

test('unavailable native history retains saved messages and reply fallback with explicit partial status',async()=>{
  const h=harness();h.setHistory(false);
  const page=await h.service.page(reader,project,key,{limit:2});
  assert.equal(page.capabilities.history,false);
  assert.equal(page.partial,true);
  assert.equal(page.pending.length,2);
  assert.equal(page.entries[0]?.id,`message-response:${id(10)}`);
  assert.equal((page.entries[0] as {body:string}).body,'Public answer');
  const messagesOnly=await h.service.page(reader,project,key,{limit:1,source:'messages'});
  assert.equal(messagesOnly.nextCursor,null);
  assert.equal(messagesOnly.entries[0]?.id,`message-response:${id(10)}`);
  h.service.close();
});

test('unlinked native input stays native and never exposes the injected dispatch body',async()=>{
  const h=harness();h.unlink();
  const page=await h.service.page(reader,project,key,{limit:1});
  assert.equal(page.entries[0]?.author.kind,'native');
  assert.equal(page.entries[0]?.origin,null);
  assert.equal(page.entries[0]?.kind,'notice');
  assert.equal((page.entries[0] as {body:string}).body,'未能核实此原生输入的业务发送者。');
  assert.equal(page.pending[0]?.author.id,'human-a');
  h.service.close();
});

test('a matching Turn and identical text never prove native input ownership without an Item marker',async()=>{
  const h=harness();h.withoutProof();
  const page=await h.service.page(reader,project,key,{limit:1});
  assert.equal(page.pending[0]?.id,`message:${id(10)}`,'saved message stays separate from unproved native Items');
  assert.equal(page.pending[0]?.nativeItemId,null);
  assert.equal(page.pending[0]?.turnId,'turn-message');
  assert.equal(page.entries[0]?.id,`native:${thread}:turn-message:input-1`);
  assert.equal(page.entries[0]?.kind,'notice');
  assert.equal(page.entries[0]?.author.id,null);
  assert.equal(page.entries[0]?.origin,null);
  const detail=await h.service.item(reader,project,key,'turn-message','input-1');
  assert.equal(detail.kind,'notice');
  assert.equal(detail.id,`native:${thread}:turn-message:input-1`);
  assert.equal((detail as {body:string}).body.includes('Message 10'),false);
  h.service.close();
});

test('contradictory client ID and operation marker fail closed on page, detail and live',async()=>{
  const h=harness();h.conflictingProof();
  const page=await h.service.page(reader,project,key,{limit:1});
  assert.equal(page.entries[0]?.kind,'notice');
  assert.equal(page.entries[0]?.id,`native:${thread}:turn-message:input-1`);
  assert.equal(page.entries[0]?.author.id,null);
  assert.equal(page.entries[0]?.origin,null);
  assert.equal(page.entries[0]?.kind==='notice'&&page.entries[0].label,'标识冲突的原生输入');
  assert.equal(page.pending[0]?.id,`message:${id(10)}`);
  const detail=await h.service.item(reader,project,key,'turn-message','input-1');
  assert.equal(detail.kind,'notice');
  assert.equal(detail.id,`native:${thread}:turn-message:input-1`);
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,kind:'entry',
    entry:{...nativeInput('live-conflict','turn-message',sourceMessage.operationId),
      inputReference:{kind:'operation-marker',source:'run',operationId:sourceRun.operationId}}});
  const live=await h.service.updates(reader,project,key);
  assert.equal(live.entries[0]?.kind,'notice');
  assert.equal(live.entries[0]?.id,`native:${thread}:turn-message:live-conflict`);
  assert.equal(live.entries[0]?.author.id,null);
  h.service.close();
});

test('a second exact native Item stays visible as a stable duplicate notice',async()=>{
  const h=harness();h.duplicateInput();
  const page=await h.service.page(reader,project,key,{limit:1});
  assert.equal(page.entries.filter(entry=>entry.id===`message:${id(10)}`).length,1);
  assert.equal(page.entries[1]?.kind,'notice');
  assert.equal(page.entries[1]?.id,`native:${thread}:turn-message:input-duplicate`);
  assert.equal(page.entries[1]?.nativeItemId,'input-duplicate');
  assert.equal(page.entries[1]?.kind==='notice'&&page.entries[1].label,'重复的原生输入');
  assert.equal(page.entries[1]?.origin,null);
  assert.equal((page.entries[1] as {body:string}).body.includes('private dispatch credential'),false);
  const detail=await h.service.item(reader,project,key,'turn-message','input-duplicate');
  assert.equal(detail.kind,'notice');
  assert.equal(detail.id,`native:${thread}:turn-message:input-duplicate`);
  assert.equal(detail.kind==='notice'&&detail.label,'重复的原生输入');
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:nativeInput('live-first','turn-message',sourceMessage.operationId)});
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:nativeInput('live-duplicate','turn-message',sourceMessage.operationId)});
  const live=await h.service.updates(reader,project,key);
  assert.equal(live.entries[0]?.id,`message:${id(10)}`);
  assert.equal(live.entries[1]?.id,`native:${thread}:turn-message:live-duplicate`);
  assert.equal(live.entries[1]?.kind,'notice');
  h.service.close();
});

test('late native input proof moves the saved message from pending to its canonical Item position',async()=>{
  const h=harness();h.lateBinding();
  const first=await h.service.page(reader,project,key,{limit:1});
  assert.equal(first.entries[0]?.id,`native:${thread}:turn-message:tool-source`);
  assert.equal(first.entries[0]?.kind,'tool');
  assert.equal(first.pending[0]?.id,`message:${id(10)}`);
  assert.equal(first.pending[0]?.turnId,'turn-message');
  const later=await h.service.page(reader,project,key,{limit:1,cursor:first.nextCursor!,messagesCursor:first.messagesCursor!});
  assert.equal(later.entries[0]?.id,`message:${id(10)}`);
  assert.equal(later.entries[0]?.nativeItemId,'input-1');
  assert.equal(later.entries[0]?.order?.kind,'native-item');
  assert.equal(later.pending.filter(m=>m.id===`message:${id(10)}`).length,0);
  h.service.close();
});

test('live delta completes one stable Item; disconnect and bounded overflow force reset',async()=>{
  const h=harness();
  const initial=await h.service.updates(reader,project,key);
  assert.equal(initial.freshness,'unavailable','global adapter readiness does not prove this Thread is live');
  assert.equal(initial.entries.length,0);
  const entry=agent('live-1','turn-live');
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-live',observedAt:now,kind:'entry',entry:{...entry,body:'A'}});
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-live',observedAt:now,
    kind:'text-delta',itemId:'live-1',delta:'B',truncated:true});
  const clipped=await h.service.updates(reader,project,key,initial.cursor);
  assert.equal(clipped.freshness,'live');
  assert.equal(clipped.entries[0]?.truncated,true);
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-live',observedAt:now,kind:'entry',entry:{...entry,body:'ABC'}});
  const changed=await h.service.updates(reader,project,key,initial.cursor);
  assert.equal(changed.entries.length,1);
  assert.equal((changed.entries[0] as {body:string}).body,'ABC');
  h.disconnect();
  const stale=await h.service.updates(reader,project,key,changed.cursor);
  assert.equal(stale.resetRequired,true);
  assert.equal(stale.entries[0]?.freshness,'stale');
  const cursor=stale.cursor;
  for(let i=0;i<270;i++)h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-live',observedAt:now,
    kind:'text-delta',itemId:'live-1',delta:'x'});
  const overflow=await h.service.updates(reader,project,key,cursor);
  assert.equal(overflow.resetRequired,true);
  assert.equal(overflow.entries.length,1);
  h.service.close();
});

test('only a current scoped start owns active Turn identity across terminal, late events and disconnect',async()=>{
  const h=harness();h.historicalRunning();
  const turn=(turnId:string,state:'running'|'completed',boundary:'start'|'complete'):WorkspaceRuntimeUpdate=>({
    projectId:project,sessionId,threadId:thread,turnId,observedAt:now,kind:'turn',
    turn:{id:turnId,state,startedAt:now,completedAt:state==='completed'?now:null,origin:null,
      order:{kind:'turn-boundary',key:`boundary:${thread}:${turnId}:${boundary}`,position:null,generation:'connection-a'}}});
  const initial=await h.service.updates(reader,project,key);
  assert.equal(initial.activeTurnId,null);
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'tool-only',observedAt:now,
    kind:'entry',entry:{...tool,turnId:'tool-only',state:'running'}});
  const toolOnly=await h.service.updates(reader,project,key);
  assert.equal(toolOnly.activeTurnId,null);
  assert.equal(toolOnly.entries[0]?.kind,'tool');
  assert.equal(toolOnly.entries[0]?.state,'running','a tool remains visible without inferred Turn activity');
  h.emit(turn('current','running','start'));
  const started=await h.service.updates(reader,project,key);
  assert.equal(started.activeTurnId,'current');
  assert.equal((await h.service.updates(reader,project,key,started.cursor)).activeTurnId,'current',
    'empty updates retain the current scoped Turn');
  h.emit(turn('current','completed','complete'));
  const completed=await h.service.page(reader,project,key,{limit:1});
  assert.equal(completed.turns[0]?.state,'running','historical metadata remains visibly uncertain');
  assert.equal(completed.live.freshness,'live');
  assert.equal(completed.live.activeTurnId,null,'qualified connection does not revive historical running metadata');
  h.emit(turn('current','running','start'));
  const lateStart=await h.service.updates(reader,project,key);
  assert.equal(lateStart.activeTurnId,null);
  assert.equal(lateStart.turns.find(t=>t.id==='current')?.state,'completed');
  h.emit(turn('new','running','start'));
  assert.equal((await h.service.updates(reader,project,key)).activeTurnId,'new');
  h.emit(turn('current','completed','complete'));
  assert.equal((await h.service.updates(reader,project,key)).activeTurnId,'new',
    'an older terminal event cannot clear the newer active Turn');
  h.disconnect();
  const stale=await h.service.updates(reader,project,key);
  assert.equal(stale.activeTurnId,null);
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'new',observedAt:now,
    kind:'entry',entry:{...tool,turnId:'new',state:'running'}});
  assert.equal((await h.service.updates(reader,project,key)).activeTurnId,null,
    'new connection tool activity alone cannot prove a current Turn start');
  h.emit(turn('after-disconnect','running','start'));
  assert.equal((await h.service.updates(reader,project,key)).activeTurnId,'after-disconnect');
  h.emit({projectId:project,sessionId,threadId:thread,turnId:null,observedAt:now,
    kind:'reset',reason:'connection generation changed'});
  const reset=await h.service.updates(reader,project,key);
  assert.equal(reset.activeTurnId,null);
  assert.equal(reset.freshness,'stale');
  h.service.close();
});

test('live native input is attributed only after exact PG source lookup',async()=>{
  const h=harness();
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:nativeInput('live-input','turn-message',sourceMessage.operationId)});
  const live=await h.service.updates(reader,project,key);
  assert.equal(live.entries[0]?.author.id,'human-a');
  assert.equal((live.entries[0] as {body:string}).body,'Message 10 from human-a');
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:nativeInput('live-other','turn-message')});
  const second=await h.service.updates(reader,project,key,live.cursor);
  assert.equal(second.entries[0]?.kind,'notice');
  assert.equal(second.entries[0]?.id,`native:${thread}:turn-message:live-other`);
  assert.equal(second.entries[0]?.origin,null);
  h.service.close();
});

test('exact operation marker binds live input; source mismatch remains unknown',async()=>{
  const h=harness();
  const marker={kind:'operation-marker' as const,source:'message' as const,operationId:sourceMessage.operationId};
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:{...nativeInput('marker-input','turn-message'),inputReference:marker}});
  const exact=await h.service.updates(reader,project,key);
  assert.equal(exact.entries[0]?.id,`message:${id(10)}`);
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-message',observedAt:now,
    kind:'entry',entry:{...nativeInput('wrong-marker','turn-message'),
      inputReference:{...marker,source:'run' as const}}});
  const wrong=await h.service.updates(reader,project,key,exact.cursor);
  assert.equal(wrong.entries[0]?.kind,'notice');
  assert.equal(wrong.entries[0]?.id,`native:${thread}:turn-message:wrong-marker`);
  h.service.close();
});

test('public plan without native Item ID is retained by its stable order key',async()=>{
  const h=harness();
  h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-plan',observedAt:now,kind:'entry',
    entry:{id:'plan:stable',kind:'plan',turnId:'turn-plan',nativeItemId:null,nativeKind:'plan',
      author:{kind:'session',id:sessionId,label:'Agent'},origin:null,occurredAt:null,observedAt:now,
      freshness:'live',truncated:false,label:'Plan',body:'Public plan',state:'running',
      order:{kind:'live-item',key:'plan:stable',position:null,generation:'g1'}}});
  const read=await h.service.updates(reader,project,key);
  assert.equal(read.entries[0]?.id,'plan:stable');
  assert.equal((read.entries[0] as {body:string}).body,'Public plan');
  h.service.close();
});

test('bounded JSON update wait wakes on a native event',async()=>{
  const h=harness();const cursor=(await h.service.updates(reader,project,key)).cursor;
  const started=Date.now();
  const pending=h.service.updates(reader,project,key,cursor,500);
  setTimeout(()=>h.emit({projectId:project,sessionId,threadId:thread,turnId:'turn-live',observedAt:now,
    kind:'entry',entry:agent('live-wait','turn-live')}),10);
  const result=await pending;
  assert.equal(result.entries[0]?.nativeItemId,'live-wait');
  assert.ok(Date.now()-started<450);
  h.service.close();
});
