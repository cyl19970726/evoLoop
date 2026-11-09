import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PoolClient } from "pg";
import { runner } from "node-pg-migrate";
import { defaultRoleSkillSelection } from "@evoloop/contracts/role-skills";
import { migrate } from "../src/index.ts";
import { PgRoleQueries } from "../src/roles.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Role runtime upgrade requires a dedicated evoloop_*_test database");
const schema = `el_role_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), now = "2026-11-01T00:00:00.000Z";
// single: one open Session; closedOnly: only closed Sessions; idle: none; split: open on both runtimes after 067;
// moved: closed Codex then open Claude; openFirst: open Codex and a newer closed Claude.
const roles = Object.fromEntries(["single", "closedOnly", "idle", "split", "moved", "openFirst"].map(name => [name, randomUUID()])) as Record<string, string>;
const up = (count: number) => runner({ databaseUrl: url!, dir: migrations, migrationsTable: "pgmigrations", schema,
  createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true, count, log: () => {} });

async function session(roleId: string, state: "reserved" | "closed", createdAt: string, provider?: "codex" | "claude") {
  const id = randomUUID();
  await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,
    state,version,operation_id,actor_id,created_at,updated_at${provider ? ",runtime_provider" : ""})
    VALUES($1,$2,$3,'/legacy','project','legacy-model','danger-full-access','never',$4,1,$5,'legacy-author',$6,$6${provider ? ",$7" : ""})`,
  [projectId, id, roleId, state, randomUUID(), createdAt, ...(provider ? [provider] : [])]);
  return id;
}
const bindings = async () => Object.fromEntries((await client.query("SELECT role_id,revision,runtime_provider,skills,actor_id,operation_id FROM role_runtime_revision WHERE project_id=$1",
  [projectId])).rows.map(row => [row.role_id, row]));

before(async () => {
  await up(readdirSync(migrations).filter(name => /^\d{3}_.*\.mjs$/.test(name) && Number(name.slice(0, 3)) <= 66).length);
  await client.connect();
  await client.query("BEGIN");
  await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)", [projectId, "Existing runtime roles", now]);
  for (const roleId of Object.values(roles)) {
    const revisionId = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [projectId, roleId, revisionId, now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active','{}'::jsonb,'lead','original',$4,$4)`, [projectId, roleId, revisionId, now]);
  }
  // Sessions from before providers existed; one stores the Role id in upper case.
  await session(roles.single!.toUpperCase(), "reserved", "2026-11-01T01:00:00.000Z");
  await session(roles.closedOnly!, "closed", "2026-11-01T01:00:00.000Z");
  await session(roles.split!, "reserved", "2026-11-01T01:00:00.000Z");
  await session(roles.moved!, "closed", "2026-11-01T01:00:00.000Z");
  await session(roles.openFirst!, "reserved", "2026-11-01T01:00:00.000Z");
  await session("coordinator", "reserved", "2026-11-01T01:00:00.000Z");
  await client.query("COMMIT");
  await up(1);
  await session(roles.split!, "reserved", "2026-11-02T01:00:00.000Z", "claude");
  await session(roles.moved!, "reserved", "2026-11-02T01:00:00.000Z", "claude");
  await session(roles.openFirst!, "closed", "2026-11-02T01:00:00.000Z", "claude");
  await up(1);
});
after(async () => {
  await client.end().catch(() => {});
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
});

