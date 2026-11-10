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
// The clock advances one second per command unless a test pins it; ids can be queued to force their sort order.
let tick = Date.parse("2026-11-10T00:00:00.000Z");
let pinnedNow: string | null = null;
const queuedIds: string[] = [];
const workflow = new WorkflowService({ uow, clock: { now: () => pinnedNow ?? new Date(tick += 1000).toISOString() },
  ids: { next: () => queuedIds.shift() ?? randomUUID() }, hasher: { hash: sha } });
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
const revise = async (projectId: string, documentId: string, expectedVersion: number, body: string) =>
  (await run(projectId, { type: "document.revise", documentId, expectedVersion, body, reason: body })).revisionId!;
/** Create a document through the ordinary commands: r1 → r2 (published) → r3 → r4 (current draft). */
async function documentWithHistory(projectId: string) {
  const documentId = randomUUID();
  const r1 = (await run(projectId, { type: "document.create", documentId, title: "Spec", body: "# v1", kind: "spec" })).revisionId!;
  const r2 = await revise(projectId, documentId, 1, "# v2");
  await run(projectId, { type: "document.publish", documentId, expectedVersion: 2, revisionId: r2, reason: "publish v2" });
  const r3 = await revise(projectId, documentId, 3, "# v3");
  const r4 = await revise(projectId, documentId, 4, "# v4");
  return { documentId, revisions: [r1, r2, r3, r4], version: 5 };
}
const list = (projectId: string, documentId: string, limit?: number, cursor?: string, who = principal([projectId])) =>
  workflow.listDocumentRevisions(who, projectId, documentId, limit, cursor);
async function readAll(projectId: string, documentId: string, limit: number, between?: (page: number) => Promise<void>) {
  const pages: DocumentRevisionPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(projectId, documentId, limit, cursor);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
    if (cursor && between) await between(pages.length);
  } while (cursor);
  return pages;
}
const ids = (pages: DocumentRevisionPage[]) => pages.flatMap(page => page.items.map(item => item.id));
const numbers = (pages: DocumentRevisionPage[]) => pages.flatMap(page => page.items.map(item => item.revisionNumber));

test("revisions list newest first with stored numbers, head state and metadata but no body", async () => {
  const projectId = await project();
  const { documentId, revisions: [r1, r2, r3, r4], version } = await documentWithHistory(projectId);
  const page = await list(projectId, documentId);
  assert.deepEqual(page.items.map(item => item.id), [r4, r3, r2, r1]);
  assert.deepEqual(page.items.map(item => item.revisionNumber), [4, 3, 2, 1]);
  assert.deepEqual(page.items.map(item => item.state), ["current", "historical", "published", "historical"]);
  assert.deepEqual(page.items.map(item => [item.current, item.published]), [[true, false], [false, false], [false, true], [false, false]]);
  assert.deepEqual(page.document, { id: documentId, title: "Spec", kind: "spec", version, currentRevisionId: r4,
    adoptedRevisionId: r2, status: "published" });
  assert.equal(page.revisionCount, 4);
  assert.equal(page.nextCursor, null);
  for (const item of page.items) assert.equal("body" in item, false, "history never carries the document body");

  const fixed = await workflow.getDocumentRevision(principal([projectId]), projectId, documentId, r3);
  const { body, ...metadata } = fixed as DocumentRevision;
  assert.equal(body, "# v3");
  assert.equal(fixed.revisionNumber, 3, "a single fixed read carries its number for a deep link");
  const { state: _state, current: _current, published: _published, ...listed } = page.items[1]!;
  assert.deepEqual(listed, metadata, "every metadata field of the single-revision read is listed unchanged");
  const detail = await workflow.getDocument(principal([projectId]), projectId, documentId);
  assert.equal(detail.current.revisionNumber, 4, "the current revision's number is the total (\"of M\")");
  assert.equal(detail.adopted?.revisionNumber, 2);
  assert.deepEqual(page.items.map(item => item.contentHash), ["# v4", "# v3", "# v2", "# v1"].map(sha));
  assert.deepEqual(page.items.map(item => item.previousRevisionId), [r3, r2, r1, null]);
  assert.ok(page.items.every(item => item.author === actor && item.format === "markdown" && item.mediaType === "text/markdown"));

  await run(projectId, { type: "document.publish", documentId, expectedVersion: version, revisionId: r4, reason: "publish v4" });
  const republished = await list(projectId, documentId);
  assert.deepEqual(republished.items.map(item => [item.state, item.published]),
    [["current", true], ["historical", false], ["historical", false], ["historical", false]],
    "a current revision that is also published stays current with published=true");
  await run(projectId, { type: "document.archive", documentId, expectedVersion: version + 1, reason: "done" });
  const archived = await list(projectId, documentId);
  assert.equal(archived.document.status, "archived");
  assert.equal(archived.items[0]!.published, true, "published follows the adopted pointer; the head status says it is archived");
});

