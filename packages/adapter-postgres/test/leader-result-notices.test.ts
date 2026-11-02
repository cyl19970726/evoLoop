import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/index.ts";
import { getLeaderNoticeByMessageId, hasInFlightLeaderNoticeMessage, linkLeaderNoticeMessage,
  listBlockedLeaderNotices, listLeaderNotices, listPendingLeaderNotices,
  markLeaderNoticeBlocked, pinLeaderNoticeRecipient, requeueLeaderNotice,
  setLeaderNoticePendingReason } from "../src/leader-result-notices.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Leader notice tests require a dedicated evoloop test database");
const schema = `el_result_notice_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), now = "2026-11-02T00:00:00.000Z", hash = "a".repeat(64);
before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Notice test',$2)", [projectId, now]);
});
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

async function task(state: "todo" | "in_progress") {
  const taskId = randomUUID(), revisionId = randomUUID(), basisId = randomUUID();
  const documentId = randomUUID(), documentRevisionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Task',1,$3,'task','draft')`, [projectId, documentId, documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Task','markdown',$4,'lead',$5,'fixed','text/markdown','task.md','[]'::jsonb)`,
    [projectId, documentId, documentRevisionId, hash, now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','check','worker',$4,NULL,$5,$6)`,
    [projectId, taskId, revisionId, state, documentId, documentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','check','worker',$4,$5,'lead','fixed',$6,NULL,$7,$8)`,
    [projectId, taskId, revisionId, state, state === "todo" ? null : basisId, now, documentId, documentRevisionId]);
    if (state === "in_progress") {
      await client.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
        VALUES($1,$2,$3,$4,false)`, [projectId, taskId, revisionId, basisId]);
      await client.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [projectId, taskId, revisionId, basisId, documentId, documentRevisionId]);
      await client.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3`,
        [projectId, taskId, basisId]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return { taskId, revisionId, basisId, documentId, documentRevisionId };
}

async function sessionRun(item: Awaited<ReturnType<typeof task>>) {
  const sessionId = randomUUID(), runId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,$3,$4,$5,'lead',$6,$6)`,
  [projectId, sessionId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), now]);
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
    input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',$8,'requested',1,'lead',$9,$9)`,
  [projectId, runId, item.taskId, item.revisionId, item.basisId, sessionId, randomUUID(), hash, now]);
  return { sessionId, runId };
}

