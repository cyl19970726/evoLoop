import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import { DomainError } from '@evoloop/contracts/ports';
import { RuntimeServerError } from '@evoloop/adapter-codex-app-server';
import type { NativeWorkspacePage } from '@evoloop/contracts/session-timeline';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import { ReadOnlyWorkspaceOwner, type ReadOnlyWorkspaceAdapter } from '../src/session-timeline/read-only-owner.js';
import { SessionTimelineService } from '../src/session-timeline/index.js';

const project='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002';
const principal:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
const saved={projectId:project,id:sessionId,roleId:'role',cwd:'/tmp',authorizationScope:'project',model:null,
  sandbox:'read-only',approvalPolicy:'on-request',state:'ready',version:1,nativeThreadId:'thread',nativeSessionId:'native-session',
  operationId:'00000000-0000-4000-8000-000000000003',actorId:'agent',createdAt:'2026-11-01T00:00:00Z',
  updatedAt:'2026-11-01T00:00:00Z'} satisfies RuntimeSessionRecord;
const empty:NativeWorkspacePage={entries:[],turns:[],nextCursor:null,observedAt:'2026-11-01T00:00:00Z',
  historyMode:'paginated',method:'items',partial:false,limitations:[],unsupportedKinds:[]};
test('candidate read-only owner opens one adapter and never starts or resumes a Turn',async()=>{
  let opens=0,registrations=0,inspections=0,reads=0,starts=0,liveSubscriptions=0,authorized=true,denyNative=false;
  const adapter={open:async()=>{opens++},close:async()=>{},isReady:()=>true,
    registerBinding:async(binding:{nativeThreadId:string})=>{registrations++;assert.equal(binding.nativeThreadId,'thread')},
    inspect:async(binding:{nativeSessionId:string})=>{inspections++;assert.equal(binding.nativeSessionId,'native-session')},
    readWorkspaceHistory:async()=>{reads++;if(denyNative)throw new RuntimeServerError('thread/items/list',1,-32000,'permission denied');
      return empty},onDisconnect:()=>()=>{},onWorkspaceUpdate:()=>{liveSubscriptions++;return()=>{}},
    startTurn:()=>{starts++},resume:()=>{starts++}} as unknown as ReadOnlyWorkspaceAdapter;
  const uow={read:async(_project:string,fn:(reader:unknown)=>Promise<unknown>)=>fn({
    getRuntimeSession:async()=>saved,
    nativeInputs:{findSources:async()=>new Map()},
    sessionMessages:{listSessionMessages:async()=>({items:[],nextCursor:null}),listSessionMessageProcessing:async()=>[]},
  })} as unknown as UnitOfWork;
  const owner=new ReadOnlyWorkspaceOwner({uow,adapter,authorize:async(_reader,session)=>authorized&&session.id===sessionId});
  await owner.open();
  assert.equal(owner.nativeAdapter().onWorkspaceUpdate,undefined);
  owner.onWorkspaceUpdate(()=>{});
  assert.equal(liveSubscriptions,0);
  assert.deepEqual(await owner.workspaceHistory(principal,project,sessionId,{limit:25}),empty);
  assert.deepEqual([opens,registrations,inspections,reads,starts],[1,1,1,1,0]);
  const observation={snapshot:async()=>({session:{key:`owned:${sessionId}`,
    target:{kind:'owned',sessionId},title:'Read only preview'}})} as unknown as SessionObservationService;
  const timeline=new SessionTimelineService({uow,observation,runner:owner});
  const page=await timeline.page(principal,project,`owned:${sessionId}`,{limit:25});
  assert.equal(page.capabilities.history,true);
  assert.equal(page.capabilities.live,false);
  assert.equal(page.live.freshness,'unavailable');
  assert.equal((await timeline.updates(principal,project,`owned:${sessionId}`)).freshness,'unavailable');
  assert.equal(liveSubscriptions,0);
  timeline.close();
  denyNative=true;
  await assert.rejects(owner.workspaceHistory(principal,project,sessionId,{limit:25}),
    (error:unknown)=>error instanceof DomainError&&error.code==='FORBIDDEN');
  denyNative=false;
  authorized=false;
  await assert.rejects(owner.workspaceHistory(principal,project,sessionId,{limit:25}),
    (error:unknown)=>error instanceof DomainError&&error.code==='FORBIDDEN');
  assert.equal(reads,3);
  await assert.rejects(owner.workspaceBinding(principal,'00000000-0000-4000-8000-000000000009',sessionId),DomainError);
  await owner.close();
});
