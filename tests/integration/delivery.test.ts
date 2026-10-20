import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../../packages/adapter-postgres/src/index.js";
import { PgOutboxDeliveryStore } from "../../packages/adapter-postgres/src/delivery.js";
import { WorkflowService } from "../../packages/core/src/index.js";
import { reviewIncomingChange, CollaborationRuleError } from "../../packages/core/src/delivery/index.js";
import { CollaborationRunner } from "../../apps/coordinator/src/collaboration/runner.js";
import { FeishuBitableConnector } from "../../packages/connector-feishu/src/index.js";
import { PgSchedulingStore } from "../../packages/adapter-postgres/src/scheduling.js";
import { SchedulingService } from "../../packages/core/src/scheduling/index.js";
import type { Principal } from "@evoloop/contracts";

const url=process.env.TEST_DATABASE_URL;
if(!url||!/\/evoloop_[a-z_]*test(?:\?|$)/.test(url))throw new Error("dedicated evoloop_*test database required");
const time="2026-10-20T09:00:00.000Z";
async function taskEvent(pool:pg.Pool,projectId:string,owner:string,version=1) {
  const taskId=randomUUID(),revisionId=randomUUID(),operationId=randomUUID(),eventId=randomUUID();
  const client=await pool.connect();
  try {await client.query("BEGIN");
    await client.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,goal,acceptance,owner,state) VALUES($1,$2,$3,$4,'Fixture task','Check evidence','Record result',$5,'proposed')",[projectId,taskId,version,revisionId,owner]);
    await client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,actor_id,reason,created_at) VALUES($1,$2,$3,$4,'Fixture task','Check evidence','Record result',$5,'proposed',$5,'fixture',$6)",[projectId,taskId,revisionId,version,owner,time]);
    await client.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,$3,'fixture','task.propose',$4::jsonb,$5)",[projectId,operationId,owner,JSON.stringify({status:"applied",operationId,entityId:taskId,version}),time]);
    await client.query("INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at) VALUES($1,$2,$3,$4,'task',$5,$6,$7)",[projectId,eventId,operationId,`${projectId}:task:${taskId}`,taskId,version,time]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return {taskId,eventId,operationId};
}
async function remoteFixture(){
  const records=new Map<string,{record_id:string;fields:Record<string,unknown>;last_modified_time:string}>();
  const calls:{method:string;path:string}[]=[];let loseCreate=true;
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url??"/","http://fixture");let body="";for await(const part of req)body+=part.toString();
    calls.push({method:req.method??"",path:u.pathname});
    const send=(status:number,data:unknown)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
    if(u.pathname==="/oauth/v3/token")return send(200,{code:0,access_token:"fixture-token",expires_in:3600});
    const base="/open-apis/bitable/v1/apps/app/tables/table/records";
    if(u.pathname===base&&req.method==="GET")return send(200,{code:0,data:{items:[...records.values()],has_more:false}});
    if(u.pathname===base&&req.method==="POST"){
      const record={record_id:`rec-${records.size+1}`,fields:(JSON.parse(body) as {fields:Record<string,unknown>}).fields,last_modified_time:"100"};records.set(record.record_id,record);
      if(loseCreate){loseCreate=false;req.socket.destroy();return;}return send(200,{code:0,data:{record}});
    }
    if(u.pathname.startsWith(base+"/")&&req.method==="GET"){
      const record=records.get(u.pathname.slice(base.length+1));return record?send(200,{code:0,data:{record}}):send(404,{code:1});
    }
    return send(404,{code:1});
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}`;
  const connector=new FeishuBitableConnector({appId:"fixture-app",appSecret:"fixture-secret",appToken:"app",tableId:"table",apiBaseUrl:base,authUrl:`${base}/oauth/v3/token`,fields:{entityId:"Evo ID",localVersion:"Evo Version",operationId:"Evo Op",title:"Title",status:"Status"}});
  return {connector,calls,records,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test("outbox projection uses fenced claim, survives lost HTTP reply, and reconciles without second POST",async t=>{
  await migrate(url);const pool=new pg.Pool({connectionString:url,max:5});t.after(()=>pool.end());
  const projectId=randomUUID(),principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'delivery fixture',now())",[projectId]);
  const item=await taskEvent(pool,projectId,principal.actorId);
  const fx=await remoteFixture();t.after(fx.close);
  const store=new PgOutboxDeliveryStore(pool);
  const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>time},ids:{next:randomUUID},hasher:{hash:value=>createHash("sha256").update(value).digest("hex")}});
  let write=true;
  const runner=new CollaborationRunner({store,workflow,connector:fx.connector,consumerId:"feishu",principals:[principal],canWrite:()=>write,
    hasGrant:(project,actor)=>project===projectId&&actor===principal.actorId,allowProjection:async()=>true});
  await runner.pump();
  assert.equal((await store.get(projectId,item.eventId,"feishu"))?.state,"unknown");
  assert.equal(fx.calls.filter(x=>x.method==="POST"&&x.path.endsWith("/records")).length,1);
  await runner.pump();
  assert.equal(fx.calls.filter(x=>x.method==="POST"&&x.path.endsWith("/records")).length,1,"unknown is not automatically replayed");
  const reconciled=await runner.reconcile(principal,projectId,item.eventId);
  assert.equal(reconciled?.state,"applied");
  assert.equal(fx.calls.filter(x=>x.method==="POST"&&x.path.endsWith("/records")).length,1);
  assert.equal((await store.getBinding(projectId,item.taskId,"feishu"))?.localVersion,1);
  assert.deepEqual((await store.attempts(projectId,item.eventId,"feishu")).map(x=>x.outcome),["dispatching","unknown","dispatching","applied"]);
  const remote=[...fx.records.values()][0]!;remote.fields.Title="Remote title";
  assert.equal(await runner.pollIncoming(principal,projectId),1);
  const candidate=(await store.listIncoming(projectId,"feishu")).items[0]!;
  assert.equal(candidate.reviewOnly,true);assert.equal(candidate.actor,null);
  await assert.rejects(()=>reviewIncomingChange({store,workflow,consumerId:"feishu",nowUtc:()=>time,verifyRemote:item=>runner.verifyIncomingCandidate(item,principal)},{...principal,permissions:["read","write"]},projectId,candidate.id,"apply","accept"),
    (error:unknown)=>error instanceof CollaborationRuleError&&error.code==="FORBIDDEN");
  assert.equal((await workflow.getTask(principal,projectId,item.taskId)).task.title,"Fixture task");
  const binding=(await store.getBinding(projectId,item.taskId,"feishu"))!;
  const edited=(await fx.connector.listRemote()).records[0]!;
  const verified=fx.connector.incoming(edited,binding,{platformUserId:"ou_verified",projectActorId:"external-editor",sourceEventId:"webhook-1",verified:true});
  assert.equal(verified.reviewOnly,false);
  const reviewable=await store.recordIncoming(projectId,"feishu",verified,"webhook-1",time);
  const applied=await reviewIncomingChange({store,workflow,consumerId:"feishu",nowUtc:()=>time,verifyRemote:item=>runner.verifyIncomingCandidate(item,principal)},principal,projectId,reviewable.id,"apply","reviewed title correction");
  assert.equal(applied.state,"applied");
  const updatedTask=await workflow.getTask(principal,projectId,item.taskId);
  assert.equal(updatedTask.task.title,"Remote title");assert.equal(updatedTask.task.version,2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM operation_journal WHERE project_id=$1 AND operation_id=$2",[projectId,reviewable.operationId])).rows[0]?.n,1);
  assert.equal((await store.getIncoming(projectId,reviewable.id,"feishu"))?.state,"applied");
  write=false;assert.equal(runner.status(projectId).configured,true);
});

test("expired dispatch is unknown and concurrent claims never duplicate an event",async t=>{
  await migrate(url);const pool=new pg.Pool({connectionString:url,max:4});t.after(()=>pool.end());
  const projectId=randomUUID();await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'claim fixture',now())",[projectId]);
  const item=await taskEvent(pool,projectId,"owner");const store=new PgOutboxDeliveryStore(pool);
  const claims=await Promise.all([store.claimNext(projectId,"feishu","a",time,1000),store.claimNext(projectId,"feishu","b",time,1000)]);
  assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean)!;
  assert.equal(await store.beginDispatch(claim,"owner",time),true);
  assert.equal(await store.recoverInterrupted(projectId,"feishu","2026-10-20T09:00:02.000Z"),1);
  assert.equal((await store.get(projectId,item.eventId,"feishu"))?.state,"unknown");
  assert.equal(await store.claimNext(projectId,"feishu","c","2026-10-20T09:00:03.000Z",1000),null);
  assert.equal(await store.finish(claim,{state:"confirmed",binding:{entityId:item.taskId,remoteRecordId:"rec-late",localVersion:1,remoteOperationId:item.operationId,remoteVersion:1,remoteModifiedTime:"1",confirmedTitle:"Fixture task",confirmedStatus:"proposed"}},"owner","2026-10-20T09:00:03.000Z","dispatch"),null,"expired fence cannot mark late response applied");
});

test("real Task delivery, use and close events plus scheduled proposal all enter Task projection",async t=>{
  await migrate(url);const pool=new pg.Pool({connectionString:url,max:4});t.after(()=>pool.end());
  const projectId=randomUUID(),taskId=randomUUID(),documentId=randomUUID(),principal:Principal={actorId:"owner",projectIds:[projectId],permissions:["read","write","review"]};
  const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>time},ids:{next:randomUUID},
    hasher:{hash:value=>createHash("sha256").update(value).digest("hex")}});
  const issue=(type:string,rest:Record<string,unknown>)=>workflow.execute(principal,{type,projectId,operationId:randomUUID(),...rest} as never);
  const yes=async(result:Promise<unknown>)=>{const outcome=await result as {status:string;version?:number;revisionId?:string};assert.equal(outcome.status,"applied",JSON.stringify(outcome));return outcome;};
  await yes(issue("project.create",{title:"Task projection lifecycle"}));
  const doc=await yes(issue("document.create",{documentId,title:"Report requirement",body:"# Report\nConsumer uses report."}));
  await yes(issue("document.adopt",{documentId,expectedVersion:1,revisionId:doc.revisionId,reason:"Use requirement"}));
  await yes(issue("task.propose",{taskId,title:"Report",goal:"Produce report",acceptance:"Consumer uses report",owner:"owner",documentIds:[documentId],consumer:"owner",useRequired:true,evidence:"Need report"}));
  await yes(issue("task.judge",{taskId,expectedVersion:1,decision:"approve",reason:"Bounded",evidence:"Need is concrete"}));
  const ready=await yes(issue("task.accept",{taskId,expectedVersion:1,basis:[{documentId,revisionId:doc.revisionId}],reason:"Accept"}));
  const active=await yes(issue("task.start",{taskId,expectedVersion:ready.version,reason:"Begin"}));
  const delivered=await yes(issue("delivery.record",{taskId,expectedVersion:active.version,artifactRef:"repo://report",artifactRevision:"fixed-commit",contentHash:"a".repeat(64),technicalResult:"passed",technicalEvidence:"Tested report",reason:"Deliver"}));
  await yes(issue("observation.record",{taskId,deliveryId:delivered.revisionId,observer:"owner",observerKind:"human",result:"used",evidence:"Owner completed report",reason:"Observed"}));
  await yes(issue("task.close",{taskId,expectedVersion:delivered.version,deliveryId:delivered.revisionId,acceptanceResult:"met",acceptanceEvidence:"Owner completed report",reason:"Close"}));
  const scheduleId=randomUUID(),revisionId=randomUUID();
  const schedules=new SchedulingService(new PgSchedulingStore(pool));
  await schedules.create(principal,{projectId,id:scheduleId,version:1,currentRevisionId:revisionId,state:"active",watermarkUtc:time,
    revision:{projectId,scheduleId,id:revisionId,version:1,timezone:"UTC",rule:{kind:"once",atUtc:"2026-10-20T09:30:00.000Z"},
      misfire:{kind:"latest"},overlap:"skip",template:{title:"Scheduled report",goal:"Inspect",acceptance:"Record",owner:"owner"},
      authorization:{scopeId:"scope:report",roleId:"temporary-role",authorizedBy:"owner",expiresAtUtc:null},
      actorId:"owner",reason:"One report",createdAtUtc:time}});
  assert.equal((await schedules.tick(principal,projectId,"2026-10-20T10:00:00.000Z",["scope:report"])).length,1);
  const store=new PgOutboxDeliveryStore(pool);
  assert(await store.claimNext(projectId,"feishu","test-worker","2026-10-20T10:01:00.000Z",300000));
  const rows=await pool.query(`SELECT e.kind,t.state FROM outbox_delivery d JOIN outbox_event e ON e.project_id=d.project_id AND e.event_id=d.event_id
    JOIN task t ON t.project_id=e.project_id AND t.task_id=e.entity_id WHERE d.project_id=$1 AND d.consumer_id='feishu'`,[projectId]);
  const kinds=rows.rows.map(row=>row.kind);
  for(const kind of ["task","task.judge","task.start","delivery.record","observation.record","task.close","schedule.task.proposed"])
    assert(kinds.includes(kind),`missing Task projection for ${kind}`);
  assert.equal(kinds.length,(await pool.query(`SELECT count(*)::int AS n FROM outbox_event e JOIN task t ON t.project_id=e.project_id AND t.task_id=e.entity_id
    WHERE e.project_id=$1 AND (e.kind='task' OR e.kind LIKE 'task.%' OR e.kind IN ('delivery.record','observation.record','schedule.task.proposed'))`,[projectId])).rows[0]?.n);
  assert(!kinds.includes("project"),"other entity events must not be projected as Tasks");
});
