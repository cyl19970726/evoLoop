// “跳到” (Task 5eb93990): GET /api/projects/:projectId/jump finds the objects a pasted id, id prefix or PR number names,
// only inside the caller's project, and only for a project member. Real PostgreSQL (dedicated evoloop_*_test database)
// and the real route and WorkflowService; stages, schedules, agents and deliveries are seeded with SQL because their
// commands need whole Runs, and the lookup reads only those rows.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import type { Principal } from "@evoloop/contracts";
import type { JumpResult } from "@evoloop/contracts/object-jump";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { registerObjectJumpRoutes } from "../../apps/coordinator/src/object-jump/routes.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_jump_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
const p = randomUUID(), other = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const member: Principal = { actorId: "member", projectIds: [p], permissions: ["task", "document", "session", "management"], decisions: true };
const outsider: Principal = { actorId: "outsider", projectIds: [other], permissions: ["task", "document", "session", "management"], decisions: true };
// Every object gets an id that starts with its own 8 hex digits, so the samples can name them by prefix.
const id = (head: string, tail = 1) => `${head}-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const ids = {
  taskA: id("a1a1a1a1"), taskB: id("b2b2b2b2"), docA: id("c3c3c3c3"), docB: id("d4d4d4d4"),
  sessionA: id("e5e5e5e5"), sessionB: id("f6f6f6f6"), stageA: id("11111111"), stageB: id("22222222"),
  scheduleA: id("33333333"), scheduleB: id("44444444"), delivery: id("55555555"),
  // The same first 8 digits on a task and a document: the box lists both.
  clashTask: id("99999999", 1), clashDoc: id("99999999", 2),
};
const app = Fastify();
app.decorateRequest("principal", null);
app.addHook("onRequest", async (request, reply) => {
  const token = request.headers.authorization;
  request.principal = token === "Bearer member" ? member : token === "Bearer outsider" ? outsider : null;
  if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof DomainError) return reply.code(error.code === "FORBIDDEN" ? 403 : 409).send({ code: error.code, message: error.message });
  return reply.code(400).send({ code: "INVALID_INPUT", message: error.message });
});
registerObjectJumpRoutes(app, workflow, pool);

const jump = async (q: string, project = p, as = "member") => {
  const response = await app.inject({ method: "GET", url: `/api/projects/${project}/jump?q=${encodeURIComponent(q)}`, headers: { authorization: `Bearer ${as}` } });
  return { status: response.statusCode, body: response.json() as JumpResult };
};
const apply = (principal: Principal, projectId: string, command: Record<string, unknown>) =>
  workflow.execute(principal, { projectId, operationId: randomUUID(), ...command } as never);

before(async () => {
  await migrate(url!, schema);
  for (const [project, principal] of [[p, member], [other, outsider]] as const)
    await apply(principal, project, { type: "project.create", title: project === p ? "Jump" : "Other project" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  for (const [taskId, title] of [[ids.taskA, "第一项任务"], [ids.taskB, "第二项任务"], [ids.clashTask, "撞号的任务"]])
    await apply(member, p, { type: "task.create", taskId, title, content: "# 正文", acceptance: "ok", owner: role });
  for (const [documentId, title] of [[ids.docA, "第一份文档"], [ids.docB, "第二份文档"], [ids.clashDoc, "撞号的文档"]])
    await apply(member, p, { type: "document.create", documentId, title, body: `# ${title}` });
  // Another project's document whose id starts like one of ours: it must never come back from this project.
  await apply(outsider, other, { type: "document.create", documentId: id("a1a1a1a1", 9), title: "别的项目的文档", body: "# x" });
  const seed = await pool.connect();
  try {
    // The seeded rows name parents that need whole Runs or goals; the lookup reads none of them.
    await seed.query("SET session_replication_role = replica");
    for (const [sessionId, name] of [[ids.sessionA, "第一位智能体"], [ids.sessionB, "第二位智能体"]]) {
      await seed.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
        VALUES($1,$2,'r','/tmp','scope','workspace-write','on-request','reserved',1,$3,'a',now(),now())`, [p, sessionId, randomUUID()]);
      await seed.query(`INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,actor_id,reason,updated_at,identity_color,identity_mark)
        VALUES($1,'owned',$2,1,$3,'','current','resident','a','seed',now(),'violet','dot')`, [p, sessionId, name]);
    }
    for (const [stageId, deliverable] of [[ids.stageA, "第一个阶段的交付物"], [ids.stageB, "第二个阶段的交付物"]])
      await seed.query(`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at)
        VALUES($1,$2,$3,1,$4,'q','active','a',now())`, [p, stageId, randomUUID(), deliverable]);
    for (const [scheduleId, title] of [[ids.scheduleA, "第一条日程"], [ids.scheduleB, "第二条日程"]]) {
      const revision = randomUUID();
      await seed.query(`INSERT INTO schedule_definition(project_id,schedule_id,version,current_revision_id,state,watermark_utc) VALUES($1,$2,1,$3,'active',now())`, [p, scheduleId, revision]);
      await seed.query(`INSERT INTO schedule_revision(project_id,schedule_id,revision_id,version,timezone,rule,misfire,overlap_policy,task_template,authorization_scope,actor_id,reason,created_at_utc)
        VALUES($1,$2,$3,1,'UTC','{}','{}','skip',$4,'{}','a','seed',now())`, [p, scheduleId, revision, JSON.stringify({ title })]);
    }
    const taskRevision = (await seed.query(`SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2`, [p, ids.taskA])).rows[0].current_revision_id;
    await seed.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'https://github.com/example/repo/pull/12','abc',$5,'passed','e','r','a',now())`, [p, ids.delivery, ids.taskA, taskRevision, hash("x")]);
    // A different PR whose number merely contains 12: neither "12" nor "#12" may match it.
    await seed.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'https://github.com/example/repo/pull/1234','abc',$5,'passed','e','r','a',now())`, [p, id("66666666"), ids.taskB, (await seed.query(`SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2`, [p, ids.taskB])).rows[0].current_revision_id, hash("y")]);
  } finally { seed.release(); }
});
after(async () => {
  await app.close(); await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

const place = (kind: string, objectId: string, href: string) => ({ kind, id: objectId, href });
const shape = (r: JumpResult) => r.matches.map(m => ({ kind: m.kind, id: m.id, href: m.href }));
const samples: Array<[string, string, string]> = [
  ["task", ids.taskA, `/p/${p}/tasks/${ids.taskA}`], ["task", ids.taskB, `/p/${p}/tasks/${ids.taskB}`],
  ["document", ids.docA, `/p/${p}/documents/${ids.docA}`], ["document", ids.docB, `/p/${p}/documents/${ids.docB}`],
  ["session", ids.sessionA, `/p/${p}/sessions?session=${encodeURIComponent(`owned:${ids.sessionA}`)}`],
  ["session", ids.sessionB, `/p/${p}/sessions?session=${encodeURIComponent(`owned:${ids.sessionB}`)}`],
  ["stage", ids.stageA, `/p/${p}/journey?stage=${ids.stageA}`], ["stage", ids.stageB, `/p/${p}/journey?stage=${ids.stageB}`],
  ["schedule", ids.scheduleA, `/p/${p}/schedules?schedule=${ids.scheduleA}`], ["schedule", ids.scheduleB, `/p/${p}/schedules?schedule=${ids.scheduleB}`],
];

test("the first 8 digits and the full id of each kind of object land on its page", async () => {
  for (const [kind, objectId, href] of samples) {
    assert.deepEqual(shape((await jump(objectId.slice(0, 8))).body), [place(kind, objectId, href)], `${kind} ${objectId.slice(0, 8)}`);
    assert.deepEqual(shape((await jump(objectId)).body), [place(kind, objectId, href)], `${kind} full id`);
    assert.deepEqual(shape((await jump(objectId.slice(0, 13))).body), [place(kind, objectId, href)], `${kind} with a hyphen`);
    assert.deepEqual(shape((await jump(objectId.slice(0, 8).toUpperCase())).body), [place(kind, objectId, href)], `${kind} upper case`);
  }
  const named = (await jump(ids.sessionA.slice(0, 8))).body.matches[0];
  assert.equal(named.title, "第一位智能体");
  assert.equal((await jump(ids.stageA.slice(0, 8))).body.matches[0].title, "第一个阶段的交付物");
  assert.equal((await jump(ids.scheduleA.slice(0, 8))).body.matches[0].title, "第一条日程");
});

test("a delivery id and a PR number land on the task's 交付与使用 tab", async () => {
  const tab = `/p/${p}/tasks/${ids.taskA}?tab=delivery`;
  assert.deepEqual(shape((await jump(ids.delivery.slice(0, 8))).body), [place("delivery", ids.delivery, tab)]);
  assert.equal((await jump(ids.delivery.slice(0, 8))).body.matches[0].taskId, ids.taskA);
  assert.deepEqual(shape((await jump(ids.delivery)).body), [place("delivery", ids.delivery, tab)]);
  for (const text of ["#12", "12", " #12 "]) assert.deepEqual(shape((await jump(text)).body), [place("task", ids.taskA, tab)], text);
  assert.deepEqual((await jump("#13")).body.matches, [], "a PR number that is only part of another PR's number matches nothing");
  assert.deepEqual(shape((await jump("#1234")).body), [place("task", ids.taskB, `/p/${p}/tasks/${ids.taskB}?tab=delivery`)]);
});

test("two objects with the same first 8 digits come back as two rows, in a fixed order", async () => {
  const { body } = await jump("99999999");
  assert.deepEqual(body.matches.map(m => [m.kind, m.id, m.title]), [["task", ids.clashTask, "撞号的任务"], ["document", ids.clashDoc, "撞号的文档"]]);
  assert.equal(body.truncated, false);
});

test("no match, too short and odd characters are empty results, never errors", async () => {
  for (const text of ["deadbeef", "0123456", "abc", "", "'; DROP TABLE task;--", "%", "a1a1a1a1%", "a1a1a1a1_", "a1a1a1a1;", `a1a1a1a1"`, "'", "#0", "#", "#12abc", "pull/12", "zzzzzzzz"]) {
    const { status, body } = await jump(text);
    assert.equal(status, 200, text);
    assert.deepEqual(body.matches, [], text);
  }
  assert.equal((await jump("a1a1a1a1")).body.matches.length, 1, "the table is intact");
});

