import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { DocumentRevision, DocumentRevisionPage, Permission, Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for adapter tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1)).toLowerCase();
if (!databaseName.includes("evoloop") || !databaseName.includes("test")) {
  throw new Error("adapter tests require a dedicated database whose name contains evoloop and test");
}
const schema = `el_docrev_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let tick = Date.parse("2026-11-10T00:00:00.000Z");
const workflow = new WorkflowService({ uow, clock: { now: () => new Date(tick += 1000).toISOString() },
  ids: { next: randomUUID }, hasher: { hash: sha } });
const actor = "document-history-test";
const all: Permission[] = ["read", "write", "review"];
const principal = (projectIds: string[], permissions: Permission[] = all): Principal => ({ actorId: actor, projectIds, permissions });

before(async () => { await migrate(connectionString, schema); });
after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

async function project(): Promise<string> {
  const id = randomUUID();
  await uow.transaction(id, tx => tx.insertProject({ id, title: "Document history", createdAt: new Date(tick).toISOString() }));
  return id;
}
async function run(projectId: string, command: Record<string, unknown>) {
  const result = await workflow.execute(principal([projectId]), { projectId, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result.status === "applied" ? result : assert.fail("unreachable");
}
/** Create a document through the ordinary commands: r1 → r2 (published) → r3 → r4 (current draft). */
async function documentWithHistory(projectId: string) {
  const documentId = randomUUID();
  const r1 = (await run(projectId, { type: "document.create", documentId, title: "Spec", body: "# v1", kind: "spec" })).revisionId!;
  const r2 = (await run(projectId, { type: "document.revise", documentId, expectedVersion: 1, body: "# v2", reason: "second" })).revisionId!;
  await run(projectId, { type: "document.publish", documentId, expectedVersion: 2, revisionId: r2, reason: "publish v2" });
  const r3 = (await run(projectId, { type: "document.revise", documentId, expectedVersion: 3, body: "# v3", reason: "third" })).revisionId!;
  const r4 = (await run(projectId, { type: "document.revise", documentId, expectedVersion: 4, body: "# v4", reason: "fourth" })).revisionId!;
  return { documentId, revisions: [r1, r2, r3, r4], version: 5 };
}
const list = (projectId: string, documentId: string, limit?: number, cursor?: string, who = principal([projectId])) =>
  workflow.listDocumentRevisions(who, projectId, documentId, limit, cursor);
async function readAll(projectId: string, documentId: string, limit: number) {
  const pages: DocumentRevisionPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(projectId, documentId, limit, cursor);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

test("revisions list newest first with numbers, head state and metadata but no body", async () => {
  const projectId = await project();
  const { documentId, revisions: [r1, r2, r3, r4], version } = await documentWithHistory(projectId);
  const page = await list(projectId, documentId);
  assert.deepEqual(page.items.map(item => item.id), [r4, r3, r2, r1]);
  assert.deepEqual(page.items.map(item => item.revisionNumber), [4, 3, 2, 1]);
  assert.deepEqual(page.items.map(item => item.state), ["current", "historical", "published", "historical"]);
  assert.deepEqual(page.items.map(item => [item.current, item.published]), [[true, false], [false, false], [false, true], [false, false]]);
  assert.deepEqual(page.document, { id: documentId, version, currentRevisionId: r4, adoptedRevisionId: r2, status: "published" });
  assert.equal(page.revisionCount, 4);
  assert.equal(page.nextCursor, null);
  for (const item of page.items) assert.equal("body" in item, false, "history never carries the document body");
  const fixed = await workflow.getDocumentRevision(principal([projectId]), projectId, documentId, r3);
  const { body, ...metadata } = fixed as DocumentRevision;
  assert.equal(body, "# v3");
  const listed = page.items[1]!;
  assert.deepEqual({ ...listed, revisionNumber: undefined, state: undefined, current: undefined, published: undefined },
    { ...metadata, revisionNumber: undefined, state: undefined, current: undefined, published: undefined },
    "every metadata field of the single-revision read is listed unchanged");
  assert.deepEqual(page.items.map(item => item.reason), ["fourth", "third", "second", "Initial draft"]);
  assert.deepEqual(page.items.map(item => item.contentHash), ["# v4", "# v3", "# v2", "# v1"].map(sha));
  assert.deepEqual(page.items.map(item => item.previousRevisionId), [r3, r2, r1, null]);
  assert.ok(page.items.every((item, index, items) => index === 0 || items[index - 1]!.createdAt > item.createdAt));
  assert.ok(page.items.every(item => item.author === actor && item.format === "markdown" && item.mediaType === "text/markdown"));

  await run(projectId, { type: "document.publish", documentId, expectedVersion: version, revisionId: r4, reason: "publish v4" });
  const republished = await list(projectId, documentId);
  assert.deepEqual(republished.items.map(item => [item.state, item.published]),
    [["current", true], ["historical", false], ["historical", false], ["historical", false]],
    "a current revision that is also published stays current with published=true");
});

test("cursor pages cover the history once and cannot move to another document or project", async () => {
  const projectId = await project();
  const { documentId, revisions } = await documentWithHistory(projectId);
  const pages = await readAll(projectId, documentId, 3);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), [...revisions].reverse());
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.revisionNumber)), [4, 3, 2, 1]);
  assert.ok(pages.every(page => page.revisionCount === 4));
  const cursor = pages[0]!.nextCursor!;
  assert.equal(revisions.includes(cursor), false, "the cursor is not a bare revision ID");

  const sibling = await documentWithHistory(projectId);
  await assert.rejects(list(projectId, sibling.documentId, 3, cursor), { code: "INVALID_CURSOR" });
  const otherProject = await project();
  const foreign = await documentWithHistory(otherProject);
  const both = principal([projectId, otherProject]);
  await assert.rejects(workflow.listDocumentRevisions(both, otherProject, foreign.documentId, 3, cursor), { code: "INVALID_CURSOR" });
  const forged = (revisionId: string) => Buffer.from(JSON.stringify({ v: 1, projectId, documentId, revisionId })).toString("base64url");
  await assert.rejects(list(projectId, documentId, 3, forged(sibling.revisions[1]!)), { code: "INVALID_CURSOR" },
    "a cursor naming a revision of another document is refused");
  await assert.rejects(list(projectId, documentId, 3, forged(foreign.revisions[1]!)), { code: "INVALID_CURSOR" });
  await assert.rejects(list(projectId, documentId, 3, forged(randomUUID())), { code: "INVALID_CURSOR" });
  await assert.rejects(list(projectId, documentId, 3, "not-a-cursor"), { code: "INVALID_CURSOR" });
  await assert.rejects(list(projectId, documentId, 0), { code: "INVALID_PAGE" });
  await assert.rejects(list(projectId, documentId, 101), { code: "INVALID_PAGE" });
  assert.equal((await list(projectId, documentId, 100)).items.length, 4);
});

test("missing and foreign documents are not found; projects without read access are forbidden", async () => {
  const projectId = await project();
  const otherProject = await project();
  const foreign = await documentWithHistory(otherProject);
  await assert.rejects(list(projectId, randomUUID()), { code: "NOT_FOUND" });
  await assert.rejects(workflow.listDocumentRevisions(principal([projectId, otherProject]), projectId, foreign.documentId),
    { code: "NOT_FOUND" }, "a document of another project is not found through this project");
  await assert.rejects(workflow.listDocumentRevisions(principal([projectId]), otherProject, foreign.documentId), { code: "FORBIDDEN" });
  await assert.rejects(workflow.listDocumentRevisions(principal([otherProject], ["write"]), otherProject, foreign.documentId), { code: "FORBIDDEN" });
});

test("equal and sub-millisecond creation times keep one stable order across pages", async () => {
  const projectId = await project();
  const documentId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  // a and b differ only in microseconds; c and d share a timestamp and are ordered by revision ID.
  const times = ["2026-11-10T01:00:00.000001Z", "2026-11-10T01:00:00.000002Z", "2026-11-10T01:00:01.000Z", "2026-11-10T01:00:01.000Z"];
  await uow.transaction(projectId, async tx => {
    await tx.insertDocument({ projectId, id: documentId, title: "Ties", version: 4, currentRevisionId: ids[3]!, adoptedRevisionId: null, kind: "spec", status: "draft" });
    for (const [index, id] of ids.entries()) await tx.insertDocumentRevision({ projectId, documentId, id, body: `# ${index}`,
      format: "markdown", mediaType: "text/markdown", originalName: `${documentId}.md`, payloadRef: null, entrypoint: null,
      assetsManifest: [], contentHash: sha(`# ${index}`), author: actor, createdAt: times[index]!,
      previousRevisionId: index ? ids[index - 1]! : null, reason: `r${index}` });
  });
  const [a, b, c, d] = ids as [string, string, string, string];
  const tied = [c, d].sort().reverse();
  const expected = [...tied, b, a];
  const pages = await readAll(projectId, documentId, 1);
  assert.deepEqual(pages.map(page => page.items[0]!.id), expected);
  assert.deepEqual(pages.map(page => page.items[0]!.revisionNumber), [4, 3, 2, 1]);
  assert.equal(pages.at(-1)!.nextCursor, null);
});

