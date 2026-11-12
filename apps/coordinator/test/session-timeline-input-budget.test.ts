// Input binding on a page of many Turns (the 30-sample case of Task 87ed16ba): the page's own history proves the Turns it holds in full, so a page
// does not run out of per-Turn proof reads; when a proof is still not obtained the input is "not checked", never "unverified sender".
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeInputSource } from '@evoloop/contracts/native-input';
import type { SessionMessageRecord, SessionMessageProcessing } from '@evoloop/contracts/session-messages';
import type { NativeWorkspacePage, WorkspaceEntry, WorkspaceMessage } from '@evoloop/contracts/session-timeline';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import type { RuntimeRunner } from '../src/runtime/runner.js';
import { SessionTimelineService } from '../src/session-timeline/index.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),sessionId=id(2),key=`owned:${sessionId}`,thread='native-thread',now='2026-11-01T00:00:00.000Z';
const reader:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
const session:RuntimeSessionRecord={projectId:project,id:sessionId,roleId:'role',cwd:'/tmp',authorizationScope:'scope',model:null,sandbox:'read-only',
  approvalPolicy:'on-request',state:'ready',version:1,nativeThreadId:thread,nativeSessionId:'native-session',operationId:id(99),actorId:'agent',createdAt:now,updatedAt:now};
const COUNT=30;
const turnId=(k:number)=>`turn-${String(k).padStart(2,'0')}`;
const sourceOf=(k:number):NativeInputSource=>({kind:'message',messageId:id(1000+k),processingId:id(2000+k),operationId:id(3000+k),actorId:`human-${k}`});
const input=(k:number,over:Partial<WorkspaceMessage>={}):WorkspaceMessage=>({id:`native:${thread}:${turnId(k)}:input-${k}`,kind:'message',role:'input',phase:'unknown',body:'',
  clientId:sourceOf(k).operationId,state:'completed',turnId:turnId(k),nativeItemId:`input-${k}`,nativeKind:'userMessage',author:{kind:'native',id:null,label:'Native input'},origin:null,
  occurredAt:null,observedAt:now,freshness:'persisted',truncated:false,order:{kind:'native-item',key:`${turnId(k)}:input-${k}`,position:null,generation:'g'},
  inputReference:{kind:'operation-marker',source:'message',operationId:sourceOf(k).operationId},...over});
const answer=(k:number):WorkspaceMessage=>({...input(k),id:`native:${thread}:${turnId(k)}:answer-${k}`,role:'assistant',phase:'final_answer',body:'ok',clientId:null,nativeItemId:`answer-${k}`,
  nativeKind:'agentMessage',author:{kind:'session',id:sessionId,label:'Agent'},order:{kind:'native-item',key:`${turnId(k)}:answer-${k}`,position:null,generation:'g'}}) as WorkspaceMessage;
const message=(k:number):SessionMessageRecord=>({projectId:project,id:id(1000+k),operationId:id(3000+k),target:{kind:'owned',sessionId},senderActorId:`human-${k}`,
  content:`【验收样本】第 ${k} 条`,context:null,replyToMessageId:null,state:'replied',version:1,blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now});