test("at most 10 matches, and the answer says when there were more", async () => {
  for (let n = 0; n < 11; n++) await apply(member, p, { type: "task.create", taskId: id("77777777", n + 1), title: `同前缀 ${n}`, content: "# x", acceptance: "ok", owner: role });
  const { body } = await jump("77777777");
  assert.equal(body.matches.length, 10);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.matches.map(m => m.id), Array.from({ length: 10 }, (_, n) => id("77777777", n + 1)), "ordered by id");
});

test("another project's objects are not found here, and a non-member or anonymous caller is refused", async () => {
  assert.deepEqual((await jump("a1a1a1a1", other, "outsider")).body.matches.map(m => m.title), ["别的项目的文档"]);
  assert.deepEqual((await jump(id("a1a1a1a1", 9))).body.matches, [], "this project does not return the other project's document");
  assert.deepEqual((await jump(id("a1a1a1a1", 9), other, "outsider")).body.matches.map(m => m.id), [id("a1a1a1a1", 9)]);
  const denied = await jump("a1a1a1a1", p, "outsider");
  assert.equal(denied.status, 403);
  assert.equal((denied.body as unknown as { code: string }).code, "FORBIDDEN");
  const anonymous = await app.inject({ method: "GET", url: `/api/projects/${p}/jump?q=a1a1a1a1` });
  assert.equal(anonymous.statusCode, 401);
  const other403 = await jump("a1a1a1a1", other, "member");
  assert.equal(other403.status, 403, "a member of one project cannot ask about another");
});

test("an id prefix is a range over the primary key, not a scan of every row", async () => {
  const c = await pool.connect();
  try {
    // Small test tables are scanned in order whatever the plan could do; with sequential scans off the planner
    // shows which index the query can use, and the range condition must be the one on the primary key.
    await c.query("SET enable_seqscan = off");
    for (const [table, column] of [["task", "task_id"], ["process_document", "document_id"], ["project_stage", "stage_id"], ["delivery", "delivery_id"]]) {
      const plan = (await c.query(`EXPLAIN SELECT ${column} FROM ${table} WHERE project_id=$1 AND ${column} BETWEEN $2::uuid AND $3::uuid ORDER BY ${column} LIMIT 11`,
        [p, "a1a1a1a1-0000-0000-0000-000000000000", "a1a1a1a1-ffff-ffff-ffff-ffffffffffff"])).rows.map(r => r["QUERY PLAN"]).join("\n");
      assert.match(plan, /Index (Only )?Scan using \w+_pkey/, `${table}: ${plan}`);
      assert.match(plan, new RegExp(`Index Cond: .*${column} >=`), `${table} range is an index condition: ${plan}`);
    }
  } finally { await c.query("RESET enable_seqscan"); c.release(); }
});
