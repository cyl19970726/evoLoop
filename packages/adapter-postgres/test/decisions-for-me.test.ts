// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { readDecisionsForMe } from "../src/decisions-for-me.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_decide_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
  hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
const p = randomUUID();
const leader: Principal = { actorId: "leader", projectIds: [p], permissions: ["read", "write", "review"] };
const user: Principal = { actorId: "the-user", projectIds: [p], permissions: ["read", "write", "review"], identityKind: "human" };
const other: Principal = { actorId: "someone-else", projectIds: [p], permissions: ["read", "write"] };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(leader, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Decisions" });
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

const send = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { projectId: p, operationId: randomUUID(), ...command } as never);
const mine = (actorId = user.actorId, canDecide = true) => readDecisionsForMe(pool, p, actorId, canDecide);

/** Heavy history rows (Role revision, Goal, Stage, collaboration channel) are written past their foreign keys and guards: only their reading is under test. */
async function seed(fn: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
    await fn((sql, values) => c.query(sql, values));
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
}

test("Role proposals and stage proposals wait for an identity that can decide them, and leave the list when decided", async () => {
  const roleId = randomUUID(), revisionId = randomUUID(), stageId = randomUUID();
  await seed(async q => {
    await q(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'candidate','leader',now(),now()+interval '1 day')`, [p, roleId, revisionId]);
    await q(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'candidate',$4::jsonb,'leader','proposed',now(),now()+interval '1 day')`,
      [p, roleId, revisionId, JSON.stringify({ title: "Release steward", goal: "Own the release checklist" })]);
    await q(`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at) VALUES($1,$2,$3,1,'First usable board','Does the board help?','proposed','leader',now())`, [p, stageId, randomUUID()]);
  });
  const items = (await mine()).items;
  assert.deepEqual(items.map(i => i.kind).sort(), ["role_proposal", "stage_proposal"]);
  const role = items.find(i => i.kind === "role_proposal")!;
  assert.equal(role.title, "Release steward"); assert.equal(role.proposedBy, "leader"); assert.ok(role.at);
  assert.equal(role.kind === "role_proposal" && role.roleId, roleId);
  assert.deepEqual((await mine(other.actorId, false)).items, [], "an identity that cannot decide is not asked to");
  // Decided (accepted for trial / stage activated): it leaves the list.
  await seed(async q => {
    await q("UPDATE role_definition SET state='trial' WHERE project_id=$1 AND role_id=$2", [p, roleId]);
    await q("UPDATE project_stage SET state='active' WHERE project_id=$1 AND stage_id=$2", [p, stageId]);
  });
  assert.deepEqual((await mine()).items, []);
});

test("a decision request is listed only for the identity it names, can be answered only by them with one of its options, and then disappears", async () => {
  const requestId = randomUUID();
  const created = await send(leader, { type: "decision.request.create", requestId, requestedFrom: user.actorId, subject: "Dispatch to the new reviewer Role?",
    question: "The Role definition asks for your confirmation before it is dispatched.", options: ["确认派发", "先不派"] });
  assert.equal(created.status, "applied", JSON.stringify(created));
  const items = (await mine()).items;
  const item = items.find(i => i.id === requestId)!;
  assert.equal(item.kind, "decision_request"); assert.equal(item.title, "Dispatch to the new reviewer Role?"); assert.equal(item.proposedBy, "leader");
  assert.deepEqual((await mine(other.actorId, false)).items, [], "someone else does not see it");
  // Only the asked identity answers; only with an offered option; a stale version is refused.
  const wrong = await send(other, { type: "decision.request.answer", requestId, expectedVersion: 1, answer: "确认派发", reason: "not mine" });
  assert.equal((wrong as { code?: string }).code, "NOT_THE_DECIDER");
  const bad = await send(user, { type: "decision.request.answer", requestId, expectedVersion: 1, answer: "随便", reason: "x" });
  assert.equal((bad as { code?: string }).code, "ANSWER_NOT_AN_OPTION");
  const stale = await send(user, { type: "decision.request.answer", requestId, expectedVersion: 7, answer: "确认派发", reason: "x" });
  assert.equal((stale as { code?: string }).code, "VERSION_CONFLICT");
  assert.ok((await mine()).items.some(i => i.id === requestId), "refused answers do not clear it");
  const answered = await send(user, { type: "decision.request.answer", requestId, expectedVersion: 1, answer: "确认派发", reason: "reviewed the Role" });
  assert.equal(answered.status, "applied", JSON.stringify(answered));
  assert.ok(!(await mine()).items.some(i => i.id === requestId), "decided: gone from the list");
  const row = (await pool.query("SELECT state,answer,answered_by FROM decision_request WHERE request_id=$1", [requestId])).rows[0];
  assert.deepEqual(row, { state: "answered", answer: "确认派发", answered_by: user.actorId });
  // The asker can withdraw an open request; a request cannot be asked of oneself or by someone without review.
  const second = randomUUID();
  await send(leader, { type: "decision.request.create", requestId: second, requestedFrom: user.actorId, subject: "Another", question: "Q?" });
  const noReview = await send(other, { type: "decision.request.withdraw", requestId: second, expectedVersion: 1, reason: "r" }).catch(e => ({ code: (e as { code: string }).code }));
  assert.equal((noReview as { code?: string }).code, "FORBIDDEN");
  assert.equal((await send(leader, { type: "decision.request.withdraw", requestId: second, expectedVersion: 1, reason: "no longer needed" })).status, "applied");
  assert.ok(!(await mine()).items.some(i => i.id === second));
  const self = await send(leader, { type: "decision.request.create", requestId: randomUUID(), requestedFrom: leader.actorId, subject: "x", question: "y" });
  assert.equal((self as { code?: string }).code, "DECISION_SELF");
});