test("new todo notice is unique per source and rolls back with its Task", async () => {
  const first = await task("todo");
  const rows = await listLeaderNotices(pool, projectId, { taskId: first.taskId, limit: 10 });
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0]!.kind, "task_todo");
  assert.equal(rows.items[0]!.sourceEventId, first.revisionId);
  const original = rows.items[0]!;
  await assert.rejects(pool.query(`UPDATE leader_result_notice SET message_id=$3 WHERE project_id=$1 AND notice_id=$2`,
    [projectId, original.id, randomUUID()]), /immutable/i);
  await pool.query(`SELECT enqueue_leader_result_notice($1,'task_todo',$2,$3,$2,NULL,'lead',$4,$5)`,
    [projectId, first.revisionId, first.taskId, original.sourceRef, now]);
  assert.deepEqual((await listLeaderNotices(pool, projectId, { taskId: first.taskId, limit: 10 })).items[0], original);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO leader_result_notice(project_id,kind,source_event_id,task_id,task_revision_id,source_ref,occurred_at)
      VALUES($1,'task_todo',$2,$3,$4,'rolled back',$5)`,
      [projectId, randomUUID(), first.taskId, first.revisionId, now]);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: first.taskId, limit: 10 })).items.length, 1);
});

test("delivery and actual consumer use notify; producer self-use and ordinary reads do not", async () => {
  const item = await task("in_progress"), { sessionId, runId } = await sessionRun(item);
  const deliveryId = randomUUID();
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,source_run_version,
    submitted_by_actor_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,1,'worker','artifact','rev',$6,'passed','check','done','sealer',$7)`,
    [projectId, deliveryId, item.taskId, item.revisionId, runId, hash, now]);
  for (const observer of ["worker", "qa"]) await pool.query(`INSERT INTO consumer_observation(
    project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'agent','used','actual use','checked',$5,$6)`,
    [projectId, randomUUID(), item.taskId, deliveryId, observer, now]);
  const notices = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items;
  assert.deepEqual(notices.map(n => n.kind).sort(), ["delivery", "observation"]);
  assert.equal(notices.find(n => n.kind === "delivery")!.sourceSessionId, sessionId);
  assert.equal(notices.find(n => n.kind === "observation")!.sourceSessionId, null);
  assert.equal(notices.find(n => n.kind === "observation")!.sourceActorId, "qa");
  const noticeCount = notices.length, client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
      submitted_by_actor_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,
      reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,'worker','rolled back','rev',$6,'passed',
      'check','done','sealer',$7)`, [projectId, randomUUID(), item.taskId, item.revisionId, runId, hash, now]);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.length, noticeCount);
  assert.equal((await listPendingLeaderNotices(pool, projectId, 100)).length >= 2, true);
  const newerRevision = randomUUID(), newerBasis = randomUUID();
  const revisionTx = await pool.connect();
  try {
    await revisionTx.query("BEGIN");
    await revisionTx.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,2,'Task','check','worker','in_progress',$4,'lead','rework',now(),NULL,$5,$6)`,
      [projectId,item.taskId,newerRevision,newerBasis,item.documentId,item.documentRevisionId]);
    await revisionTx.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,false)`,[projectId,item.taskId,newerRevision,newerBasis]);
    await revisionTx.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,
      document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [projectId,item.taskId,newerRevision,newerBasis,item.documentId,item.documentRevisionId]);
    await revisionTx.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3`,
      [projectId,item.taskId,newerBasis]);
    await revisionTx.query(`UPDATE task SET version=2,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2`,
      [projectId,item.taskId,newerRevision]);
    await revisionTx.query("COMMIT");
  } catch(error) { await revisionTx.query("ROLLBACK"); throw error; } finally { revisionTx.release(); }
  const historical = (await listPendingLeaderNotices(pool, projectId, {limit:100})).items
    .filter(x=>x.taskId===item.taskId);
  assert.deepEqual(historical.map(x=>x.kind).sort(), ["delivery","observation"]);
  assert.ok(historical.every(x=>x.stale));
  const pinnedHistorical = await pinLeaderNoticeRecipient(pool, projectId, historical[0]!.id,
    {sessionId,receiverRoleId:"worker",receiverActorId:"leader",senderActorId:"notifier"});
  assert.equal(pinnedHistorical?.recipient?.sessionId, sessionId);
});

test("terminal Run without a signed submission is noticed once; blocked notice can be requeued", async () => {
  const item = await task("in_progress"), { sessionId, runId } = await sessionRun(item);
  await pool.query(`UPDATE runtime_run SET state='completed',native_turn_id=$4,version=2,updated_at=$3
    WHERE project_id=$1 AND run_id=$2`, [projectId, runId, now, `turn-${runId}`]);
  const [gap] = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items;
  assert.equal(gap?.kind, "run_without_submission");
  assert.equal(gap.sourceSessionId, sessionId);
  await pool.query(`UPDATE runtime_run SET version=3,updated_at=$3 WHERE project_id=$1 AND run_id=$2`,
    [projectId, runId, now]);
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.length, 1);
  const blocked = await markLeaderNoticeBlocked(pool, projectId, gap.id, "receiver unavailable");
  assert.equal(blocked.state, "blocked");
  assert.equal((await listBlockedLeaderNotices(pool, projectId, {limit:100})).items
    .some(x => x.id === gap.id), true);
  assert.equal((await listPendingLeaderNotices(pool, projectId, {limit:100})).items
    .some(x => x.id === gap.id), false);
  assert.deepEqual(await markLeaderNoticeBlocked(pool, projectId, gap.id, "receiver unavailable"), blocked);
  const requeued = await requeueLeaderNotice(pool, projectId, gap.id);
  assert.equal(requeued.state, "pending");
  assert.equal(requeued.messageId, gap.messageId);
  assert.equal(requeued.operationId, gap.operationId);
});

test("recoverable admission reason remains pending and clears without changing fixed IDs", async () => {
  const item = await task("todo");
  const first = (await listLeaderNotices(pool, projectId, {taskId:item.taskId,limit:10})).items[0]!;
  const waiting = await setLeaderNoticePendingReason(pool, projectId, first.id, "LEADER_GRANT_UNAVAILABLE");
  assert.equal(waiting.state, "pending");
  assert.equal(waiting.blockedReason, "LEADER_GRANT_UNAVAILABLE");
  assert.equal((await listPendingLeaderNotices(pool, projectId, {limit:100})).items.some(x=>x.id===first.id), true);
  const resumed = await setLeaderNoticePendingReason(pool, projectId, first.id, null);
  assert.equal(resumed.blockedReason, null);
  assert.equal(resumed.messageId, first.messageId);
  assert.equal(resumed.operationId, first.operationId);
});

