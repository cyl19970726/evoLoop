import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/index.ts";
import { PgTaskTimingQueries, PgTaskTimingStore, TaskTimingTickPartialError } from "../src/task-timing.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Task timing tests require a dedicated evoloop test database");
const schema = `el_task_timing_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId = randomUUID(), roleId = randomUUID(), actorId = "timing-reviewer";
const first = "2026-11-07T00:00:00.000Z";
const second = "2026-11-08T00:00:00.000Z";
const third = "2026-11-09T00:00:00.000Z";
const hash = (s:string) => createHash("sha256").update(s).digest("hex");

async function task(title:string,content:string,priority:number|null=null):Promise<string> {
  const taskId=randomUUID(),revisionId=randomUUID(),documentId=randomUUID(),contentId=randomUUID();
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,$3,1,$4,'task','draft')`,[projectId,documentId,title,contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,$6,$7,'test','text/markdown','task.md','[]'::jsonb)`,
      [projectId,documentId,contentId,content,hash(content),actorId,"2026-11-06T00:00:00.000Z"]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,$4,'accept',$5,'todo',$6,$7)`,
      [projectId,taskId,revisionId,title,roleId,documentId,contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,$4,'accept',$5,'todo',$6,$7,$8,'test',$9)`,
      [projectId,taskId,revisionId,title,roleId,documentId,contentId,actorId,"2026-11-06T00:00:00.000Z"]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,consumer,use_required,
      acceptance_mode,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,'consumer',true,'independent_agent','source','','2026-11-06T00:00:00.000Z')`,
      [projectId,taskId,revisionId]);
    if(priority!==null) await client.query(`INSERT INTO task_work_plan(project_id,task_id,version,
      priority,actor_id,reason,updated_at) VALUES($1,$2,1,$3,$4,'test','2026-11-06T00:00:00.000Z')`,
      [projectId,taskId,priority,actorId]);
    await client.query("COMMIT");return taskId;
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
}
async function queries<T>(run:(q:PgTaskTimingQueries)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {await client.query("BEGIN");const result=await run(new PgTaskTimingQueries(client,projectId));
    await client.query("COMMIT");return result;
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
const timing=(executeAtUtc:string,repeat:"none"|"daily"="daily")=>({executeAtUtc,timezone:"Asia/Taipei",repeat});
const tick=()=>new PgTaskTimingStore(pool);
before(async()=>{
  await migrate(url!,schema);
  const client=await pool.connect();
  try {await client.query("BEGIN");
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Timing','2026-11-06T00:00:00.000Z')`,[projectId]);
    const roleRevision=randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active',$4,
      '2026-11-06T00:00:00.000Z','2026-12-06T00:00:00.000Z')`,[projectId,roleId,roleRevision,actorId]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,
      $4,'test','2026-11-06T00:00:00.000Z','2026-12-06T00:00:00.000Z')`,[projectId,roleId,roleRevision,actorId]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});
after(async()=>{
  await pool.end();const client=new pg.Client({connectionString:url!});await client.connect();
  try{await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await client.end();}
});

test("root due once, open A/B do not prevent independent B/C and tick is idempotent",async()=>{
  const a=await task("Architecture review","Review current architecture",3);
  await queries(q=>q.create(a,timing(first),actorId,"2026-11-06T00:00:00.000Z"));
  assert.deepEqual(await tick().tick(projectId,first,"other-actor",roleId),[]);
  const root=await tick().tick(projectId,first,actorId,roleId);
  assert.deepEqual(root.map(r=>[r.taskId,r.created]),[[a,false]]);
  assert.deepEqual(await tick().tick(projectId,first,actorId,roleId),[]);
  const b=(await tick().tick(projectId,second,actorId,roleId))[0]!;
  assert.equal(b.created,true);assert.notEqual(b.taskId,a);
  const bSource=(await pool.query(`SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2`,
    [projectId,b.taskId])).rows[0].current_revision_id;
  await queries(q=>q.set({type:"task.timing.set",projectId,operationId:randomUUID(),taskId:b.taskId,
    expectedTaskVersion:1,expectedTimingVersion:1,scope:"future",...timing(first),
    content:"Prompt from B",reason:"B revises future"},"replacement-reviewer","2026-11-08T01:00:00.000Z"));
  assert.deepEqual(await tick().tick(projectId,third,actorId,roleId),[]);
  const c=(await tick().tick(projectId,third,"replacement-reviewer",roleId))[0]!;
  assert.equal(c.created,true);assert.notEqual(c.taskId,b.taskId);
  assert.equal((await queries(q=>q.get(c.taskId)))?.previousTaskId,b.taskId);
  const check=await pool.query(`SELECT t.state,t.title,dr.body,p.consumer,p.acceptance_mode,w.priority,
    w.planned_start_at FROM task t JOIN document_revision dr ON dr.project_id=t.project_id
      AND dr.document_id=t.content_document_id AND dr.revision_id=t.content_revision_id
    JOIN task_proposal p ON p.project_id=t.project_id AND p.task_id=t.task_id
      AND p.task_revision_id=t.current_revision_id
    JOIN task_work_plan w ON w.project_id=t.project_id AND w.task_id=t.task_id
    WHERE t.project_id=$1 AND t.task_id=$2`,[projectId,b.taskId]);
  assert.equal(check.rows[0].state,"todo");assert.equal(check.rows[0].body,"Review current architecture");
  assert.equal(check.rows[0].priority,3);assert.equal(check.rows[0].consumer,"consumer");
  assert.equal(new Date(check.rows[0].planned_start_at).toISOString(),second);
  const cSource=await pool.query(`SELECT r.source_task_id,r.source_task_revision_id,r.template->>'content' AS content
    FROM task_timing_occurrence o JOIN task_timing_series_revision r ON r.project_id=o.project_id
      AND r.series_id=o.series_id AND r.revision_id=o.series_revision_id
    WHERE o.project_id=$1 AND o.task_id=$2`,[projectId,c.taskId]);
  assert.equal(cSource.rows[0].source_task_id,b.taskId);
  assert.equal(cSource.rows[0].source_task_revision_id,bSource);
  assert.equal(cSource.rows[0].content,"Prompt from B");
  const receipts=await pool.query(`SELECT j.command_type,e.kind FROM operation_journal j JOIN outbox_event e
    ON e.project_id=j.project_id AND e.operation_id=j.operation_id
    WHERE j.project_id=$1 AND j.command_type='task.timing.due'`,[projectId]);
  assert.equal(receipts.rows.length,3);assert.ok(receipts.rows.every(r=>r.kind==="task"));
  assert.deepEqual(await tick().tick(projectId,third,"replacement-reviewer",roleId),[]);
});

test("this-only time and prose edits keep future template and audit previous slot",async()=>{
  const a=await task("Original","Original prompt");
  await queries(q=>q.create(a,timing(first),actorId,"2026-11-06T00:00:00.000Z"));
  const moved="2026-11-07T01:00:00.000Z";
  const view=await queries(q=>q.set({type:"task.timing.set",projectId,operationId:randomUUID(),taskId:a,
    expectedTaskVersion:1,expectedTimingVersion:1,scope:"this",...timing(moved),
    title:"This edition",content:"This prompt",acceptance:"This acceptance",reason:"Only today"},
    actorId,"2026-11-06T01:00:00.000Z"));
  assert.equal(view.version,2);assert.equal(view.executeAtUtc,moved);
  assert.equal(view.futureTemplate.content,"Original prompt");
  const audit=await pool.query(`SELECT previous_at_utc,next_at_utc FROM task_timing_occurrence_revision
    WHERE project_id=$1 AND task_id=$2`,[projectId,a]);
  assert.equal(audit.rows.length,1);assert.equal(new Date(audit.rows[0].previous_at_utc).toISOString(),first);
  await tick().tick(projectId,moved,actorId,roleId);
  const b=(await tick().tick(projectId,second,actorId,roleId))[0]!;
  const body=await pool.query(`SELECT dr.body FROM task t JOIN document_revision dr ON dr.project_id=t.project_id
    AND dr.document_id=t.content_document_id AND dr.revision_id=t.content_revision_id
    WHERE t.project_id=$1 AND t.task_id=$2`,[projectId,b.taskId]);
  assert.equal(body.rows[0].body,"Original prompt");
  assert.equal((await queries(q=>q.get(a)))?.nextAtUtc,second);
});

test("future template revision, stop and latest outage are bounded",async()=>{
  const a=await task("Daily","Old prompt");
  await queries(q=>q.create(a,timing(first),actorId,"2026-11-06T00:00:00.000Z"));
  await tick().tick(projectId,first,actorId,roleId);
  const revised=await queries(q=>q.set({type:"task.timing.set",projectId,operationId:randomUUID(),taskId:a,
    expectedTaskVersion:1,expectedTimingVersion:1,scope:"future",...timing(first),
    title:"Revised",content:"New prompt",reason:"Next occurrences"},actorId,"2026-11-07T01:00:00.000Z"));
  assert.equal(revised.futureTemplate.content,"New prompt");
  const late="2026-11-13T00:00:00.000Z";
  const b=(await tick().tick(projectId,late,actorId,roleId)).find(x=>x.seriesId===revised.seriesId)!;
  assert.equal(b.plannedAtUtc,late);
  const count=await pool.query(`SELECT count(*)::int n FROM task_timing_occurrence WHERE project_id=$1 AND series_id=$2`,[projectId,revised.seriesId]);
  assert.equal(count.rows[0].n,2);
  const body=await pool.query(`SELECT dr.body FROM task t JOIN document_revision dr ON dr.project_id=t.project_id
    AND dr.document_id=t.content_document_id AND dr.revision_id=t.content_revision_id WHERE t.project_id=$1 AND t.task_id=$2`,
    [projectId,b.taskId]);assert.equal(body.rows[0].body,"New prompt");
  const stopped=await queries(q=>q.stop({type:"task.timing.stop",projectId,operationId:randomUUID(),
    taskId:a,expectedTimingVersion:2,reason:"End series"},actorId,late));
  assert.equal(stopped.seriesState,"stopped");
  assert.equal((await tick().tick(projectId,"2026-11-14T00:00:00.000Z",actorId,roleId))
    .filter(item=>item.seriesId===revised.seriesId).length,0);
});

test("once uses the root Task even when late, without making a copy",async()=>{
  const owner="once-reviewer",a=await task("One review","One prompt");
  await queries(q=>q.create(a,timing(first,"none"),owner,"2026-11-06T00:00:00.000Z"));
  const due=await tick().tick(projectId,third,owner,roleId);
  assert.deepEqual(due.map(item=>[item.taskId,item.created]),[[a,false]]);
  assert.deepEqual(await tick().tick(projectId,"2026-11-14T00:00:00.000Z",owner,roleId),[]);
  const view=await queries(q=>q.get(a));
  assert.equal(view?.nextAtUtc,null);
  assert.equal(view?.occurrences.length,1);
});

test("this and future changes current prose and later copy, retaining the old Task revision",async()=>{
  const owner="both-reviewer",a=await task("Before","Before prompt");
  await queries(q=>q.create(a,timing(first),owner,"2026-11-06T00:00:00.000Z"));
  const original=(await pool.query(`SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2`,
    [projectId,a])).rows[0].current_revision_id;
  const view=await queries(q=>q.set({type:"task.timing.set",projectId,operationId:randomUUID(),taskId:a,
    expectedTaskVersion:1,expectedTimingVersion:1,scope:"this_and_future",...timing(first),
    title:"After",content:"After prompt",acceptance:"After acceptance",reason:"Improve repeated work"},
    owner,"2026-11-06T01:00:00.000Z"));
  assert.equal(view.version,2);assert.equal(view.futureTemplate.content,"After prompt");
  const old=await pool.query(`SELECT title FROM task_revision WHERE project_id=$1 AND task_id=$2
    AND revision_id=$3`,[projectId,a,original]);assert.equal(old.rows[0].title,"Before");
  await tick().tick(projectId,first,owner,roleId);
  const b=(await tick().tick(projectId,second,owner,roleId))[0]!;
  const copy=await pool.query(`SELECT t.title,t.acceptance,dr.body FROM task t JOIN document_revision dr
    ON dr.project_id=t.project_id AND dr.document_id=t.content_document_id
      AND dr.revision_id=t.content_revision_id WHERE t.project_id=$1 AND t.task_id=$2`,
    [projectId,b.taskId]);
  assert.deepEqual([copy.rows[0].title,copy.rows[0].acceptance,copy.rows[0].body],
    ["After","After acceptance","After prompt"]);
});

test("an ineligible linked document blocks only its own series",async()=>{
  const owner="isolation-reviewer",good=await task("Eligible","Do it"),bad=await task("Needs review","Do other");
  const documentId=randomUUID(),revisionId=randomUUID(),decisionId=randomUUID();
  const client=await pool.connect();
  try{await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status) VALUES($1,$2,'Reference',1,$3,$3,'spec','published')`,
      [projectId,documentId,revisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Reference body','markdown',$4,$5,'2026-11-06T00:00:00.000Z',
      'fixed','text/markdown','reference.md','[]'::jsonb)`,
      [projectId,documentId,revisionId,hash("Reference body"),owner]);
    await client.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,
      actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,'adopt',
      '2026-11-06T00:00:00.000Z')`,[projectId,decisionId,documentId,revisionId,owner]);
    await client.query(`INSERT INTO task_document_link(project_id,link_id,task_id,document_id,
      actor_id,created_at) VALUES($1,$2,$3,$4,$5,'2026-11-06T00:00:00.000Z')`,
      [projectId,randomUUID(),bad,documentId,owner]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  await queries(q=>q.create(good,timing(first),owner,"2026-11-06T00:00:00.000Z"));
  await queries(q=>q.create(bad,timing(first),owner,"2026-11-06T00:00:00.000Z"));
  await tick().tick(projectId,first,owner,roleId);
  await pool.query(`UPDATE process_document SET version=2,adopted_revision_id=NULL,status='draft'
    WHERE project_id=$1 AND document_id=$2`,[projectId,documentId]);
  let partial:TaskTimingTickPartialError|null=null;
  try{await tick().tick(projectId,second,owner,roleId);}catch(error){
    if(error instanceof TaskTimingTickPartialError) partial=error; else throw error;
  }
  assert.ok(partial);assert.equal(partial.failures.length,1);
  assert.match(partial.failures[0]!.reason,/not adopted/);
  assert.equal(partial.completed.length,1);
  assert.equal((await queries(q=>q.get(good)))?.occurrences.length,2);
  assert.equal((await queries(q=>q.get(bad)))?.occurrences.length,1);
});
