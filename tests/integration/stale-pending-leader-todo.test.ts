import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { leaderNoticePostCommand } from "@evoloop/contracts/leader-notices";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { disposeStalePendingTodo, disposeStaleTodoMessage, listPendingLeaderNotices } from "@evoloop/adapter-postgres/leader-result-notices";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("stale pending todo test requires a dedicated evoloop_*_test database");

test("stale pending todos refresh once after plan metadata, retire when no longer todo, and honor current review",async t=>{
  const schema=`el_stale_pending_${randomUUID().replaceAll("-","").slice(0,12)}`;
  await migrate(database,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  t.after(async()=>{
    await pool.end();
    const admin=new pg.Client({connectionString:database});
    await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  const projectId=randomUUID(),roleId=fixtureRoleId("stale-pending-leader"),actorId="stale-pending-owner";
  const principal={actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  const service=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},hasher:{hash:(value:string)=>createHash("sha256").update(value).digest("hex")}});
  async function apply(command:Record<string,unknown>){
    const result=await service.execute(principal,{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));
  }
  await apply({type:"project.create",title:"Stale pending todo"});
  await seedFixtureRole(pool,projectId,roleId);

  async function createTask(){
    const taskId=randomUUID();
    await apply({type:"task.create",taskId,title:"Pending work",content:"# Initial work",
      acceptance:"Leader sees current work",owner:roleId});
    const old=(await pool.query(`SELECT notice_id,message_id,task_revision_id FROM leader_result_notice
      WHERE project_id=$1 AND task_id=$2 AND kind='task_todo'`,[projectId,taskId])).rows[0];
    assert.ok(old);
    return {taskId,noticeId:String(old.notice_id),messageId:String(old.message_id),
      revisionId:String(old.task_revision_id)};
  }
  async function revise(source:Awaited<ReturnType<typeof createTask>>){
    await apply({type:"task.update",taskId:source.taskId,expectedVersion:1,title:"Pending work",
      content:"# Revised work",acceptance:"Leader sees current work",owner:roleId,
      reason:"Clarified before Leader post"});
    const task=(await pool.query(`SELECT version,current_revision_id FROM task
      WHERE project_id=$1 AND task_id=$2`,[projectId,source.taskId])).rows[0];
    return {version:Number(task.version),revisionId:String(task.current_revision_id)};
  }
  async function notices(taskId:string){
    return (await pool.query(`SELECT notice_id,task_revision_id,state,blocked_reason FROM leader_result_notice
      WHERE project_id=$1 AND task_id=$2 AND kind='task_todo' ORDER BY occurred_at,notice_id`,
      [projectId,taskId])).rows;
  }

  const planned=await createTask();
  const revised=await revise(planned);
  await pool.query(`INSERT INTO task_work_plan(project_id,task_id,version,priority,actor_id,reason,updated_at)
    VALUES($1,$2,1,2,$3,'Priority metadata only',now())`,[projectId,planned.taskId,actorId]);
  const scan=await listPendingLeaderNotices(pool,projectId,{limit:100});
  assert.ok(scan.items.some(item=>item.id===planned.noticeId&&item.stale),
    "the pending scan must include the original stale revision");
  assert.equal(await disposeStalePendingTodo(pool,projectId,planned.noticeId),"disposed");
  assert.equal(await disposeStalePendingTodo(pool,projectId,planned.noticeId),"current");
  const plannedRows=await notices(planned.taskId);
  assert.equal(plannedRows.length,2,"one current-revision replacement is created");
  assert.deepEqual(plannedRows.find(row=>row.notice_id===planned.noticeId),{
    notice_id:planned.noticeId,task_revision_id:planned.revisionId,state:"blocked",
    blocked_reason:"TODO_SOURCE_SUPERSEDED_REFRESHED"});
  assert.equal(plannedRows.find(row=>row.task_revision_id===revised.revisionId)?.state,"pending");
  assert.ok((await listPendingLeaderNotices(pool,projectId,{limit:100})).items.some(item=>
    item.taskId===planned.taskId&&item.taskRevisionId===revised.revisionId));

  const stopped=await createTask();
  await apply({type:"task.start",taskId:stopped.taskId,expectedVersion:1,reason:"Work already started"});
  assert.equal(await disposeStalePendingTodo(pool,projectId,stopped.noticeId),"disposed");
  assert.equal((await notices(stopped.taskId)).length,1);
  assert.equal((await notices(stopped.taskId))[0].blocked_reason,"TODO_SOURCE_NOT_TODO");

  const reviewed=await createTask();
  const reviewedRevision=await revise(reviewed);
  const reviewedAt=(await pool.query(`SELECT max(sequence)::bigint AS sequence FROM leader_work_change
    WHERE project_id=$1`,[projectId])).rows[0].sequence;
  await pool.query(`INSERT INTO leader_work_review(project_id,review_id,task_id,task_version,
    task_revision_id,reviewed_change_sequence,decision,reason,actor_id,operation_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'acknowledged','Current revision reviewed',$7,$8,now())`,
    [projectId,randomUUID(),reviewed.taskId,reviewedRevision.version,
      reviewedRevision.revisionId,reviewedAt,actorId,randomUUID()]);
  assert.equal(await disposeStalePendingTodo(pool,projectId,reviewed.noticeId),"disposed");
  assert.equal((await notices(reviewed.taskId)).length,1);
  assert.equal((await notices(reviewed.taskId))[0].blocked_reason,"TODO_SOURCE_SUPERSEDED_HANDLED");

  const changedAfterReview=await createTask();
  const changedRevision=await revise(changedAfterReview);
  const changeSequence=(await pool.query(`SELECT max(sequence)::bigint AS sequence FROM leader_work_change
    WHERE project_id=$1`,[projectId])).rows[0].sequence;
  await pool.query(`INSERT INTO leader_work_review(project_id,review_id,task_id,task_version,
    task_revision_id,reviewed_change_sequence,decision,reason,actor_id,operation_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'acknowledged','Reviewed before a later change',$7,$8,now())`,
    [projectId,randomUUID(),changedAfterReview.taskId,changedRevision.version,
      changedRevision.revisionId,changeSequence,actorId,randomUUID()]);
  await pool.query(`INSERT INTO task_work_plan(project_id,task_id,version,priority,actor_id,reason,updated_at)
    VALUES($1,$2,1,1,$3,'Plan changed after review',now())`,[projectId,changedAfterReview.taskId,actorId]);
  assert.equal(await disposeStalePendingTodo(pool,projectId,changedAfterReview.noticeId),"disposed");
  assert.equal((await notices(changedAfterReview.taskId)).length,2,
    "a later related work change makes the earlier review stale");

  const posted=await createTask();
  await revise(posted);
  const sessionId=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/stale-pending-posted','project','danger-full-access','never','ready',1,$4,$4,$5,$6,now(),now())`,
    [projectId,sessionId,roleId,`thread-${sessionId}`,randomUUID(),actorId]);
  await pool.query(`UPDATE leader_result_notice SET recipient_session_id=$3,receiver_role_id=$4,
    receiver_actor_id=$5,sender_actor_id=$5,updated_at=now()
    WHERE project_id=$1 AND notice_id=$2`,[projectId,posted.noticeId,sessionId,roleId,actorId]);
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,$5,'Fixed post awaiting reconciliation',$6,$7,'queued',1,now(),now())`,
    [projectId,posted.messageId,randomUUID(),sessionId,actorId,posted.taskId,posted.revisionId]);
  assert.equal(await disposeStalePendingTodo(pool,projectId,posted.noticeId),"posted");
  assert.equal((await notices(posted.taskId)).length,1);
  assert.equal((await notices(posted.taskId))[0].state,"pending");

  const confirmed=await createTask();
  await revise(confirmed);
  const source=(await pool.query(`SELECT * FROM leader_result_notice WHERE project_id=$1 AND notice_id=$2`,
    [projectId,confirmed.noticeId])).rows[0];
  await pool.query(`UPDATE leader_result_notice SET recipient_session_id=$3,receiver_role_id=$4,
    receiver_actor_id=$5,sender_actor_id=$5,updated_at=now()
    WHERE project_id=$1 AND notice_id=$2`,[projectId,confirmed.noticeId,sessionId,roleId,actorId]);
  const fixed=leaderNoticePostCommand({projectId,kind:"task_todo",sourceEventId:String(source.source_event_id),
    occurredAt:(source.occurred_at as Date).toISOString(),taskId:confirmed.taskId,
    taskRevisionId:confirmed.revisionId,sourceActorId:String(source.source_actor_id),
    sourceSessionId:null,sourceRef:String(source.source_ref),operationId:String(source.operation_id),
    messageId:confirmed.messageId},sessionId);
  const postedOperation=await service.execute(principal,fixed);
  assert.equal(postedOperation.status,"applied",JSON.stringify(postedOperation));
  assert.equal(await disposeStalePendingTodo(pool,projectId,confirmed.noticeId),"linked",
    "the original saved operation proves the post without current sender authorization");
  assert.equal((await notices(confirmed.taskId))[0].state,"linked");
  assert.equal(await disposeStaleTodoMessage(pool,projectId,confirmed.noticeId,confirmed.messageId),"disposed");
  assert.equal((await pool.query(`SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2`,
    [projectId,confirmed.messageId])).rows[0].state,"cancelled");
});
