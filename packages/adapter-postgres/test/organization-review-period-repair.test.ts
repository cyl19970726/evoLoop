// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { PostgresUnitOfWork } from "../src/index.ts";
import {
  applyOrganizationReviewPeriodRepair,
  commandHashForPlan,
  loadTargetRows,
  planOrganizationReviewRepair,
  readRepairReadback,
} from "../../../scripts/repair-organization-review-periods.mjs";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Organization review repair requires a dedicated evoloop_*_test database");
const schema = `el_review_repair_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID();
const missingReviewDocumentId = randomUUID();
const missingReviewRevisionId = randomUUID();
const firstDocumentId = randomUUID();
const firstRevisionIds = [randomUUID(), randomUUID()];
const secondDocumentId = randomUUID();
const secondRevisionId = randomUUID();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (minute: number) => `2026-11-0${minute}T00:00:00.000Z`;
const firstPeriod = {
  observedFrom: "2026-11-04T03:57:54Z",
  observedTo: "2026-11-07T07:18:07Z",
  timeZone: "Asia/Taipei",
  previous: { documentId: missingReviewDocumentId, revisionId: missingReviewRevisionId },
};
const secondPeriod = {
  observedFrom: "2026-11-02T01:23:33.269976Z",
  observedTo: "2026-11-02T01:54:53Z",
  timeZone: "Asia/Taipei",
  previous: { documentId: firstDocumentId, revisionId: firstRevisionIds[1]! },
};
const beforeRows = new Map<string, any>();

async function migrate() {
  await runner({
    databaseUrl: url!, dir: migrations, migrationsTable: "pgmigrations", schema,
    createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true, log: () => {},
  });
}

async function insertReview(documentId: string, title: string, revisionIds: string[],
  previous: Array<string | null>) {
  await client.query(
    `INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
     VALUES($1,$2,$3,$4,$5,'organization_review','draft')`,
    [projectId, documentId, title, revisionIds.length, revisionIds.at(-1)]);
  for (let index = 0; index < revisionIds.length; index++) {
    const body = `# ${title} ${index + 1}`;
    await client.query(
      `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,
        previous_revision_id,reason,media_type,original_name,payload_ref,entrypoint,assets_manifest,organization_review)
       VALUES($1,$2,$3,$4,'markdown',$5,'migration-owner',$6,$7,'migrated','text/markdown','report.md',NULL,NULL,'[]'::jsonb,NULL)`,
      [projectId, documentId, revisionIds[index], body, sha(body), at(index + 1), previous[index]]);
  }
  const rows = await client.query(
    "SELECT * FROM document_revision WHERE project_id=$1 AND document_id=$2 ORDER BY revision_number",
    [projectId, documentId]);
  for (const row of rows.rows) beforeRows.set(`${documentId}/${row.revision_id}`, row);
}

async function observationCount() {
  return Number((await client.query(
    "SELECT count(*) AS n FROM session_observation_change WHERE project_id=$1", [projectId])).rows[0].n);
}

function sourceRows(targetRows: any[], periods: Map<string, object>) {
  return targetRows.map(row => ({
    project_id: row.project_id,
    document_id: row.document_id,
    revision_id: row.revision_id,
    body: row.body,
    format: row.format,
    content_hash: row.content_hash,
    author: row.author,
    created_at: new Date(row.created_at).toISOString(),
    previous_revision_id: row.previous_revision_id,
    reason: row.reason,
    media_type: row.media_type,
    original_name: row.original_name,
    payload_ref: row.payload_ref,
    entrypoint: row.entrypoint,
    assets_manifest: JSON.stringify(row.assets_manifest),
    organization_review: JSON.stringify(periods.get(`${row.document_id}/${row.revision_id}`)),
  }));
}

before(async () => {
  await migrate();
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Review repair',$2)",
      [projectId, at(1)]);
    await insertReview(firstDocumentId, "迁移来的两版复盘", firstRevisionIds, [null, firstRevisionIds[0]!]);
    await insertReview(secondDocumentId, "迁移来的一版复盘", [secondRevisionId], [null]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
});

