// Task c3a8e5d1: the page-error list in PostgreSQL: one row per error, the same error from the same actor within a minute stored once, the newest 200 per project kept,
// and what is read back is what was redacted on the way in.
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/index.ts";
import { createClientErrorStore } from "../../../apps/coordinator/src/client-errors/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1))) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_cre_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), other = randomUUID();
let clock = new Date("2026-11-17T08:00:00.000Z");
const store = createClientErrorStore(pool as never, () => clock);
const input = (message: string, extra: Partial<{ route: string; commit: string | null }> = {}) => ({ route: "/p/x/sessions?session=a", message, componentStack: "\n    at A", commit: "a5a397b0b28c77d1a9fde8f7c433d161924c991e", ...extra });

before(async () => {
  await migrate(url!, schema);
  for (const id of [projectId, other]) await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'P',now())", [id]);
});
after(async () => { await pool.end(); const c = new pg.Client({ connectionString: url! }); await c.connect(); try { await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await c.end(); } });

test("a record is stored once, read back redacted, and repeated within a minute is not stored again", async () => {
  const first = await store.record(projectId, "viewer", input(`boom Bearer ${"t".repeat(43)}`));
  assert.equal(first.duplicate, false);
  const again = await store.record(projectId, "viewer", input(`boom Bearer ${"t".repeat(43)}`));
  assert.deepEqual([again.duplicate, again.record.id], [true, first.record.id]);
  const otherActor = await store.record(projectId, "someone", input(`boom Bearer ${"t".repeat(43)}`));
  assert.equal(otherActor.duplicate, false, "another actor is another record");
  clock = new Date(clock.getTime() + 61_000);
  assert.equal((await store.record(projectId, "viewer", input(`boom Bearer ${"t".repeat(43)}`))).duplicate, false, "after a minute it is stored again");
  const rows = await store.list(projectId);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => !row.message.includes("t".repeat(43)) && row.message.includes("[已隐去]")), "no token in what is read back");
  assert.deepEqual(rows.map(row => row.recordedAt), [...rows.map(row => row.recordedAt)].sort().reverse(), "newest first");
  const raw = (await pool.query("SELECT message FROM client_render_error WHERE project_id=$1", [projectId])).rows.map(row => row.message).join("");
  assert.ok(!raw.includes("t".repeat(43)), "nor in the table");
});

test("each project keeps its newest 200 and no more; other projects are untouched", async () => {
  await store.record(other, "viewer", input("other project error"));
  for (let n = 0; n < 205; n++) { clock = new Date(clock.getTime() + 1000); await store.record(projectId, "viewer", input(`distinct ${n}`)); }
  const count = (await pool.query("SELECT count(*)::int AS n FROM client_render_error WHERE project_id=$1", [projectId])).rows[0].n;
  assert.equal(count, 200);
  assert.equal((await store.list(projectId, 1))[0]!.message, "distinct 204", "the newest is kept");
  assert.equal((await store.list(other)).length, 1);
});

test("a commit that is not a hash is stored as none, and a limit above 50 is cut", async () => {
  const saved = await store.record(other, "viewer", input("odd commit", { commit: "main" }));
  assert.equal(saved.record.commit, null);
  assert.ok((await store.list(projectId, 500)).length <= 50);
});