test("the page query reads document_revision_history_idx in order instead of sorting", async () => {
  const projectId = await project();
  const { documentId } = await documentWithHistory(projectId);
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const spy = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, key) {
      if (key === "query") return (text: string, values?: unknown[]) => { if (values) seen.push({ text, values }); return target.query(text, values); };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as unknown as pg.Pool;
  const spied = new WorkflowService({ uow: new PostgresUnitOfWork(spy), clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash: sha } });
  const first = await spied.listDocumentRevisions(principal([projectId]), projectId, documentId, 2);
  await spied.listDocumentRevisions(principal([projectId]), projectId, documentId, 2, first.nextCursor!);
  const pageQueries = seen.filter(query => /ORDER BY r\.created_at DESC,r\.revision_id DESC/.test(query.text));
  assert.equal(pageQueries.length, 2, "one first page and one cursor page");
  const client = await pool.connect();
  try {
    await client.query("ANALYZE document_revision");
    for (const query of pageQueries) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL enable_seqscan = off");
        const plan = JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values)).rows[0]);
        assert.match(plan, /document_revision_history_idx/, plan);
        assert.doesNotMatch(plan, /"Node Type":"Sort"/, plan);
      } finally { await client.query("ROLLBACK"); }
    }
  } finally { client.release(); }
});
