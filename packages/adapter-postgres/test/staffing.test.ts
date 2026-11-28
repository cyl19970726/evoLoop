// 分工检查 facts from real rows (packages/adapter-postgres/src/staffing.ts): each open Session with its Runs and the deliveries a consumer used, each Role
// with its class and review date, closed Sessions and other projects left out. The rows are written directly (constraints stepped around): what is under
// test is the read, not the workflow that makes them. Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { buildStaffingCheck } from "../../core/src/staffing/index.ts";
import { migrate } from "../src/index.ts";
import { PgStaffing } from "../src/staffing.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Staffing tests require a dedicated evoloop test database");
const schema = `el_staffing_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), otherProject = randomUUID();
const now = "2026-11-27T08:00:00.000Z";
const days = (n: number) => new Date(Date.parse(now) - n * 86_400_000).toISOString();
const leader = randomUUID(), dev = randomUUID(), qa = randomUUID();
const sha = "a".repeat(64);

let client: pg.PoolClient;
const role = async (project: string, roleId: string, title: string, state: string, reviewAt: string, roleClass?: "system" | "business") => {
  const revision = randomUUID();
  await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,trial_started_at_utc,review_at_utc)
    VALUES($1,$2,1,$3,$4,'author',$5,$5,$6)`, [project, roleId, revision, state, days(20), reviewAt]);
  await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
    VALUES($1,$2,$3,1,$4,$5::jsonb,'author','test',$6,$7)`, [project, roleId, revision, state, JSON.stringify({ title, ...(roleClass ? { roleClass } : {}) }), days(20), reviewAt]);
};
const session = async (project: string, roleId: string, state: string, createdAt: string, displayName?: string) => {
  const sessionId = randomUUID();
  await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/staffing','project','danger-full-access','never',$4,1,$5,$6,$7,'agent',$8,$8)`,
    [project, sessionId, roleId, state, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), createdAt]);
  if (displayName) await client.query(`INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,actor_id,reason,updated_at,identity_color,identity_mark)
    VALUES($1,'owned',$2,1,$3,'','current','resident','author','test',$4,'violet','diamond')`, [project, sessionId, displayName, createdAt]);
  return sessionId;
};
/** One Run of the Session, optionally with a delivery and the observations made of it. */
const run = async (project: string, sessionId: string, state: string, updatedAt: string, observations?: string[]) => {
  const runId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID();
  await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at,execution_profile_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',$8,$9,1,$10,'agent',$11,$11,'{}'::jsonb)`, [project, runId, taskId, revisionId, randomUUID(), sessionId, randomUUID(), sha, state, `turn-${runId}`, updatedAt]);
  if (!observations) return;
  const deliveryId = randomUUID();
  await client.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at,run_id)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','candidate','agent',$6,$7)`, [project, deliveryId, taskId, revisionId, sha, updatedAt, runId]);
  for (const result of observations) await client.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'qa','agent',$5,'actual use','checked','qa',$6)`, [project, randomUUID(), taskId, deliveryId, result, updatedAt]);
};
const ids: Record<string, string> = {};

before(async () => {
  await migrate(url!, schema);
  client = await pool.connect();
  for (const [id, title] of [[projectId, "Staffing"], [otherProject, "Another project"]])
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)`, [id, title, days(30)]);
  // The fixtures are bare rows: foreign keys and head-version triggers are not what this file checks.
  await client.query("SET session_replication_role = replica");
  await role(projectId, leader, "Leader", "trial", days(4), "system");
  await role(projectId, dev, "功能开发", "trial", days(2), "business");
  await role(projectId, qa, "验收", "active", days(9));
  ids.leader = await session(projectId, leader, "ready", days(15), "Leader · Codex");
  ids.dev1 = await session(projectId, dev, "ready", days(12), "功能开发 · 1");
  ids.dev2 = await session(projectId, dev, "ready", days(1), "功能开发 · 2");
  ids.qa1 = await session(projectId, qa, "ready", days(6));
  ids.closed = await session(projectId, dev, "closed", days(0.5), "功能开发 · 已收回");
  // dev1: three Runs, one still running; two deliveries, one used, one refused and then used by a second observation is still one delivery.
  await run(projectId, ids.dev1!, "completed", days(5), ["notUsed", "used"]);
  await run(projectId, ids.dev1!, "completed", days(3), ["failed"]);
  await run(projectId, ids.dev1!, "running", days(0.2));
  // dev2: one Run, a delivery nobody has used yet.
  await run(projectId, ids.dev2!, "completed", days(0.5), []);
  await run(projectId, ids.closed!, "completed", days(0.4), ["used"]);
  // Another project's rows never count.
  const foreign = await session(otherProject, dev, "ready", days(0.1), "别的项目");
  await run(otherProject, foreign, "completed", days(0.1), ["used"]);
  await role(otherProject, randomUUID(), "别的职责", "trial", days(8), "business");
  await client.query("RESET session_replication_role");
});
after(async () => {
  client.release();
  await pool.end();
  const admin = new pg.Client({ connectionString: url! }); await admin.connect();
  try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
});