test("a question in a Task discussion that names me stays until I answer or resolve it; a reply or a resolved receipt clears only mine", async () => {
  const discussionId = randomUUID(), docId = randomUUID(), taskId = randomUUID(), revId = randomUUID(), questionEvent = randomUUID(), otherQuestion = randomUUID();
  await seed(async q => {
    await q(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Which source should I use?',1,$3,'discussion','draft')`, [p, docId, revId]);
    await q(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,current_document_revision_id,task_id,task_revision_id,question,options,authorization_boundary,
      target_session_label,actor_id,created_at,updated_at,collaboration_run_id,collaboration_session_id,collaboration_issuer_actor_id,collaboration_recipient_actor_id)
      VALUES($1,$2,1,'task_collaboration','prepared',$3,$4,$4,$5,$6,'','[]'::jsonb,'','', 'worker',now(),now(),$7,$8,'worker','the-user')`, [p, discussionId, docId, revId, taskId, randomUUID(), randomUUID(), randomUUID()]);
    for (const [id, version, recipient] of [[questionEvent, 1, "the-user"], [otherQuestion, 2, "someone-else"]] as const)
      await q(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,actor_id,created_at,collaboration_payload) VALUES($1,$2,$3,$4,'message',$5,'worker',now(),$6::jsonb)`,
        [p, discussionId, id, version, docId, JSON.stringify({ type: "message", kind: "question", recipientActorId: recipient, body: { documentId: docId, revisionId: revId }, replyToEventId: null })]);
  });
  let items = (await mine()).items.filter(i => i.kind === "task_question");
  assert.equal(items.length, 1, "only the question that names me");
  assert.equal(items[0]!.id, questionEvent); assert.equal(items[0]!.proposedBy, "worker");
  assert.equal(items[0]!.kind === "task_question" && items[0].taskId, taskId);
  // A resolved receipt by someone else does not clear mine; mine (the named identity) does.
  await seed(async q => q(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,actor_id,created_at,collaboration_payload) VALUES($1,$2,$3,3,'receipt',$4,'worker',now(),$5::jsonb)`,
    [p, discussionId, randomUUID(), docId, JSON.stringify({ type: "receipt", messageEventId: questionEvent, stage: "resolved", evidence: { documentId: docId, revisionId: revId }, continuation: null })]));
  assert.equal((await mine()).items.filter(i => i.kind === "task_question").length, 1, "the asker's own receipt is not my answer");
  await seed(async q => q(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,actor_id,created_at,collaboration_payload) VALUES($1,$2,$3,4,'message',$4,'the-user',now(),$5::jsonb)`,
    [p, discussionId, randomUUID(), docId, JSON.stringify({ type: "message", kind: "answer", recipientActorId: "worker", body: { documentId: docId, revisionId: revId }, replyToEventId: questionEvent })]));
  items = (await mine()).items.filter(i => i.kind === "task_question");
  assert.equal(items.length, 0, "my reply to the question clears it");
});
