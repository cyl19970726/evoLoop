import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { RuntimeProvider } from '@evoloop/contracts/runtime';
import type { NativeWorkspacePage, WorkspaceRuntimeUpdate } from '@evoloop/contracts/session-timeline';
import type { SessionMessageProcessing, SessionMessageRecord } from '@evoloop/contracts/session-messages';
import { DomainError, type UnitOfWork } from '@evoloop/contracts/ports';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import { ProviderRoutedRuntime } from '../src/runtime/routed.js';
import { RuntimeRunner, bindingOf, type ManagedRuntime } from '../src/runtime/runner.js';
import { SessionTimelineService, type WorkspaceHistoryOwner } from '../src/session-timeline/index.js';

// One coordinator drives Codex and Claude Sessions at once. The routed composite exposes Codex's workspace
// updates and any runtime's history reader, so the timeline must ask the Session's own runtime instead.
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),now='2026-11-09T00:00:00.000Z';
const reader:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
const sessionOf=(n:number,provider:RuntimeProvider):RuntimeSessionRecord=>({projectId:project,id:id(n),roleId:'role',cwd:'/tmp',
  authorizationScope:'scope',model:null,sandbox:'read-only',approvalPolicy:'on-request',state:'ready',version:1,
  nativeThreadId:`${provider}-thread`,nativeSessionId:`${provider}-native-session`,operationId:id(n+90),actorId:'agent',
  createdAt:now,updatedAt:now,runtimeProvider:provider});
const sessions=new Map([['codex',sessionOf(2,'codex')],['claude',sessionOf(3,'claude')]] as const);
const keyOf=(provider:'codex'|'claude')=>`owned:${sessions.get(provider)!.id}`;

function harness(options:{codexOnly?:boolean}={}){
  const page:NativeWorkspacePage={entries:[],turns:[],nextCursor:null,observedAt:now,historyMode:'paginated',method:'items',
    partial:false,limitations:[],unsupportedKinds:[]};
  // Codex has the native history reader and connection-level workspace updates; Claude has neither.
  const codex={readWorkspaceHistory:async()=>page,onWorkspaceUpdate:(_fn:(event:WorkspaceRuntimeUpdate)=>void)=>()=>{}};
  const claude={};
  const routed=options.codexOnly?codex as unknown as ProviderRoutedRuntime:
    new ProviderRoutedRuntime(new Map<RuntimeProvider,ManagedRuntime>([
      ['codex',codex as unknown as ManagedRuntime],['claude',claude as unknown as ManagedRuntime]]),'codex');
  assert.equal(typeof routed.onWorkspaceUpdate,'function','the coordinator runtime carries Codex workspace updates');
  assert.equal(typeof routed.readWorkspaceHistory,'function','the coordinator runtime carries the Codex history reader');
  const runner=new RuntimeRunner({runtimeFactory:()=>routed} as never);
  const sessionById=(sessionId:string)=>[...sessions.values()].find(s=>s.id===sessionId);
  let historyReads=0;
  const owner:WorkspaceHistoryOwner={
    workspaceBinding:async(_p,_project,sessionId)=>bindingOf(sessionById(sessionId)!),
    workspaceHistory:async(_p,_project,sessionId,options)=>{historyReads++;
      return routed.readWorkspaceHistory!(bindingOf(sessionById(sessionId)!),options);},
    onWorkspaceUpdate:listener=>routed.onWorkspaceUpdate!(listener),
    onWorkspaceDisconnect:()=>()=>{},
    nativeAdapter:binding=>runner.nativeAdapter(binding),
    status:()=>({available:true}),
  };
  const claudeMessage:SessionMessageRecord={projectId:project,id:id(10),operationId:id(110),
    target:{kind:'owned',sessionId:sessions.get('claude')!.id},senderActorId:'human',content:'Question for Claude',
    context:null,replyToMessageId:null,state:'replied',version:1,blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};
  const processing:SessionMessageProcessing={projectId:project,id:id(120),messageId:claudeMessage.id,
    sessionId:sessions.get('claude')!.id,operationId:id(130),state:'completed',nativeTurnId:'claude-turn',
    response:'Answer from Claude',failure:null,version:1,startedAt:now,updatedAt:now};
  const uow={read:async(_project:string,fn:(r:unknown)=>Promise<unknown>)=>fn({
    getRuntimeSession:async(sessionId:string)=>sessionById(sessionId)??null,
    nativeInputs:{findSources:async()=>new Map()},
    sessionMessages:{
      listSessionMessages:async(target:{sessionId:string})=>({nextCursor:null,
        items:target.sessionId===sessions.get('claude')!.id?[claudeMessage]:[]}),
      listSessionMessageProcessing:async(ids:string[])=>ids.includes(claudeMessage.id)?[processing]:[],
      getSessionMessages:async()=>[]},
  })} as unknown as UnitOfWork;
  const observation={snapshot:async(p:Principal,projectId:string,key:string)=>{
    const session=[...sessions.values()].find(s=>`owned:${s.id}`===key);
    if(!session||!p.projectIds.includes(projectId))throw new DomainError('FORBIDDEN','scope');
    return {session:{key,target:{kind:'owned',sessionId:session.id},title:`${session.runtimeProvider} Session`}};
  }} as unknown as SessionObservationService;
  return {service:new SessionTimelineService({uow,observation,runner:owner}),runner,routed,historyReads:()=>historyReads};
}