test("the facts list every Role and every Session that is not closed, with Runs and used deliveries counted per Session", async () => {
  const facts = await new PgStaffing(client, projectId).staffingFacts();
  assert.deepEqual(facts.roles.map(item => [item.title, item.state, item.roleClass, item.reviewAtUtc]).sort(),
    [["Leader", "trial", "system", days(4)], ["功能开发", "trial", "business", days(2)], ["验收", "active", null, days(9)]].sort());
  const byId = new Map(facts.sessions.map(item => [item.sessionId, item]));
  assert.deepEqual([...byId.keys()].sort(), [ids.leader, ids.dev1, ids.dev2, ids.qa1].sort(), "the closed Session and the other project's are left out");
  assert.deepEqual(byId.get(ids.dev1!), { sessionId: ids.dev1, roleId: dev, displayName: "功能开发 · 1", tenure: "resident", state: "ready", createdAt: days(12),
    runs: 3, openRuns: 1, lastRunAt: days(0.2), deliveries: 2, acceptedDeliveries: 1 });
  assert.deepEqual(byId.get(ids.dev2!), { sessionId: ids.dev2, roleId: dev, displayName: "功能开发 · 2", tenure: "resident", state: "ready", createdAt: days(1),
    runs: 1, openRuns: 0, lastRunAt: days(0.5), deliveries: 1, acceptedDeliveries: 0 });
  assert.deepEqual(byId.get(ids.qa1!), { sessionId: ids.qa1, roleId: qa, displayName: null, tenure: null, state: "ready", createdAt: days(6),
    runs: 0, openRuns: 0, lastRunAt: null, deliveries: 0, acceptedDeliveries: 0 });
});

test("the check built from those rows names the due trials, the unproven last addition and the idle Session", async () => {
  const check = buildStaffingCheck({ projectId, facts: await new PgStaffing(client, projectId).staffingFacts(), now });
  assert.deepEqual(check.trialsDue.map(item => [item.title, item.layer, item.daysOverdue, item.openSessions]), [["Leader", "system", 4, 1], ["功能开发", "business", 2, 2]]);
  assert.equal(check.lastAddition?.sessionId, ids.dev2);
  assert.equal(check.lastAddition?.proven, false);
  assert.deepEqual(check.idle.map(item => [item.sessionId, item.idleDays, item.neverRan]), [[ids.qa1, 6, true]]);
  assert.deepEqual(check.blockers.map(item => item.code), ["TRIAL_REVIEW_OVERDUE", "LAST_ADDITION_UNPROVEN"]);
  assert.deepEqual(check.team.map(row => [row.title, row.layer, row.openSessions]), [["Leader", "system", 1], ["功能开发", "business", 2], ["验收", "business", 1]]);
});
