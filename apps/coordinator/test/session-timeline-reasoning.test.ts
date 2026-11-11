import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeObservationRecord } from '@evoloop/contracts/native-observation';
import type { NativeWorkspacePage, WorkspaceEntry } from '@evoloop/contracts/session-timeline';
import { DomainError } from '@evoloop/contracts/ports';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import { SessionTimelineService, type WorkspaceHistoryOwner } from '../src/session-timeline/index.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),sessionId=id(2),key=`owned:${sessionId}`,thread='native-thread',now='2026-11-11T00:00:00.000Z';
const reader:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
const outsider:Principal={actorId:'outsider',projectIds:[],permissions:['read']};
const base={author:{kind:'session' as const,id:sessionId,label:'Agent'},origin:null,occurredAt:null,observedAt:now,
  freshness:'persisted' as const,truncated:false};
const reasoning=(item:string,turnId:string,body:string,readable=true):WorkspaceEntry=>({...base,id:`native:${thread}:${turnId}:${item}`,
  turnId,nativeItemId:item,nativeKind:'reasoning',kind:'reasoning',source:readable?'summary':'none',readable,body,
  unavailableReason:readable?null:'encrypted',state:'completed'});
const session={projectId:project,id:sessionId,roleId:'role',cwd:'/tmp',authorizationScope:'scope',model:null,sandbox:'read-only',
  approvalPolicy:'on-request',state:'ready',version:1,nativeThreadId:thread,nativeSessionId:'native-session',operationId:id(99),
  actorId:'agent',createdAt:now,updatedAt:now} as RuntimeSessionRecord;
const breakdown=(output:number,reasoningTokens:number)=>({inputTokens:0,cachedInputTokens:0,outputTokens:output,reasoningOutputTokens:reasoningTokens,totalTokens:output});
const observation={projectId:project,sessionId,threadId:thread,connectionId:id(5),version:3,observedAt:now,lastEventAt:now,freshness:'live',
  staleReason:null,status:'idle',currentTurn:null,items:[],plan:null,diff:null,usage:null,
  turnUsage:[{turnId:'turn-a',base:breakdown(100,40),total:breakdown(180,70),observedAt:now}]} as NativeObservationRecord;

function service(page:NativeWorkspacePage){
  const uow={read:async(_p:string,fn:(r:unknown)=>Promise<unknown>)=>fn({
    getRuntimeSession:async()=>session,
    nativeObservation:{get:async()=>observation},
    nativeInputs:{findSources:async()=>new Map()},
    sessionMessages:{listSessionMessages:async()=>({items:[],nextCursor:null}),listSessionMessageProcessing:async()=>[],getSessionMessages:async()=>[]},
  })} as unknown as UnitOfWork;
  const snapshots={snapshot:async(p:Principal,projectId:string)=>{
    if(!p.projectIds.includes(projectId)||!p.permissions.includes('read'))throw new DomainError('FORBIDDEN','scope');
    return {session:{key,target:{kind:'owned',sessionId},title:'Session'}};
  }} as unknown as SessionObservationService;
  const runner={workspaceBinding:async()=>({nativeThreadId:thread,nativeSessionId:'native-session'}),
    workspaceHistory:async()=>page,onWorkspaceUpdate:()=>()=>{},onWorkspaceDisconnect:()=>()=>{},
    nativeAdapter:()=>({readWorkspaceHistory:async()=>page}),status:()=>({available:true})} as unknown as WorkspaceHistoryOwner;
  return new SessionTimelineService({uow,observation:snapshots,runner});
}

test('project readers see reasoning bodies in native order with per-Turn native reasoning tokens',async()=>{
  const long='x'.repeat(17000);
  const page:NativeWorkspacePage={entries:[reasoning('r1','turn-a','first thought'),reasoning('r2','turn-a','',false),reasoning('r3','turn-a',long),
    reasoning('r4','turn-b','other turn')],
    turns:[{id:'turn-a',state:'completed',startedAt:now,completedAt:now,origin:null},
      {id:'turn-b',state:'completed',startedAt:now,completedAt:now,origin:null,usage:{outputTokens:9,reasoningOutputTokens:4,source:'claude-result'}}],
    nextCursor:null,observedAt:now,historyMode:'paginated',method:'items',partial:false,limitations:[],unsupportedKinds:[]};
  const timeline=service(page);
  try{
    const read=await timeline.page(reader,project,key,{limit:50});
    const shown=read.entries.filter(entry=>entry.kind==='reasoning');
    assert.deepEqual(shown.map(entry=>entry.nativeItemId),['r1','r2','r3','r4']);
    assert.deepEqual(shown.map(entry=>entry.kind==='reasoning'&&[entry.turnId,entry.readable,entry.body.length]),
      [['turn-a',true,13],['turn-a',false,0],['turn-a',true,16000],['turn-b',true,10]]);
    assert.equal(shown[2]!.truncated,true,'a bounded body says it was cut');
    assert.equal(shown[1]!.kind==='reasoning'&&shown[1].unavailableReason,'encrypted');
    const turns=new Map(read.turns.map(turn=>[turn.id,turn.usage]));
    assert.deepEqual(turns.get('turn-a'),{outputTokens:80,reasoningOutputTokens:30,source:'codex-token-usage'});
    assert.deepEqual(turns.get('turn-b'),{outputTokens:9,reasoningOutputTokens:4,source:'claude-result'},'adapter usage is kept as reported');
    await assert.rejects(()=>timeline.page(outsider,project,key,{limit:50}),/scope/);
  }finally{timeline.close();}
});
