import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import type { DeliveryStore } from "@evoloop/contracts/delivery";
import type { IncomingRecord } from "@evoloop/contracts/delivery";
import { reviewIncomingChange } from "@evoloop/core/delivery";
import { CollaborationRunner } from "../src/collaboration/runner.js";

test("unconfigured connector reports notConfigured and never claims outbox",async()=>{
  const projectId=randomUUID();let claims=0;
  const principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  const store={recoverInterrupted:async()=>0,claimNext:async()=>{claims++;return null;}} as unknown as DeliveryStore;
  const runner=new CollaborationRunner({store,workflow:{} as WorkflowService,connector:null,consumerId:"feishu",principals:[principal],canWrite:()=>true,allowProjection:async()=>true});
  await runner.pump();
  assert.equal(runner.status(projectId).configured,false);
  assert.match(runner.status(projectId).error??"",/notConfigured/);
  assert.equal(claims,0);
});

test("review action rejects principal outside project before store or connector",async()=>{
  const projectId=randomUUID();let touched=false;
  const store={claimUnknown:async()=>{touched=true;return null;}} as unknown as DeliveryStore;
  const runner=new CollaborationRunner({store,workflow:{} as WorkflowService,connector:{} as never,consumerId:"feishu",principals:[],canWrite:()=>true,allowProjection:async()=>true});
  const outsider:Principal={actorId:"outsider",projectIds:[],permissions:["read","write","review"]};
  await assert.rejects(()=>runner.reconcile(outsider,projectId,randomUUID()),/review and current integration grant/);
  assert.equal(touched,false);
});

test("automatic polling requires an explicit bounded interval",()=>{
  assert.throws(()=>new CollaborationRunner({store:{} as DeliveryStore,workflow:{} as WorkflowService,connector:null,consumerId:"feishu",principals:[],canWrite:()=>true,allowProjection:async()=>true,pollIntervalMs:1000}),/at least 30 seconds/);
});

test("current integration grant is required before remote scan and candidate persistence",async()=>{
  const projectId=randomUUID(),taskId=randomUUID();let allowed=true,remoteCalls=0,candidates=0;
  const principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  const store={recordIncoming:async()=>{candidates++;throw new Error("unexpected candidate");}} as unknown as DeliveryStore;
  const connector={listRemote:async()=>{remoteCalls++;allowed=false;return {records:[{recordId:"remote-1",entityId:taskId,
    localVersion:1,operationId:"op",title:"Changed",status:"proposed",modifiedTime:"1"}],nextCursor:null};}} as never;
  const runner=new CollaborationRunner({store,workflow:{} as WorkflowService,connector,consumerId:"feishu",principals:[principal],
    canWrite:()=>true,hasGrant:(project,actor)=>allowed&&project===projectId&&actor===principal.actorId,allowProjection:async()=>true});
  await assert.rejects(()=>runner.pollIncoming(principal,projectId),/grant lost/);
  assert.equal(remoteCalls,1);assert.equal(candidates,0);
  await assert.rejects(()=>runner.pollIncoming(principal,projectId),/integration grant required/);
  assert.equal(remoteCalls,1);
});

test("stop waits for an in-flight claim before returning",async()=>{
  const projectId=randomUUID(),principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  let release!:()=>void,completed=false;
  const store={recoverInterrupted:async()=>0,claimNext:async()=>new Promise<null>(resolve=>{release=()=>resolve(null);})} as unknown as DeliveryStore;
  const runner=new CollaborationRunner({store,workflow:{} as WorkflowService,connector:{} as never,consumerId:"feishu",principals:[principal],
    canWrite:()=>true,hasGrant:(project,actor)=>project===projectId&&actor===principal.actorId,allowProjection:async()=>true});
  const pending=runner.pump();
  while(!release) await Promise.resolve();
  const stopping=runner.stop().then(()=>{completed=true;});
  await Promise.resolve();assert.equal(completed,false);
  release();await stopping;await pending;
  assert.equal(completed,true);
});

test("unknown incoming operation and accepted Task cannot replay a remote revision", async () => {
  const projectId=randomUUID(),taskId=randomUUID(),incomingId=randomUUID(),operationId=randomUUID();
  const principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  const candidate:IncomingRecord={projectId,id:incomingId,operationId,state:"unknown",sourceEventId:"external-event",observedAtUtc:"2026-10-20T09:00:00.000Z",
    reviewedBy:null,reviewedAtUtc:null,entityId:taskId,remoteRecordId:"remote-1",observedLocalVersion:1,observedRemoteOperationId:"remote-op",
    observedRemoteModifiedTime:"1",actor:{platformUserId:"user",projectActorId:"owner",sourceEventId:"external-event",verified:true},
    patch:{title:"Changed"},reviewOnly:false,reason:null};
  let commands=0,decisions=0;
  const store={getIncoming:async()=>candidate,getBinding:async()=>({entityId:taskId,remoteRecordId:"remote-1",localVersion:1}),
    decideIncoming:async()=>{decisions++;return true;}} as unknown as DeliveryStore;
  const workflow={getOperation:async()=>null,getTask:async()=>({task:{id:taskId,title:"Original",state:"ready",version:1}}),
    execute:async()=>{commands++;throw new Error("unexpected command");}} as unknown as WorkflowService;
  const deps={store,workflow,consumerId:"feishu",nowUtc:()=>"2026-10-20T09:00:00.000Z",verifyRemote:async()=>true};
  const unknown=await reviewIncomingChange(deps,principal,projectId,incomingId,"apply","Review external edit");
  assert.equal(unknown.state,"unknown");assert.equal(commands,0);assert.equal(decisions,0);
  candidate.state="pending";
  const accepted=await reviewIncomingChange(deps,principal,projectId,incomingId,"apply","Review external edit");
  assert.equal(accepted.state,"conflict");assert.equal(commands,0);assert.equal(decisions,1);
});