/** COUNT short Turns, each an input then an answer, newest first like the real listing; `perTurnReads` counts reads of a single Turn. */
function harness(options:{method?:'items'|'turns-full';failPerTurn?:boolean;extraInputInTurn?:number;noMarkerTurn?:number}={}){
  const turnsAsc=Array.from({length:COUNT},(_,i)=>i+1);
  const itemsOf=(k:number):WorkspaceEntry[]=>[
    options.noMarkerTurn===k?input(k,{clientId:null,inputReference:undefined as never}):input(k),
    ...(options.extraInputInTurn===k?[input(k,{id:`native:${thread}:${turnId(k)}:input-${k}-again`,nativeItemId:`input-${k}-again`})]:[]),answer(k)];
  const all=turnsAsc.flatMap(itemsOf);               // ascending
  const messages=turnsAsc.map(message);
  const process:SessionMessageProcessing[]=turnsAsc.map(k=>({projectId:project,id:id(2000+k),messageId:id(1000+k),sessionId,operationId:id(3000+k),state:'completed',
    nativeTurnId:turnId(k),response:'ok',failure:null,version:1,startedAt:now,updatedAt:now}));
  let perTurnReads=0,pageReads=0;
  const uow={read:async (_p:string,fn:(r:unknown)=>Promise<unknown>)=>fn({getRuntimeSession:async()=>session,
    nativeInputs:{findSources:async (_p:string,_s:string,ids:string[])=>new Map(ids.flatMap(t=>{const k=Number(t.slice(5));return k>=1&&k<=COUNT?[[t,sourceOf(k)]]:[]}))},
    sessionMessages:{listSessionMessages:async()=>({items:[],nextCursor:null}),listSessionMessageProcessing:async(ids:string[])=>process.filter(p=>ids.includes(p.messageId)),
      getSessionMessages:async(ids:string[])=>messages.filter(m=>ids.includes(m.id))}})} as unknown as UnitOfWork;
  const observation={snapshot:async()=>({session:{key,target:{kind:'owned',sessionId},title:'Session'}})} as unknown as SessionObservationService;
  const runner={workspaceBinding:async()=>({nativeThreadId:thread,nativeSessionId:'native-session'}),
    workspaceHistory:async(_p:Principal,_pr:string,_s:string,q:{cursor?:string;turnId?:string;itemId?:string;limit?:number}):Promise<NativeWorkspacePage>=>{
      const limit=q.limit??50,method=options.method??'items';
      if(q.turnId&&!q.itemId){
        perTurnReads++;
        if(options.failPerTurn)throw new Error('proof read unavailable');
        const k=Number(q.turnId.slice(5));
        return {entries:itemsOf(k),turns:[{id:q.turnId,state:'completed',startedAt:now,completedAt:now,origin:null}],nextCursor:null,observedAt:now,historyMode:'paginated',method:'items',
          partial:false,itemEnumerationComplete:true,limitations:[],unsupportedKinds:[]};
      }
      if(q.itemId){const entry=all.find(e=>e.turnId===q.turnId&&e.nativeItemId===q.itemId);
        return {entries:entry?[entry]:[],turns:[],nextCursor:null,observedAt:now,historyMode:'paginated',method:'items',partial:false,itemEnumerationComplete:true,limitations:[],unsupportedKinds:[]}}
      pageReads++;
      const end=q.cursor?Number(q.cursor):all.length;                         // newest items first, `limit` at a time
      const start=Math.max(0,end-limit),slice=all.slice(start,end);
      const ids=[...new Set(slice.map(e=>e.turnId!))];
      return {entries:slice,turns:ids.map(t=>({id:t,state:'completed' as const,startedAt:now,completedAt:now,origin:null})),nextCursor:start>0?String(start):null,observedAt:now,
        historyMode:'paginated',method,partial:start>0,itemEnumerationComplete:start===0,limitations:[],unsupportedKinds:[]};
    },
    nativeAdapter:()=>({onWorkspaceUpdate:true}),status:()=>({available:true}),onWorkspaceUpdate:()=>()=>{},onWorkspaceDisconnect:()=>()=>{}} as unknown as RuntimeRunner;
  const service=new SessionTimelineService({uow,observation,runner});
  return {service,reads:()=>({perTurnReads,pageReads})};
}
const inputsOf=(entries:readonly WorkspaceEntry[])=>entries.filter(e=>e.nativeKind==='userMessage');

