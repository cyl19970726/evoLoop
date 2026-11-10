// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
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
  throw new Error("Document revision number upgrade requires a dedicated evoloop_*_test database");
const schema = `el_docrev_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const up = (count: number) => runner({ databaseUrl: url!, dir: migrations, migrationsTable: "pgmigrations", schema,
  createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true, count, log: () => {} });
const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** A legacy document whose revisions are written exactly as listed: [id, previous, created minute]. */
async function legacyDocument(revisions: Array<[string, string | null, number]>) {
  const documentId = randomUUID();
  await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
    VALUES($1,$2,'Legacy',$3,$4,'spec','draft')`, [projectId, documentId, revisions.length, revisions.at(-1)![0]]);
  for (const [id, previous, minute] of revisions)
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
      created_at,previous_revision_id,reason) VALUES($1,$2,$3,$4,'markdown',$5,'legacy',$6,$7,'legacy')`,
    [projectId, documentId, id, `# ${id}`, sha(`# ${id}`), at(minute), previous]);
  return documentId;
}
const u = () => randomUUID();
const numbered = async (documentId: string) => Object.fromEntries((await client.query(
  "SELECT revision_id,revision_number FROM document_revision WHERE project_id=$1 AND document_id=$2", [projectId, documentId]))
  .rows.map(row => [row.revision_id, row.revision_number]));
const observations = async () => Number((await client.query(
  "SELECT count(*) AS n FROM session_observation_change WHERE project_id=$1", [projectId])).rows[0].n);

const ids = { skew: [u(), u(), u()], tie: ["ffffffff-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  fork: [u(), u(), u()], roots: [u(), u()], single: [u()], long: Array.from({ length: 30 }, u) };
const documents: Record<keyof typeof ids, string> = {} as never;
let observationsBefore = 0;
/** Read-only check an operator can run before 069: documents that will be numbered by time instead of chain. */
const preflight = `SELECT project_id, document_id, count(*) AS revisions,
    count(*) FILTER (WHERE previous_revision_id IS NULL) AS roots,
    count(DISTINCT previous_revision_id) AS parents
  FROM document_revision GROUP BY project_id, document_id
  HAVING count(*) FILTER (WHERE previous_revision_id IS NULL) <> 1
    OR count(DISTINCT previous_revision_id) <> count(*) - 1`;
let notOneChain: string[] = [];

before(async () => {
  await up(readdirSync(migrations).filter(name => /^\d{3}_.*\.mjs$/.test(name) && Number(name.slice(0, 3)) <= 68).length);
  await client.connect();
  await client.query("BEGIN");
  await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Legacy revisions',$2)", [projectId, at(0)]);
  // One chain written while the clock went backward: chain order 1,2,3 is not time order.
  documents.skew = await legacyDocument([[ids.skew[0]!, null, 30], [ids.skew[1]!, ids.skew[0]!, 10], [ids.skew[2]!, ids.skew[1]!, 20]]);
  // Same timestamp, and the later revision's ID sorts first.
  documents.tie = await legacyDocument([[ids.tie[0]!, null, 5], [ids.tie[1]!, ids.tie[0]!, 5]]);
  // Not one chain: two children of the same revision, and two roots. Both fall back to time, then ID.
  documents.fork = await legacyDocument([[ids.fork[0]!, null, 0], [ids.fork[1]!, ids.fork[0]!, 50], [ids.fork[2]!, ids.fork[0]!, 40]]);
  documents.roots = await legacyDocument([[ids.roots[0]!, null, 20], [ids.roots[1]!, null, 15]]);
  documents.single = await legacyDocument([[ids.single[0]!, null, 1]]);
  documents.long = await legacyDocument(ids.long.map((id, index) => [id, index ? ids.long[index - 1]! : null, 59 - index]));
  await client.query("COMMIT");
  observationsBefore = await observations();
  notOneChain = (await client.query(preflight)).rows.map(row => row.document_id).sort();
  await up(1);
});
after(async () => {
  await client.end().catch(() => {});
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
});

test("069 numbers existing chains along previous_revision_id, not by timestamp or ID", async () => {
  assert.deepEqual(await numbered(documents.skew), { [ids.skew[0]!]: 1, [ids.skew[1]!]: 2, [ids.skew[2]!]: 3 });
  assert.deepEqual(await numbered(documents.tie), { [ids.tie[0]!]: 1, [ids.tie[1]!]: 2 });
  assert.deepEqual(await numbered(documents.single), { [ids.single[0]!]: 1 });
  assert.deepEqual(await numbered(documents.long), Object.fromEntries(ids.long.map((id, index) => [id, index + 1])),
    "a 30-revision chain written with ever earlier timestamps keeps chain order");
});

test("069 falls back to created_at, revision_id only for a document that is not one chain", async () => {
  assert.deepEqual(notOneChain, [documents.fork, documents.roots].sort(), "the preflight query names exactly these documents");
  assert.deepEqual(await numbered(documents.fork), { [ids.fork[0]!]: 1, [ids.fork[2]!]: 2, [ids.fork[1]!]: 3 });
  assert.deepEqual(await numbered(documents.roots), { [ids.roots[1]!]: 1, [ids.roots[0]!]: 2 });
});

test("069 leaves revisions immutable and the observation journal untouched, then numbers new inserts", async () => {
  assert.equal(await observations(), observationsBefore, "the backfill is not recorded as a business change");
  const triggers = (await client.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='document_revision'::regclass
    AND tgname IN ('immutable_document_revision','document_revision_allocation_observation','document_revision_number')`)).rows;
  assert.deepEqual(Object.fromEntries(triggers.map(row => [row.tgname, row.tgenabled])),
    { immutable_document_revision: "O", document_revision_allocation_observation: "O", document_revision_number: "O" });
  const indexes = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='document_revision'
    ORDER BY indexname`, [schema])).rows.map(row => row.indexname);
  assert.deepEqual(indexes, ["document_revision_number_unique", "document_revision_payload_unique", "document_revision_pkey"],
    "the backfill's temporary previous-revision index is gone");
  const nullable = (await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1
    AND table_name='document_revision' AND column_name='revision_number'`, [schema])).rows[0];
  assert.equal(nullable.is_nullable, "NO");
  await assert.rejects(client.query("UPDATE document_revision SET revision_number=revision_number WHERE project_id=$1", [projectId]),
    { message: /immutable/ });
  const next = u();
  await client.query("BEGIN");
  await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
    created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# next','markdown',$4,'new',$5,$6,'after upgrade')`,
  [projectId, documents.skew, next, sha("# next"), at(0), ids.skew[2]]);
  await client.query("UPDATE process_document SET version=version+1,current_revision_id=$3 WHERE project_id=$1 AND document_id=$2",
    [projectId, documents.skew, next]);
  await client.query("COMMIT");
  assert.equal((await numbered(documents.skew))[next], 4);
  assert.equal(await observations(), observationsBefore + 2, "ordinary writes still reach the observation journal");
});
