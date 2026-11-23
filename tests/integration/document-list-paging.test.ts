// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
// Task 69eefefa: the cursor the document list issues is accepted by the same list over HTTP, with and without a filter.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { buildServer } from "../../apps/coordinator/src/server.js";
import type { Document, Principal } from "@evoloop/contracts";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("Document list paging tests need an isolated evoloop_*_test database");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("every page the server issues a cursor for can be read: default list and a kind filter, no gaps or repeats", async t => {
  const schema = `el_docpage_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: database }); await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });
  const projectId = randomUUID(), principal: Principal = { actorId: "pager", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
  await workflow.execute(principal, { type: "project.create", projectId, operationId: randomUUID(), title: "Paging" });
  const briefs = new Set<string>(), all = new Set<string>();
  for (let index = 0; index < 63; index += 1) {
    const documentId = randomUUID(), kind = index % 3 === 0 ? "brief" : "spec";
    const created = await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId, title: `文档 ${index}`, kind, body: `# ${index}` });
    assert.equal(created.status, "applied");
    all.add(documentId); if (kind === "brief") briefs.add(documentId);
  }
  const token = randomUUID();
  const app = await buildServer({ service: workflow, credentials: [{ token, actorId: principal.actorId, projectIds: [projectId], permissions: [] }] });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const readAll = async (filter: string, limit: number) => {
    const seen: string[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const url = `/api/projects/${projectId}/documents?limit=${limit}${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await app.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      const page = response.json() as { items: Document[]; nextCursor: string | null };
      seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor; pages += 1;
      assert.ok(pages < 20, "the cursor chain ends");
    } while (cursor);
    return { seen, pages };
  };
  const everything = await readAll("", 25);
  assert.ok(everything.pages >= 3);
  assert.deepEqual([...everything.seen].sort(), [...all].sort(), "every document is read once");
  const onlyBriefs = await readAll("&kind=brief", 8);
  assert.deepEqual([...onlyBriefs.seen].sort(), [...briefs].sort(), "a filtered list pages through the same way");
});