test('a page of many short Turns attributes every input it holds in full from the page itself, with no per-Turn proof reads for them (the 30-sample case)',async()=>{
  const h=harness();
  try{
    const page=await h.service.page(reader,project,key,{limit:50,source:'native'});
    const inputs=inputsOf(page.entries);
    assert.equal(inputs.length,25,'50 Items on the page: 25 Turns of an input and an answer');
    assert.ok(inputs.every(e=>e.kind==='message'),JSON.stringify(inputs.filter(e=>e.kind!=='message').map(e=>(e as {label?:string}).label)));
    assert.deepEqual(inputs.map(e=>e.author.id),Array.from({length:25},(_,i)=>`human-${COUNT-24+i}`),'each input shows its own sender');
    assert.ok(!JSON.stringify(page.entries).includes('未能核实'),'never "unverified sender" for a correct input');
    // The first page starts at the newest Item and ends at the oldest one it can hold: its oldest Turn may continue, so at most that one is read alone.
    assert.ok(h.reads().perTurnReads<=1,`per-Turn proof reads: ${h.reads().perTurnReads}`);
    // The next page (reached by a cursor): the rest, every one attributed; only its newest edge Turn is proven by a read of its own.
    const second=await h.service.page(reader,project,key,{limit:50,source:'native',cursor:page.nextCursor!});
    const rest=inputsOf(second.entries);
    assert.equal(rest.length,5);
    assert.ok(rest.every(e=>e.kind==='message'),'the remaining five are attributed too');
    assert.ok(h.reads().perTurnReads<=3,`per-Turn proof reads: ${h.reads().perTurnReads}`);
  }finally{h.service.close()}
});

test('when no proof can be obtained (unreadable per-Turn history, nothing the page can prove) inputs are "not checked", with the neutral wording, and one Item can still be checked on demand',async()=>{
  // method 'turns-full' is not an Item-order page: the page proves nothing, so every proof is a read of one Turn, and the budget is spent.
  const h=harness({method:'turns-full'});
  try{
    const page=await h.service.page(reader,project,key,{limit:50,source:'native'});
    const inputs=inputsOf(page.entries);
    const checked=inputs.filter(e=>e.kind==='message'),unchecked=inputs.filter(e=>e.kind==='notice');
    assert.ok(checked.length>0&&unchecked.length>0,'the budget covers some Turns and not the rest');
    for(const entry of unchecked){
      assert.equal((entry as {label:string}).label,'未核对的原生输入');
      assert.match((entry as {body:string}).body,/这条输入的绑定本次未核对，可展开核对/);
      assert.doesNotMatch((entry as {body:string}).body,/未能核实|未关联/);
    }
    assert.ok(!JSON.stringify(page.entries).includes('未能核实此原生输入的业务发送者'));
    assert.ok(page.limitations.some(text=>text.includes('未核对')),'the page says some inputs were not checked');
    // On demand: reading that one Item proves it with its own budget.
    const target=unchecked[0]!;
    const one=await h.service.item(reader,project,key,target.turnId!,target.nativeItemId!);
    assert.equal(one.kind,'message');
    assert.equal(one.author.id,`human-${Number(target.turnId!.slice(5))}`);
  }finally{h.service.close()}
});

test('a proof read that fails leaves the input "not checked", never an unverified sender',async()=>{
  const h=harness({method:'turns-full',failPerTurn:true});
  try{
    const page=await h.service.page(reader,project,key,{limit:50,source:'native'});
    const inputs=inputsOf(page.entries);
    assert.ok(inputs.length>0&&inputs.every(e=>e.kind==='notice'&&(e as {label:string}).label==='未核对的原生输入'));
  }finally{h.service.close()}
});

test('the page proof does not weaken the source check: a marker that is missing still says the sender is unverified, and two inputs claiming one source are a duplicate',async()=>{
  const missing=harness({noMarkerTurn:COUNT-2});
  try{
    const page=await missing.service.page(reader,project,key,{limit:50,source:'native'});
    const bad=inputsOf(page.entries).find(e=>e.turnId===turnId(COUNT-2))!;
    assert.equal(bad.kind,'notice');assert.equal((bad as {label:string}).label,'未关联的原生输入');
    assert.match((bad as {body:string}).body,/未能核实此原生输入的业务发送者/,'a missing marker is a real source question');
    assert.ok(inputsOf(page.entries).filter(e=>e.turnId!==turnId(COUNT-2)).every(e=>e.kind==='message'));
  }finally{missing.service.close()}
  const twice=harness({extraInputInTurn:COUNT-3});
  try{
    const page=await twice.service.page(reader,project,key,{limit:50,source:'native'});
    const both=inputsOf(page.entries).filter(e=>e.turnId===turnId(COUNT-3));
    assert.equal(both.length,2);
    assert.ok(both.every(e=>e.kind==='notice'&&(e as {label:string}).label==='重复的原生输入'),'neither of two exact inputs is trusted');
  }finally{twice.service.close()}
});