test("067 marks every existing Session as Codex and 068 binds existing Roles to the runtime their Sessions use", async () => {
  const providers = (await client.query("SELECT runtime_provider, count(*)::int AS n FROM runtime_session WHERE project_id=$1 AND created_at < '2026-11-02' GROUP BY 1",
    [projectId])).rows;
  assert.deepEqual(providers, [{ runtime_provider: "codex", n: 6 }]);
  const bound = await bindings();
  assert.equal(bound[roles.single!]?.runtime_provider, "codex", "a Session stored with an upper-case Role id still counts");
  assert.equal(bound[roles.closedOnly!]?.runtime_provider, "codex", "closed Sessions still say which runtime the Role used");
  assert.equal(bound[roles.moved!]?.runtime_provider, "claude", "the open Session wins over an older closed one");
  assert.equal(bound[roles.openFirst!]?.runtime_provider, "codex", "an open Session wins over a newer closed one");
  assert.equal(bound[roles.idle!], undefined, "a Role without Sessions stays unbound");
  assert.equal(bound[roles.split!], undefined, "open Sessions on both runtimes leave the Role unbound");
  assert.equal(Object.keys(bound).length, 4, "owners that are not Roles are not bound");
  for (const row of Object.values(bound)) {
    assert.equal(row.revision, 1);
    assert.deepEqual(row.skills, defaultRoleSkillSelection(), "derived bindings use the same default selection as new ones");
    assert.equal(row.actor_id, "system:migration-068");
    assert.equal(row.operation_id, null);
  }
});

test("068 keeps the runtime of a bound Role fixed and its history append only", async () => {
  const insert = (roleId: string, revision: number, provider: string, skills: unknown = defaultRoleSkillSelection()) =>
    client.query(`INSERT INTO role_runtime_revision(project_id,role_id,revision,runtime_provider,skills,actor_id,reason,operation_id,created_at_utc)
      VALUES($1,$2,$3,$4,$5::jsonb,'lead','test',$6,now())`, [projectId, roleId, revision, provider, JSON.stringify(skills), randomUUID()]);
  await assert.rejects(session(roles.single!, "reserved", "2026-11-03T00:00:00.000Z", "claude"), /differs from the role binding/);
  await session(roles.single!.toUpperCase(), "reserved", "2026-11-03T00:00:00.000Z", "codex");
  await session("coordinator", "reserved", "2026-11-03T00:00:00.000Z", "claude");
  await session(roles.idle!, "reserved", "2026-11-03T00:00:00.000Z", "claude");
  await assert.rejects(insert(roles.single!, 2, "claude"), /bound and cannot change/);
  await assert.rejects(insert(roles.single!, 3, "codex"), /must follow the latest revision/);
  await assert.rejects(insert(roles.split!, 1, "claude"), /open Sessions on another runtime/);
  await assert.rejects(insert(roles.single!, 2, "codex", { ...defaultRoleSkillSelection(), extra: true }), /role_skill_selection_valid|check constraint/);
  await assert.rejects(insert(roles.single!, 2, "codex", { ...defaultRoleSkillSelection(), add: ["bad name"] }), /role_skill_selection_valid|check constraint/);
  await insert(roles.single!, 2, "codex", { ...defaultRoleSkillSelection(), personal: true, add: ["project:alpha"] });
  await assert.rejects(client.query("UPDATE role_runtime_revision SET reason='edited' WHERE project_id=$1 AND role_id=$2", [projectId, roles.single]));
  await assert.rejects(client.query("DELETE FROM role_runtime_revision WHERE project_id=$1 AND role_id=$2", [projectId, roles.single]));
  await assert.rejects(client.query("UPDATE runtime_session SET runtime_provider='codex',version=version+1 WHERE project_id=$1 AND role_id=$2 AND state='reserved'", [projectId, roles.moved]),
    /provider is immutable/, "an open Session cannot move to another runtime");
  const queries = new PgRoleQueries(client as unknown as PoolClient, projectId);
  assert.equal((await queries.getRoleRuntime(roles.single!))?.revision, 2);
  assert.deepEqual((await queries.listRoleRuntimeRevisions(roles.single!)).map(item => [item.revision, item.provider, item.skills.personal]),
    [[1, "codex", false], [2, "codex", true]]);
  assert.equal(await queries.getRoleRuntime(roles.idle!), null);
  await migrate(url!, schema);
  assert.equal(Object.keys(await bindings()).length, 4, "running the migrations again changes nothing");
});