test("link requires the fixed saved message, is idempotent, and never creates another notice", async () => {
  const item = await task("todo"), [notice] = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items;
  assert.ok(notice);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'leader','/tmp','project','danger-full-access','never','ready',1,$3,$4,$5,'lead',$6,$6)`,
    [projectId, sessionId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), now]);
  const pinned = await pinLeaderNoticeRecipient(pool, projectId, notice.id,
    { sessionId, receiverRoleId: "leader", receiverActorId: "receiver", senderActorId: "lead" });
  assert.equal(pinned?.recipient?.sessionId, sessionId);
  assert.equal((await getLeaderNoticeByMessageId(pool, projectId, notice.messageId))?.id, notice.id);
  await assert.rejects(linkLeaderNoticeMessage(pool, projectId, notice.id, notice.messageId, sessionId),
    /fixed owned message/i);
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'lead','Review current Task',$5,$6,'queued',1,$7,$7)`,
    [projectId, notice.messageId, notice.operationId, sessionId, item.taskId, item.revisionId, now]);
  const linked = await linkLeaderNoticeMessage(pool, projectId, notice.id, notice.messageId, sessionId);
  assert.equal(linked.state, "linked");
  assert.equal(linked.messageState, "queued");
  assert.equal(linked.nativeTurnId, null);
  await pool.query(`UPDATE session_message SET state='processing',version=2,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`, [projectId, notice.messageId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'receiver','running',$6,$7,1,now(),now())`,
    [projectId, randomUUID(), notice.messageId, sessionId, randomUUID(), `message-turn-${notice.id}`, hash]);
  await pool.query(`INSERT INTO session_message_read_receipt(project_id,message_id,actor_id,evidence,recorded_at)
    VALUES($1,$2,'receiver','read the original',now())`, [projectId, notice.messageId]);
  const observed = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items[0]!;
  assert.equal(observed.messageState, "processing");
  assert.equal(observed.processingState, "running");
  assert.equal(observed.nativeTurnId, `message-turn-${notice.id}`);
  assert.ok(observed.readAt);
  assert.equal(await hasInFlightLeaderNoticeMessage(pool, projectId, sessionId), false);
  assert.equal(await hasInFlightLeaderNoticeMessage(pool, projectId, randomUUID()), true);
  assert.deepEqual(await linkLeaderNoticeMessage(pool, projectId, notice.id, notice.messageId, sessionId), observed);
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.length, 1);
});

test("Task channel only sends worker questions and blockers, never progress or Leader replies", async () => {
  const item = await task("in_progress"), { sessionId, runId } = await sessionRun(item);
  const discussionId = randomUUID();
  await pool.query(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,
    prepared_document_revision_id,current_document_revision_id,task_id,task_revision_id,adopted_documents,
    question,options,authorization_boundary,target_session_label,actor_id,created_at,updated_at,
    collaboration_run_id,collaboration_session_id,collaboration_issuer_actor_id,collaboration_recipient_actor_id)
    VALUES($1,$2,1,'task_collaboration','prepared',$3,$4,$4,$5,$6,'[]'::jsonb,
      'Work question','[]'::jsonb,'scope','worker','lead',$7,$7,$8,$9,'lead','worker')`,
    [projectId, discussionId, item.documentId, item.documentRevisionId, item.taskId, item.revisionId, now, runId, sessionId]);
  for (const [index, kind, actor] of [
    [1, "progress", "worker"], [2, "question", "worker"], [3, "blocker", "worker"],
    [4, "question", "lead"], [5, "answer", "lead"],
  ] as const) {
    await pool.query(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,
      actor_id,created_at,collaboration_payload) VALUES($1,$2,$3,$4,'message',$5,$6,$7,$8::jsonb)`,
      [projectId, discussionId, randomUUID(), index, item.documentId, actor, now,
        JSON.stringify({ type: "message", kind, recipientActorId: actor === "worker" ? "lead" : "worker",
          body: { documentId: item.documentId, revisionId: item.documentRevisionId }, replyToEventId: null })]);
  }
  const kinds = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.map(n => n.kind);
  assert.deepEqual(kinds.sort(), ["task_blocker", "task_question"]);
});

test("signed submission is quiet until blocked; a later failed sealing attempt creates another notice", async () => {
  const item = await task("in_progress"), { sessionId, runId } = await sessionRun(item);
  const submissionId = randomUUID();
  await pool.query(`INSERT INTO ordinary_run_submission(project_id,submission_id,run_id,task_id,session_id,
    task_revision_id,run_input_hash,operation_id,command_hash,delivery_operation_id,delivery_intent,
    submitted_by,state,version,created_at_utc,updated_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'worker','submitted',1,$12,$12)`,
    [projectId, submissionId, runId, item.taskId, sessionId, item.revisionId, hash,
      randomUUID(), hash, randomUUID(), JSON.stringify({ artifactRef: "artifact", artifactRevision: "rev",
        contentHash: hash, technicalResult: "passed", technicalEvidence: "checked", reason: "done" }), now]);
  await pool.query(`UPDATE runtime_run SET state='completed',native_turn_id=$4,version=2,updated_at=$3
    WHERE project_id=$1 AND run_id=$2`, [projectId, runId, now, `turn-${runId}`]);
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.length, 0);
  await pool.query(`UPDATE ordinary_run_submission SET state='blocked',reason='sealing needs review',version=2,
    updated_at_utc=now() WHERE project_id=$1 AND run_id=$2`, [projectId, runId]);
  const rows = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "run_submission_blocked");
  assert.match(rows[0]!.sourceRef, new RegExp(`^submission:${submissionId}@v2$`));
  await pool.query(`UPDATE ordinary_run_submission SET state='blocked',reason='still blocked',version=3,
    updated_at_utc=now() WHERE project_id=$1 AND run_id=$2`, [projectId, runId]);
  assert.equal((await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items.length, 1);
  await pool.query(`UPDATE ordinary_run_submission SET state='sealing',reason='retry',version=4,
    expected_task_version=1,terminal_run_version=2,sealed_by='sealer',delivery_command_hash=$3,
    updated_at_utc=now() WHERE project_id=$1 AND run_id=$2`, [projectId, runId, hash]);
  await pool.query(`UPDATE ordinary_run_submission SET state='blocked',reason='different sealing failure',version=5,
    updated_at_utc=now() WHERE project_id=$1 AND run_id=$2`, [projectId, runId]);
  const repeated = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items;
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0]!.sourceEventId, repeated[1]!.sourceEventId);
  assert.equal(repeated[0]!.sourceRef, `submission:${submissionId}@v5`);
});

test("public notice pages are recent-first and retain stale historical sources", async () => {
  const item = await task("todo");
  const first = (await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 10 })).items[0]!;
  const nextRevision = randomUUID();
  await pool.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,
    actor_id,reason,created_at,kind,content_document_id,content_revision_id)
    VALUES($1,$2,$3,2,'Task','check','worker','todo','lead','updated',$4,NULL,$5,$6)`,
    [projectId, item.taskId, nextRevision, now, item.documentId, item.documentRevisionId]);
  await pool.query(`UPDATE task SET version=2,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2`,
    [projectId, item.taskId, nextRevision]);
  const page = await listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 1 });
  assert.equal(page.items[0]!.id, first.id);
  assert.equal(page.items[0]!.stale, true);
  assert.equal((await listPendingLeaderNotices(pool, projectId, {limit: 100})).items
    .some(x => x.id === first.id), false);
  const latest = await listLeaderNotices(pool, projectId, { limit: 3 });
  assert.deepEqual(latest.items.map(x => [x.occurredAt, x.id]),
    [...latest.items.map(x => [x.occurredAt, x.id])].sort((a, b) =>
      b[0]!.localeCompare(a[0]!) || b[1]!.localeCompare(a[1]!)));
  assert.ok(latest.nextCursor);
  const next = await listLeaderNotices(pool, projectId, { limit: 3, cursor: latest.nextCursor });
  assert.equal(next.items.some(x => latest.items.some(y => y.id === x.id)), false);
  await assert.rejects(listLeaderNotices(pool, projectId, { taskId: item.taskId, limit: 3,
    cursor: latest.nextCursor }), /cursor/i);
});