test("cursor pages cover the history once and cannot move to another document or project", async () => {
  const projectId = await project();
  const { documentId, revisions } = await documentWithHistory(projectId);
  const pages = await readAll(projectId, documentId, 3);
  assert.equal(pages.length, 2);
  assert.deepEqual(ids(pages), [...revisions].reverse());
  assert.deepEqual(numbers(pages), [4, 3, 2, 1]);
  assert.ok(pages.every(page => page.revisionCount === 4));
  const cursor = pages[0]!.nextCursor!;
  assert.equal(revisions.includes(cursor), false, "the cursor is not a bare revision ID");

  const sibling = await documentWithHistory(projectId);
  await assert.rejects(list(projectId, sibling.documentId, 3, cursor), { code: "INVALID_CURSOR" });
  const otherProject = await project();
  const foreign = await documentWithHistory(otherProject);
  const both = principal([projectId, otherProject]);
  await assert.rejects(workflow.listDocumentRevisions(both, otherProject, foreign.documentId, 3, cursor), { code: "INVALID_CURSOR" });
  const forged = (value: Record<string, unknown>) => Buffer.from(JSON.stringify({ v: 1, projectId, documentId, before: 2, ...value })).toString("base64url");
  await assert.rejects(list(projectId, documentId, 3, forged({ documentId: sibling.documentId })), { code: "INVALID_CURSOR" });
  await assert.rejects(list(projectId, documentId, 3, forged({ projectId: otherProject })), { code: "INVALID_CURSOR" });
  for (const before of [0, -1, 1.5, "2", null, 2147483648, Number.MAX_SAFE_INTEGER])
    await assert.rejects(list(projectId, documentId, 3, forged({ before })), { code: "INVALID_CURSOR" }, String(before));
  await assert.rejects(list(projectId, documentId, 3, "not-a-cursor"), { code: "INVALID_CURSOR" });
  assert.equal((await list(projectId, documentId, 3, forged({ before: 2147483647 }))).items.length, 3,
    "the largest stored number is still a valid position");
  assert.deepEqual((await list(projectId, documentId, 3, forged({ before: 2 }))).items.map(item => item.id), [revisions[0]],
    "a well-formed cursor for this document can only reach this document's own revisions");
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

test("two revisions in the same millisecond keep save order whatever their IDs", async () => {
  const projectId = await project();
  const documentId = randomUUID();
  const high = "ffffffff-0000-4000-8000-000000000001", low = "00000000-0000-4000-8000-000000000002";
  pinnedNow = "2026-11-10T05:00:00.000Z";
  try {
    queuedIds.push(high);
    const first = (await run(projectId, { type: "document.create", documentId, title: "Same ms", body: "# 1", kind: "spec" })).revisionId!;
    queuedIds.push(low);
    const second = await revise(projectId, documentId, 1, "# 2");
    assert.deepEqual([first, second], [high, low]);
    const page = await list(projectId, documentId);
    assert.deepEqual(page.items.map(item => [item.id, item.revisionNumber, item.state]), [[low, 2, "current"], [high, 1, "historical"]]);
    assert.equal(page.items[0]!.createdAt, page.items[1]!.createdAt);
    assert.deepEqual(ids(await readAll(projectId, documentId, 1)), [low, high]);
  } finally { pinnedNow = null; queuedIds.length = 0; }
});

test("a clock stepped back neither reorders the current revision nor renumbers what was read", async () => {
  const projectId = await project();
  const documentId = randomUUID();
  const revisions = [(await run(projectId, { type: "document.create", documentId, title: "Clock", body: "# 1", kind: "spec" })).revisionId!];
  for (let version = 1; version <= 3; version++) revisions.push(await revise(projectId, documentId, version, `# ${version + 1}`));
  const first = await list(projectId, documentId, 2);
  pinnedNow = "2026-11-10T00:00:01.500Z"; // earlier than every revision but the first
  let newest: string;
  try { newest = await revise(projectId, documentId, 4, "# 5"); } finally { pinnedNow = null; }
  const rest = await list(projectId, documentId, 2, first.nextCursor!);
  assert.deepEqual(first.items.map(item => item.revisionNumber), [4, 3]);
  assert.deepEqual(rest.items.map(item => [item.id, item.revisionNumber]), [[revisions[1], 2], [revisions[0], 1]],
    "the second page continues below the first, unaffected by the new revision");
  const fresh = await list(projectId, documentId);
  assert.deepEqual(fresh.items.map(item => item.id), [newest, ...[...revisions].reverse()]);
  assert.deepEqual(fresh.items.map(item => item.revisionNumber), [5, 4, 3, 2, 1]);
  assert.equal(fresh.items[0]!.state, "current");
  assert.ok(fresh.items[0]!.createdAt < fresh.items[3]!.createdAt, "the newest revision really carries an earlier timestamp");
});

test("revisions added while paging land above the cursor: no repeats, no gaps, stable numbers", async () => {
  const projectId = await project();
  const { documentId, revisions, version } = await documentWithHistory(projectId);
  let expectedVersion = version;
  const added: string[] = [];
  const pages = await readAll(projectId, documentId, 1, async () => {
    added.push(await revise(projectId, documentId, expectedVersion++, `# added ${added.length}`));
  });
  assert.deepEqual(ids(pages), [...revisions].reverse(), "the walk that started at revision 4 ends at 1 without repeats");
  assert.deepEqual(numbers(pages), [4, 3, 2, 1]);
  assert.deepEqual(pages.map(page => page.revisionCount), [4, 5, 6, 7], "each page reports the count at its own read");
  assert.ok(pages.slice(1).every(page => page.document.version !== pages[0]!.document.version),
    "a changed document.version tells the reader to recompute state and offer the first page again");
  const fresh = await list(projectId, documentId);
  assert.deepEqual(fresh.items.map(item => item.revisionNumber), [7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(fresh.items.slice(0, 3).map(item => item.id), [...added].reverse());
});

test("storage numbers direct SQL inserts, refuses a supplied number and keeps the number immutable", async () => {
  const projectId = await project();
  const { documentId } = await documentWithHistory(projectId);
  const client = await pool.connect();
  const columns = "project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason,media_type,original_name,assets_manifest";
  const values = "$1,$2,$3,'# direct','markdown',$4,'direct','2020-01-01T00:00:00Z',$5,'direct','text/markdown','x.md','[]'::jsonb";
  try {
    const head = (await client.query("SELECT current_revision_id FROM process_document WHERE project_id=$1 AND document_id=$2",
      [projectId, documentId])).rows[0].current_revision_id;
    // A row-by-row import must not silently lose the source host's numbering, so a supplied number is refused.
    for (const number of [99, 5])
      await assert.rejects(client.query(`INSERT INTO document_revision(${columns},revision_number) VALUES(${values},$6)`,
        [projectId, documentId, randomUUID(), sha("# direct"), head, number]), { code: "23514", message: /assigned by storage/ }, String(number));
    const direct = randomUUID();
    await client.query("BEGIN");
    // Same shape as the scheduling and task-timing writers.
    await client.query(`INSERT INTO document_revision(${columns}) VALUES(${values})`, [projectId, documentId, direct, sha("# direct"), head]);
    await client.query("UPDATE process_document SET version=version+1,current_revision_id=$3 WHERE project_id=$1 AND document_id=$2",
      [projectId, documentId, direct]);
    await client.query("COMMIT");
    assert.equal((await client.query("SELECT revision_number FROM document_revision WHERE project_id=$1 AND revision_id=$2",
      [projectId, direct])).rows[0].revision_number, 5);
    await assert.rejects(client.query("UPDATE document_revision SET revision_number=1 WHERE project_id=$1 AND revision_id=$2",
      [projectId, direct]), { message: /immutable/ });
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
  const page = await list(projectId, documentId);
  assert.deepEqual(page.items.map(item => item.revisionNumber), [5, 4, 3, 2, 1]);
  assert.equal(page.items[0]!.state, "current");
  const original = await uow.read(projectId, reader => reader.getDocumentPayloadRevision(documentId, page.items[1]!.id));
  assert.equal(original?.revisionNumber, 4, "the fixed revision returned with /original carries the same number");
});

test("concurrent appends to one document outside the project lock serialize on the document row", async () => {
  const projectId = await project();
  const { documentId } = await documentWithHistory(projectId);
  const [a, b] = [await pool.connect(), await pool.connect()];
  try {
    await a.query("BEGIN"); await b.query("BEGIN");
    const insert = (client: pg.PoolClient) => client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# c','markdown',$4,'c',now(),NULL,'c')`,
    [projectId, documentId, randomUUID(), sha("# c")]);
    await insert(a);
    const waiting = insert(b); // blocks on the document row until a commits
    await new Promise(resolve => setTimeout(resolve, 100));
    await a.query("COMMIT");
    await waiting;
    await b.query("COMMIT");
  } finally { a.release(); b.release(); }
  const page = await list(projectId, documentId);
  assert.deepEqual(page.items.map(item => item.revisionNumber), [6, 5, 4, 3, 2, 1]);
});

test("the page query reads the revision-number index backward instead of sorting", async () => {
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
  const history = seen.filter(query => /FROM document_revision/.test(query.text) && /revision_number/.test(query.text));
  assert.equal(history.length, 4, "one page query and one count per page");
  const client = await pool.connect();
  try {
    await client.query("ANALYZE document_revision");
    for (const query of history) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL enable_seqscan = off");
        const plan = JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values)).rows[0]);
        assert.match(plan, /document_revision_number_unique/, plan);
        assert.doesNotMatch(plan, /"Node Type":"Sort"/, plan);
      } finally { await client.query("ROLLBACK"); }
    }
  } finally { client.release(); }
});
