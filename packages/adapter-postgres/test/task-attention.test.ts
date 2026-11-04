import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after,before,test } from "node:test";
import pg from "pg";
import { WorkflowService, assessTaskAttention, trialAttentionThreshold } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate,PostgresUnitOfWork } from "../src/index.ts";
import { PgTaskAttention,taskAttentionNoticeCurrent,disposeStaleTaskAttentionNotice,
  scanTaskAttentionCandidates } from "../src/task-attention.ts";
import { readLeaderWorkTask } from "../src/work-index.ts";
import { buildServer } from "../../../apps/coordinator/src/server.ts";

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Task attention tests require a dedicated evoloop test database");
const schema=`el_task_attention_${randomUUID().replaceAll("-","").slice(0,12)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),taskId=randomUUID(),revisionId=randomUUID(),basisId=randomUUID();
const handoffTaskId=randomUUID(),handoffRevisionId=randomUUID();
const handoffDocumentId=randomUUID(),handoffDocumentRevisionId=randomUUID();
const documentId=randomUUID(),documentRevisionId=randomUUID(),hash="a".repeat(64);
const now=new Date().toISOString(),earlier=new Date(Date.parse(now)-12*60*60*1000).toISOString();
const lead:Principal={actorId:"lead",projectIds:[projectId],permissions:["read","write","review"]};
const writer:Principal={actorId:"writer",projectIds:[projectId],permissions:["read","write"]};
const service=()=>new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>now},
  ids:{next:randomUUID},hasher:{hash:value=>createHash("sha256").update(value).digest("hex")}});
before(async()=>{
  await migrate(url!,schema);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Attention',$2)`,[projectId,earlier]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Task',1,$3,'task','draft')`,[projectId,documentId,documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Task','markdown',$4,'lead',$5,'fixed','text/markdown','task.md','[]'::jsonb)`,
      [projectId,documentId,documentRevisionId,hash,earlier]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,
      owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','check','worker','todo',NULL,$4,$5)`,
      [projectId,taskId,revisionId,documentId,documentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,
      owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','check','worker','todo',$4,'lead','fixed',$5,NULL,$6,$7)`,
      [projectId,taskId,revisionId,basisId,earlier,documentId,documentRevisionId]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Handoff',1,$3,'task','draft')`,[projectId,handoffDocumentId,handoffDocumentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Handoff','markdown',$4,'lead',$5,'fixed','text/markdown','handoff.md','[]'::jsonb)`,
      [projectId,handoffDocumentId,handoffDocumentRevisionId,hash,earlier]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,
      owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Handoff','check','worker','todo',NULL,$4,$5)`,
      [projectId,handoffTaskId,handoffRevisionId,handoffDocumentId,handoffDocumentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,
      owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Handoff','check','worker','todo',NULL,'lead','fixed',$4,NULL,$5,$6)`,
      [projectId,handoffTaskId,handoffRevisionId,earlier,handoffDocumentId,handoffDocumentRevisionId]);
    await client.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,false)`,[projectId,taskId,revisionId,basisId]);
    await client.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,
      document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [projectId,taskId,revisionId,basisId,documentId,documentRevisionId]);
    await client.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3`,
      [projectId,taskId,basisId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
});
after(async()=>{
  await pool.end();const client=new pg.Client({connectionString:url});await client.connect();
  try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}
});
test("review permission, concurrent CAS, and same-operation replay after service restart",async()=>{
  const base={type:"task.attention.thresholds.set" as const,projectId,stageId:null,
    phase:"awaiting_run" as const,expectedVersion:0,stageOverdueMs:3600000,
    activityWithoutProgressMs:null,observationGapMs:null,reason:"Trial override"};
  await assert.rejects(service().execute(writer,{...base,operationId:randomUUID()}),/Permission review/);
  await assert.rejects(service().execute({actorId:"no-read",projectIds:[projectId],
    permissions:["write","review"]},{...base,operationId:randomUUID()}),/Permission read/);
  const [a,b]=await Promise.all([service().execute(lead,{...base,operationId:randomUUID()}),
    service().execute(lead,{...base,operationId:randomUUID(),stageOverdueMs:7200000})]);
  assert.deepEqual([a.status,b.status].sort(),["applied","rejected"]);
  const operationId=randomUUID(),input={...base,operationId,expectedVersion:1,stageOverdueMs:5400000};
  const saved=await service().execute(lead,input);
  assert.equal(saved.status,"applied");
  assert.deepEqual(await service().execute(lead,input),saved);
  assert.equal((await new PgTaskAttention(pool,projectId).effectiveThreshold(null,"awaiting_run"))?.version,2);
});
test("follow-up and publication are separate revisions with Task and follow-up CAS",async()=>{
  const input={type:"task.attention.followUp.set" as const,projectId,operationId:randomUUID(),
    taskId:handoffTaskId,expectedTaskVersion:1,expectedTaskRevisionId:handoffRevisionId,expectedVersion:0,
    waitingOn:{kind:"publisher" as const,id:"maintainer"},decision:"waiting" as const,
    actionTaken:"Handoff checked",evidenceRef:"fixture://handoff",nextCheckAt:null,
    releaseHandoff:{recipient:"maintainer",artifactRef:"fixture://artifact",note:"Ready",
      readyForPublicationAt:earlier},reason:"Release handoff"};
  assert.equal((await service().execute(lead,input)).status,"applied");
  const publication={type:"task.attention.publication.record" as const,projectId,operationId:randomUUID(),
    taskId:handoffTaskId,expectedTaskVersion:1,expectedTaskRevisionId:handoffRevisionId,expectedVersion:1,
    publishedAt:now,publicationRef:"fixture://published",reason:"Read back publication"};
  assert.equal((await service().execute(lead,publication)).status,"applied");
  assert.equal((await service().execute(lead,{...publication,operationId:randomUUID()})).status,"rejected");
  const store=new PgTaskAttention(pool,projectId);
  assert.equal((await store.getFollowUp(handoffTaskId))?.publication?.publicationRef,"fixture://published");
  assert.deepEqual((await store.followUpHistory(handoffTaskId)).map(x=>x.version),[2,1]);
  const later=await service().execute(lead,{...input,operationId:randomUUID(),expectedVersion:2,
    actionTaken:"Publication follow-up after evidence"});
  assert.equal(later.status,"applied");
  assert.equal((await store.getFollowUp(handoffTaskId))?.publication?.publicationRef,"fixture://published");
  const erase=await service().execute(lead,{...input,operationId:randomUUID(),expectedVersion:3,
    releaseHandoff:null,actionTaken:"Try to erase a published handoff"});
  assert.equal(erase.status,"rejected");
  assert.equal((erase as {code?:string}).code,"PUBLICATION_HISTORY_CONFLICT");
  assert.equal((await store.getFollowUp(handoffTaskId))?.version,3);
});
test("repeated evaluation deduplicates and same-revision phase change expires the notice",async()=>{
  const task=await readLeaderWorkTask(pool,projectId,taskId);
  assert.ok(task?.timing.current.source);
  const store=new PgTaskAttention(pool,projectId),policy=trialAttentionThreshold(task.timing.current.stage) ??
    {stageId:null,phase:task.timing.current.stage,version:0,stageOverdueMs:1000,
      activityWithoutProgressMs:null,observationGapMs:null,actorId:"fixture",reason:"test threshold",updatedAt:now};
  const thresholdCommand={type:"task.attention.thresholds.set" as const,projectId,stageId:null,
    phase:task.timing.current.stage,stageOverdueMs:1000,activityWithoutProgressMs:null,
    observationGapMs:null,reason:"Fixture threshold"};
  assert.equal((await service().execute(lead,{...thresholdCommand,operationId:randomUUID(),expectedVersion:0})).status,"applied");
  const evalNow=new Date(Date.parse(now)+2*60*60*1000).toISOString();
  const assessed=assessTaskAttention(task,{...policy,stageOverdueMs:1000},evalNow,
    await store.getFollowUp(taskId));
  assert.equal(assessed.find(x=>x.signal==="stage_overdue")?.status,"triggered");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const tx=new PgTaskAttention(client,projectId);
    await tx.recordAssessment(task,assessed,evalNow,null);
    await tx.recordAssessment(task,assessed,evalNow,null);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const items=await store.items({taskId,state:"open",limit:10});
  assert.equal(items.items.length,1);
  const first=items.items[0]!;assert.ok(first.noticeId);
  assert.equal(await taskAttentionNoticeCurrent(pool,projectId,first.noticeId!),true);
  assert.equal((await service().execute(lead,{...thresholdCommand,operationId:randomUUID(),expectedVersion:1,
    stageOverdueMs:null})).status,"applied");
  assert.equal((await store.getItem(first.id))?.state,"open",
    "a notice may still be queued before the next attention evaluation");
  assert.equal(await taskAttentionNoticeCurrent(pool,projectId,first.noticeId!),false,
    "native send preflight must respect the disabled threshold immediately");
  await store.recordAssessment(task,assessTaskAttention(task,{...policy,stageOverdueMs:null},evalNow),evalNow,null);
  assert.equal((await store.getItem(first.id))?.state,"resolved");
  assert.equal(await taskAttentionNoticeCurrent(pool,projectId,first.noticeId!),false);
  assert.equal((await service().execute(lead,{...thresholdCommand,operationId:randomUUID(),expectedVersion:2})).status,"applied");
  await store.recordAssessment(task,assessed,evalNow,null);
  const item=(await store.items({taskId,state:"open",limit:10})).items[0]!;
  assert.ok(item.noticeId);
  const sessionId=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,
    created_at,updated_at) VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,
    $3,$4,$5,'lead',$6,$6)`,[projectId,sessionId,`thread-${sessionId}`,`native-${sessionId}`,randomUUID(),now]);
  await pool.query(`INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,
    target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
    VALUES($1,$2,1,$3,'owned',$4,'worker','assigned','lead','Assign',$5)`,
    [projectId,taskId,revisionId,sessionId,new Date().toISOString()]);
  await pool.query(`INSERT INTO task_session_assignment_revision
    SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2`,[projectId,taskId]);
  assert.equal(await taskAttentionNoticeCurrent(pool,projectId,item.noticeId!),false);
  assert.equal(await disposeStaleTaskAttentionNotice(pool,projectId,item.noticeId!),false);
  const stale=await pool.query(`SELECT state,blocked_reason FROM leader_result_notice
    WHERE project_id=$1 AND notice_id=$2`,[projectId,item.noticeId]);
  assert.deepEqual(stale.rows[0],{state:"blocked",blocked_reason:"ATTENTION_SOURCE_EXPIRED"});
});
test("indexed scan skips terminal history but revisits terminal Tasks with open items for cleanup",async()=>{
  const endedTaskId=randomUUID(),endedRevisionId=randomUUID(),endedDocId=randomUUID(),endedDocRevId=randomUUID();
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Ended',1,$3,'task','draft')`,[projectId,endedDocId,endedDocRevId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Ended','markdown',$4,'lead',$5,'fixed','text/markdown','ended.md','[]'::jsonb)`,
      [projectId,endedDocId,endedDocRevId,hash,earlier]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,
      owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Ended','check','worker','cancelled',NULL,$4,$5)`,
      [projectId,endedTaskId,endedRevisionId,endedDocId,endedDocRevId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,
      owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Ended','check','worker','cancelled',NULL,'lead','fixed',$4,NULL,$5,$6)`,
      [projectId,endedTaskId,endedRevisionId,earlier,endedDocId,endedDocRevId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  assert.equal((await scanTaskAttentionCandidates(pool,projectId,null,50)).includes(endedTaskId),false);
  const itemId=randomUUID();
  await pool.query(`INSERT INTO task_attention_item(project_id,item_id,task_id,task_revision_id,
    phase,signal,source_kind,source_id,state,severity,version,first_detected_at,last_detected_at,
    source_observed_at,reason,evidence)
    VALUES($1,$2,$3,$4,'awaiting_run','stage_overdue','task_revision',$6,'open','watch',1,$5,$5,$5,'THRESHOLD_REACHED','{}')`,
    [projectId,itemId,endedTaskId,endedRevisionId,earlier,endedRevisionId]);
  assert.equal((await scanTaskAttentionCandidates(pool,projectId,null,50)).includes(endedTaskId),true);
  const ended=await readLeaderWorkTask(pool,projectId,endedTaskId);assert.ok(ended);
  await new PgTaskAttention(pool,projectId).recordAssessment(ended,
    assessTaskAttention(ended,null,now),now,null);
  assert.equal((await new PgTaskAttention(pool,projectId).getItem(itemId))?.state,"resolved");
  assert.equal((await scanTaskAttentionCandidates(pool,projectId,null,50)).includes(endedTaskId),false);
});
test("real CLI reads filtered attention pages from isolated PostgreSQL through the project API",async()=>{
  const records=[
    {id:randomUUID(),signal:"stage_overdue",phase:"awaiting_publication",waiting:{kind:"publisher",id:"release-team"},at:"2026-10-25T02:00:00Z"},
    {id:randomUUID(),signal:"activity_without_progress",phase:"awaiting_publication",waiting:{kind:"publisher",id:"release-team"},at:"2026-10-25T01:00:00Z"},
    {id:randomUUID(),signal:"observation_gap",phase:"running",waiting:{kind:"session",id:"worker-session"},at:"2026-10-25T00:00:00Z"},
  ];
  for(const record of records)await pool.query(`INSERT INTO task_attention_item(project_id,item_id,task_id,
    task_revision_id,phase,signal,source_kind,source_id,waiting_on,state,severity,version,
    first_detected_at,last_detected_at,source_observed_at,reason,evidence)
    VALUES($1,$2,$3,$4,$5,$6,'release_handoff',$10,$7::jsonb,'open','watch',1,$8,$8,$8,
      'THRESHOLD_REACHED',$9::jsonb)`,[projectId,record.id,handoffTaskId,handoffRevisionId,
      record.phase,record.signal,JSON.stringify(record.waiting),record.at,
      JSON.stringify({source:{kind:"release_handoff",id:record.id}}),record.id]);
  const resolvedId=randomUUID();
  await pool.query(`INSERT INTO task_attention_item(project_id,item_id,task_id,task_revision_id,
    phase,signal,source_kind,source_id,waiting_on,state,severity,version,first_detected_at,
    last_detected_at,source_observed_at,reason,evidence,resolved_at,resolution_reason)
    VALUES($1,$2,$3,$4,'awaiting_publication','stage_overdue','release_handoff',$7,
      '{"kind":"publisher","id":"release-team"}'::jsonb,'resolved','watch',2,$5,$5,$5,
      'THRESHOLD_REACHED','{}'::jsonb,$6,'SOURCE_EXPIRED')`,
    [projectId,resolvedId,handoffTaskId,handoffRevisionId,"2026-10-24T00:00:00Z","2026-10-24T01:00:00Z",resolvedId]);
  const token=randomUUID()+randomUUID();
  const app=await buildServer({service:service(),credentials:[{token,actorId:"qa-reader",
    projectIds:[projectId],permissions:["read"]}],taskAttentionPool:pool});
  try{
    const origin=await app.listen({host:"127.0.0.1",port:0});
    const cli=async(args:string[])=>new Promise<{code:number|null;output:unknown;error:string}>((done,reject)=>{
      const child=spawn(process.execPath,[resolve("apps/cli/dist/main.js"),...args],{
        env:{...process.env,EVOLOOP_API_URL:origin,EVOLOOP_TOKEN:token,EVOLOOP_PROJECT:projectId},
        stdio:["ignore","pipe","pipe"]});
      let output="",error="";
      child.stdout.on("data",data=>{output+=String(data);});
      child.stderr.on("data",data=>{error+=String(data);});
      child.once("error",reject);
      child.once("close",code=>done({code,output:output?JSON.parse(output):null,error}));
    });
    const base=["work","attention","--task",handoffTaskId,"--state","open",
      "--phase","awaiting_publication","--waiting-on-kind","publisher",
      "--waiting-on-id","release-team","--limit","1"];
    const first=await cli(base);assert.equal(first.code,0,first.error);
    const page1=first.output as {items:Array<{id:string;sourceId?:string;source?:unknown;waitingOn:unknown}>;nextCursor:string|null};
    assert.equal(page1.items.length,1);assert.ok(page1.nextCursor);
    const second=await cli([...base,"--cursor",page1.nextCursor!]);
    assert.equal(second.code,0,second.error);
    const page2=second.output as typeof page1;
    assert.equal(page2.items.length,1);assert.equal(page2.nextCursor,null);
    const wrongScope=await cli(["work","attention","--task",handoffTaskId,"--state","open",
      "--phase","running","--cursor",page1.nextCursor!]);
    assert.equal(wrongScope.code,1,"a cursor cannot silently cross filter scopes");
    assert.deepEqual([page1.items[0]?.id,page2.items[0]?.id],[records[0]?.id,records[1]?.id]);
    assert.deepEqual(page1.items[0]?.waitingOn,{kind:"publisher",id:"release-team"});
    assert.deepEqual((page1.items[0] as {evidence:unknown}).evidence,
      {source:{kind:"release_handoff",id:records[0]?.id}});
    const direct=await fetch(`${origin}/api/projects/${projectId}/task-attention/items?taskId=${handoffTaskId}&state=open&phase=await_publication`,
      {headers:{Authorization:`Bearer ${token}`}});
    assert.equal(direct.status,400,"API rejects an invalid phase instead of ignoring it");
    const exact=await fetch(`${origin}/api/projects/${projectId}/task-attention/items?taskId=${handoffTaskId}&state=open&phase=awaiting_publication&waitingOnKind=publisher&waitingOnId=release-team&limit=1`,
      {headers:{Authorization:`Bearer ${token}`}});
    assert.equal(exact.status,200);
    assert.deepEqual((await exact.json() as typeof page1).items,page1.items);
    const signal=await cli(["work","attention","--task",handoffTaskId,"--signal","observation_gap"]);
    assert.equal(signal.code,0,signal.error);
    assert.deepEqual((signal.output as typeof page1).items.map(item=>item.id),[records[2]?.id]);
    const resolved=await cli(["work","attention","--task",handoffTaskId,"--state","resolved"]);
    assert.equal(resolved.code,0,resolved.error);
    assert.deepEqual((resolved.output as typeof page1).items.map(item=>item.id),[resolvedId]);
    for(const command of [["work","attention"],["work","attention","task",handoffTaskId],
      ["work","attention","item",records[0]!.id],["work","attention","thresholds", "--phase","awaiting_publication"]]){
      const result=await cli(command);assert.equal(result.code,0,`${command.join(" ")}: ${result.error}`);
    }
  }finally{await app.close();}
});