after(async () => {
  await client.end().catch(() => {});
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("repair restores only organizationReview, records one audited operation and stays idempotent", async () => {
  const documentIds = [firstDocumentId, secondDocumentId];
  const periods = new Map([
    [`${firstDocumentId}/${firstRevisionIds[0]}`, firstPeriod],
    [`${firstDocumentId}/${firstRevisionIds[1]}`, firstPeriod],
    [`${secondDocumentId}/${secondRevisionId}`, secondPeriod],
  ]);
  const loaded = await loadTargetRows(client, projectId, documentIds);
  assert.equal(loaded.rows.length, 3);
  assert.ok(loaded.rows.every(row => row.organization_review === null));
  const source = sourceRows(loaded.rows, periods);
  const plan = planOrganizationReviewRepair({
    projectId, documentIds, sourceRows: source, targetRows: loaded.rows, documents: loaded.documents,
  });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.changes.length, 3);
  const observationsBefore = await observationCount();
  const operationId = randomUUID();
  const sourceDumpSha256 = "a".repeat(64);
  const commandHash = commandHashForPlan({
    projectId, actorId: "publisher", sourceDumpSha256, changes: plan.changes,
  });
  const applied = await applyOrganizationReviewPeriodRepair({
    client, projectId, actorId: "publisher", sourceDumpSha256, sourceSchema: "062_acceptance_relay",
    sourceMain: "607860c8a8a9fb5b8b784f49fda46ce4f2175249", changes: plan.changes, operationId, commandHash,
  });
  assert.equal(applied.operationId, operationId);
  assert.equal(applied.commandHash, commandHash);

  const after = await client.query(
    `SELECT * FROM document_revision WHERE project_id=$1 AND document_id = ANY($2::uuid[]) ORDER BY document_id, revision_number`,
    [projectId, documentIds]);
  assert.equal(after.rows.length, 3);
  for (const row of after.rows) {
    const before = beforeRows.get(`${row.document_id}/${row.revision_id}`);
    assert.ok(before, "the pre-repair row is still available");
    for (const field of ["body", "format", "content_hash", "author", "created_at", "previous_revision_id", "reason",
      "media_type", "original_name", "payload_ref", "entrypoint", "revision_number"]) {
      assert.deepEqual(row[field], before[field], `${field} must not change`);
    }
    assert.deepEqual(row.assets_manifest, before.assets_manifest);
    assert.deepEqual(row.organization_review, periods.get(`${row.document_id}/${row.revision_id}`));
  }
  assert.equal(await observationCount(), observationsBefore,
    "the disabled allocation-observation trigger records no synthetic repair change");
  const triggers = (await client.query(
    `SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='document_revision'::regclass
      AND tgname IN ('immutable_document_revision','document_revision_allocation_observation')`)).rows;
  assert.deepEqual(Object.fromEntries(triggers.map(row => [row.tgname, row.tgenabled])),
    { immutable_document_revision: "O", document_revision_allocation_observation: "O" });

  const journal = (await client.query(
    "SELECT * FROM operation_journal WHERE project_id=$1 AND operation_id=$2", [projectId, operationId])).rows[0];
  assert.equal(journal.command_type, "repair.organization_review_period");
  assert.equal(journal.actor_id, "publisher");
  assert.equal(journal.command_hash, commandHash);
  assert.equal(journal.result.status, "applied");
  assert.equal(journal.result.source.dumpSha256, sourceDumpSha256);
  assert.equal(journal.result.revisions.length, 3);
  assert.deepEqual(journal.result.revisions[0].after, firstPeriod);

  const readback = await readRepairReadback(client, { projectId, documentIds, operationId });
  assert.ok(readback.currentPeriods.every(item => item.organizationReview));
  assert.equal(readback.revisions.length, 3);
  assert.equal(readback.operation.commandHash, commandHash);
  const readPool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const listed = await new PostgresUnitOfWork(readPool)
    .read(projectId, reader => reader.listDocuments(50, undefined, "organization_review"))
    .finally(() => readPool.end());
  const listedById = new Map(listed.items.map(item => [item.id, item]));
  assert.deepEqual(listedById.get(firstDocumentId)?.organizationReview, firstPeriod,
    "the current revision listing used by review-cli reads the restored period");
  assert.deepEqual(listedById.get(secondDocumentId)?.organizationReview, secondPeriod);

  const again = await loadTargetRows(client, projectId, documentIds);
  const secondPlan = planOrganizationReviewRepair({
    projectId, documentIds, sourceRows: source, targetRows: again.rows, documents: again.documents,
  });
  assert.equal(secondPlan.status, "already-repaired");
  assert.equal(secondPlan.changes.length, 0);
  assert.equal(Number((await client.query(
    "SELECT count(*) AS n FROM operation_journal WHERE project_id=$1 AND command_type=$2",
    [projectId, "repair.organization_review_period"])).rows[0].n), 1,
  "a second pass does not invent another repair record");

  const dangling = after.rows.find(row => row.document_id === firstDocumentId && row.organization_review);
  assert.deepEqual(dangling.organization_review.previous,
    { documentId: missingReviewDocumentId, revisionId: missingReviewRevisionId },
    "a previous Document outside the selective migration stays as provenance");
});
