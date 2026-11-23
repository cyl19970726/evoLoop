// Migration 119 (Task afe7e585): 简报 becomes a Document kind and exactly the reports titled "每日简报 YYYY-MM-DD" move to it.
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Brief migration test requires a dedicated evoloop_*_test database");
const schema = `el_brief_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const up = (count: number) => runner({ databaseUrl: url!, dir: migrations, migrationsTable: "pgmigrations", schema,
  createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true, count, log: () => {} });
const files = readdirSync(migrations).filter(name => /^\d{3}_.*\.mjs$/.test(name));
const briefs = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"].map(day => `每日简报 ${day}`);
const unchanged: Array<[string, string]> = [["每日简报格式说明", "report"], ["关于每日简报的讨论", "discussion"], ["每日简报 2026-11-2", "report"],
  ["每日简报 2026-11-22 补", "report"], ["每日简报 2026-11-23", "spec"]];
const ids = new Map<string, string>();

async function insert(title: string, kind: string) {
  const documentId = randomUUID(), revisionId = randomUUID();
  ids.set(title, documentId);
  await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
    VALUES($1,$2,$3,3,$4,$5,'draft')`, [projectId, documentId, title, revisionId, kind]);
  await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
    VALUES($1,$2,$3,'# x','markdown',$4,'t',now(),'t')`, [projectId, documentId, revisionId, sha(titleKey(title))]);
}
const titleKey = (title: string) => title;
const kindCounts = async () => Object.fromEntries((await client.query(
  "SELECT coalesce(kind,'(none)') AS kind, count(*)::int AS n FROM process_document WHERE project_id=$1 GROUP BY 1", [projectId])).rows.map(r => [r.kind, r.n]));
let before130: Record<string, number> = {};

before(async () => {
  await up(files.filter(name => Number(name.slice(0, 3)) < 119).length);
  await client.connect();
  await client.query("BEGIN");
  await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Brief migration',now())", [projectId]);
  for (const title of briefs) await insert(title, "report");
  for (const [title, kind] of unchanged) await insert(title, kind);
  for (let i = 0; briefs.length + unchanged.length + i < 130; i += 1) await insert(`普通文档 ${i}`, ["spec", "task", "report", "issue"][i % 4]!);
  await client.query("COMMIT");
  before130 = await kindCounts();
  await up(1);
});
after(async () => {
  await client.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

test("five daily briefs become briefs; the counter-examples and every other document keep their kind and version", async () => {
  const after130 = await kindCounts();
  assert.equal(Object.values(before130).reduce((a, b) => a + b, 0), 130);
  assert.equal(after130.brief, 5);
  assert.equal(after130.report, before130.report! - 5, "only the five reports left report");
  for (const kind of ["spec", "task", "issue", "discussion"]) assert.equal(after130[kind] ?? 0, before130[kind] ?? 0, kind);
  for (const title of briefs) {
    const row = (await client.query("SELECT kind,version FROM process_document WHERE project_id=$1 AND document_id=$2", [projectId, ids.get(title)])).rows[0];
    assert.deepEqual(row, { kind: "brief", version: 3 }, "the version is not advanced by the reclassification");
  }
  for (const [title, kind] of unchanged) {
    const row = (await client.query("SELECT kind FROM process_document WHERE project_id=$1 AND document_id=$2", [projectId, ids.get(title)])).rows[0];
    assert.equal(row.kind, kind, title);
  }
});

test("the kind constraint knows brief and still refuses an unknown kind; a brief may name an origin", async () => {
  await assert.rejects(() => client.query("UPDATE process_document SET kind='digest',version=version+1 WHERE project_id=$1 AND document_id=$2", [projectId, ids.get(briefs[0]!)]), /process_document_kind_check/);
  const constraint = (await client.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='document_origin_complete'")).rows[0].def as string;
  assert.match(constraint, /'brief'/);
});
