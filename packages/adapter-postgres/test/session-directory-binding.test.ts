// A Session bound to a Role belongs to that Role's team however it was set up: through `session prepare` (which names it) or
// through reserve + bind (which does not). Neither falls into 待归类; a Session with no Role binding is still not guessed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session directory tests require a dedicated evoloop test database");
const schema = `el_dir_bind_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const project = randomUUID(), role = randomUUID(), roleRevision = randomUUID();
const at = "2026-11-10T00:00:00.000Z";
const reserveAndBind = randomUUID(), prepared = randomUUID(), unbound = randomUUID(), closedBound = randomUUID(), second = randomUUID();
const scope = JSON.stringify({ actorId: "reader", permissions: ["read"] });

async function session(id: string, provider: "codex" | "claude", model: string | null, state = "ready") {
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at,runtime_provider,model)
    VALUES($1,$2,$3,'/tmp','fixture','danger-full-access','never',$4,1,$5,$5,$6,'lead',$7,$7,$8,$9)`, [project, id, role, state, `native-${id}`, randomUUID(), at, provider, model]);
}
const bind = (id: string) => pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc) VALUES($1,$2,$3,$4,$5,'lead','fixture',$6)`, [project, randomUUID(), role, id, roleRevision, at]);

before(async () => {
  await migrate(url!, schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Directory',$2)", [project, at]);
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [project, role, roleRevision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{"title":"功能开发","roleClass":"business"}'::jsonb,'lead','fixture',$4,$4)`, [project, role, roleRevision, at]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await session(reserveAndBind, "claude", "sonnet");
  await session(prepared, "codex", null);
  await session(second, "claude", "sonnet");
  await session(unbound, "codex", "gpt-6-sol");
  await session(closedBound, "claude", "sonnet");
  for (const id of [reserveAndBind, prepared, second, closedBound]) await bind(id);
  // Creating a Session already files a visual identity row (no name, no membership); `session prepare` then names the
  // Session and files it as a current, resident member.
  await pool.query(`UPDATE session_profile SET version=2,display_name='功能开发 · 验收',purpose='独立验收',membership='current',tenure='resident',actor_id='lead',reason='prepared',updated_at=$3
    WHERE project_id=$1 AND target_kind='owned' AND target_id=$2`, [project, prepared, at]);
  await pool.query("UPDATE runtime_session SET state='closed',version=version+1,updated_at=now() WHERE project_id=$1 AND session_id=$2", [project, closedBound]);
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

const directory = (membership = "all") => uow.read(project, async reader => reader.sessionObservation!(scope).directory({ limit: 50, membership }));

test("a bound Session is a current member whether or not it was prepared; an unbound one is still unclassified; a closed one is historical", async () => {
  const page = await directory();
  const by = new Map(page.items.map(item => [item.key, item]));
  const view = (id: string) => by.get(`owned:${id}`)!;
  assert.equal(view(reserveAndBind).membership, "current", "reserve + bind, never named");
  assert.equal(view(prepared).membership, "current", "session prepare path");
  assert.equal(view(second).membership, "current");
  assert.match(view(reserveAndBind).membershipReason, /已按项目记录绑定到职责/);
  assert.equal(view(unbound).membership, "unclassified", "a ready Session without a Role binding is not guessed to belong");
  assert.equal(view(closedBound).membership, "historical");
  assert.deepEqual(page.totals, { current: 3, historical: 1, unclassified: 1 });
  // Both paths end up in the same group: business, under their Role.
  for (const id of [reserveAndBind, prepared]) assert.deepEqual(view(id).roles.map(item => [item.title, item.roleClass]), [["功能开发", "business"]]);
  // The default directory (current members) lists both, and not the unbound one.
  const current = (await directory("current")).items.map(item => item.key).sort();
  assert.deepEqual(current, [`owned:${reserveAndBind}`, `owned:${prepared}`, `owned:${second}`].sort());
});

test("every project-run Session reports its runtime and model, and several of one Role stay distinguishable", async () => {
  const items = (await directory()).items;
  const view = (id: string) => items.find(item => item.key === `owned:${id}`)!;
  assert.deepEqual(view(reserveAndBind).runtime, { provider: "claude", model: "sonnet" });
  assert.deepEqual(view(prepared).runtime, { provider: "codex", model: null });
  assert.deepEqual(view(unbound).runtime, { provider: "codex", model: "gpt-6-sol" });
  assert.equal(view(prepared).title, "功能开发 · 验收", "a registered name is kept as written");
  // Two unnamed Sessions of one Role carry the same service title; the runtime and the short identifier tell them apart on the page.
  assert.equal(view(reserveAndBind).title, view(second).title);
  assert.notEqual(view(reserveAndBind).key, view(second).key);
  assert.deepEqual([view(reserveAndBind).runtime, view(second).runtime].map(runtime => runtime?.provider), ["claude", "claude"]);
});