test('a Claude Session in a coordinator that also drives Codex reports no live updates or native history', async()=>{
  const {service}=harness();
  const both=await service.page(reader,project,keyOf('claude'),{limit:20});
  assert.equal(both.capabilities.live,false,'Claude has no workspace update stream');
  assert.equal(both.capabilities.history,false,'Claude has no native history reader');
  assert.equal(both.live.freshness,'unavailable');
  assert.deepEqual(both.live.limitations,['Live native updates unavailable']);
  const messagesOnly=await service.page(reader,project,keyOf('claude'),{limit:20,source:'messages'});
  assert.equal(messagesOnly.capabilities.history,false,'the messages-only view does not promise a native history');
  assert.equal(messagesOnly.capabilities.live,false);
  assert.deepEqual(messagesOnly.entries.map(e=>e.kind==='message'?[e.role,e.body]:[e.kind]),[['assistant','Answer from Claude']],
    'without native history the saved reply stays visible');
});

test('a Claude Session long-poll returns at once instead of waiting for Codex updates', async()=>{
  const {service}=harness();
  const first=await service.updates(reader,project,keyOf('claude'));
  assert.equal(first.freshness,'unavailable');
  assert.equal(first.cursor,'');
  const started=Date.now();
  const next=await service.updates(reader,project,keyOf('claude'),'opaque-position',15000);
  assert.ok(Date.now()-started<1000,'no live wait for a runtime without workspace updates');
  assert.equal(next.freshness,'unavailable');
});

test('a Codex Session in the same coordinator keeps live updates and native history', async()=>{
  const {service,historyReads}=harness();
  const both=await service.page(reader,project,keyOf('codex'),{limit:20});
  assert.equal(both.capabilities.live,true);
  assert.equal(both.capabilities.history,true);
  assert.equal(historyReads(),1);
  const messagesOnly=await service.page(reader,project,keyOf('codex'),{limit:20,source:'messages'});
  assert.equal(messagesOnly.capabilities.history,true,'native history stays available for a later native read');
  assert.equal(messagesOnly.capabilities.live,true);
});

test('the runner resolves a binding to the runtime that drives that Session', ()=>{
  const {runner,routed}=harness();
  const codex=runner.nativeAdapter(bindingOf(sessions.get('codex')!));
  const claude=runner.nativeAdapter(bindingOf(sessions.get('claude')!));
  assert.equal(runner.nativeAdapter(),routed,'without a binding the coordinator runtime is unchanged');
  assert.equal(typeof codex.onWorkspaceUpdate,'function');
  assert.equal(claude.onWorkspaceUpdate,undefined);
  assert.equal(claude.readWorkspaceHistory,undefined);
  assert.throws(()=>runner.nativeAdapter({owner:'unknown-owner' as never}),
    (error:unknown)=>error instanceof DomainError&&error.code==='RUNTIME_OWNER_UNKNOWN');
});

test('a coordinator that drives only Codex does not answer for a Claude Session', async()=>{
  const {service,runner,routed}=harness({codexOnly:true});
  assert.equal(runner.nativeAdapter(bindingOf(sessions.get('codex')!)),routed);
  assert.throws(()=>runner.nativeAdapter(bindingOf(sessions.get('claude')!)),
    (error:unknown)=>error instanceof DomainError&&error.code==='RUNTIME_PROVIDER_UNAVAILABLE');
  const claude=await service.page(reader,project,keyOf('claude'),{limit:20,source:'messages'});
  assert.equal(claude.capabilities.live,false);
  assert.equal(claude.capabilities.history,false);
  const codex=await service.page(reader,project,keyOf('codex'),{limit:20,source:'messages'});
  assert.equal(codex.capabilities.live,true);
});
