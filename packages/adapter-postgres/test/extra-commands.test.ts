// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { ExtraCommand, Permission, Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for adapter tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1)).toLowerCase();
if (!databaseName.includes("evoloop") || !databaseName.includes("test")) throw new Error("adapter tests require a dedicated evoLoop test database");
const schema = `el_extra_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() },
  ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
const projectId = randomUUID(), otherProject = randomUUID();
const who = (permissions: Permission[], extraCommands?: ExtraCommand[], projects = [projectId]): Principal =>
  ({ actorId: "docs-arch", projectIds: projects, permissions, ...(extraCommands ? { extraCommands } : {}) });
const reviewer = who(["read", "write", "review"]);

before(async () => {
  await migrate(connectionString, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Extra commands',now()),($2,'Other',now())", [projectId, otherProject]);
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function sampleDocument(project = projectId) {
  const documentId = randomUUID();
  const created = await workflow.execute(who(["read", "write", "review"], undefined, [project]), { type: "document.create", projectId: project, operationId: randomUUID(), documentId, title: "Sample", body: "# s", kind: "spec" });
  assert.equal(created.status, "applied");
  return documentId;
}
const archive = (p: Principal, documentId: string, expectedVersion: number, project = projectId, type: "document.archive" | "document.restore" = "document.archive") =>
  workflow.execute(p, { type, projectId: project, operationId: randomUUID(), documentId, expectedVersion, reason: "daily maintenance" });

test("an identity with write and the archive/restore extra commands can archive and restore, and nothing else needing review", async () => {
  const documentId = await sampleDocument();
  const maintainer = who(["read", "write"], ["document.archive", "document.restore"]);
  const archived = await archive(maintainer, documentId, 1);
  assert.equal(archived.status, "applied", JSON.stringify(archived));
  const restored = await archive(maintainer, documentId, 2, projectId, "document.restore");
  assert.equal(restored.status, "applied", JSON.stringify(restored));
  await assert.rejects(workflow.execute(maintainer, { type: "task.start", projectId, operationId: randomUUID(), taskId: randomUUID(), expectedVersion: 1, reason: "x" } as never), /Permission review is required/);
  await assert.rejects(workflow.execute(maintainer, { type: "task.close", projectId, operationId: randomUUID(), taskId: randomUUID(), expectedVersion: 1, acceptanceResult: "met", acceptanceEvidence: "e", reason: "x" } as never), /Permission review is required/);
  await assert.rejects(workflow.execute(maintainer, { type: "document.publish", projectId, operationId: randomUUID(), documentId, expectedVersion: 3, revisionId: randomUUID(), reason: "x" } as never), /Permission review is required/);
});

test("each extra command grants only itself, and only with write in the project", async () => {
  const documentId = await sampleDocument();
  assert.equal((await archive(who(["read", "write"], ["document.restore"]), documentId, 1).catch(e => e)).code, "FORBIDDEN", "restore does not allow archive");
  assert.equal((await archive(who(["read", "write"]), documentId, 1).catch(e => e)).code, "FORBIDDEN", "without the list, review is still required");
  assert.equal((await archive(who(["read"], ["document.archive"]), documentId, 1).catch(e => e)).code, "FORBIDDEN", "the list does not replace write");
  const other = await sampleDocument(otherProject);
  assert.equal((await archive(who(["read", "write"], ["document.archive"]), other, 1, otherProject).catch(e => e)).code, "FORBIDDEN", "nor reach a project the identity does not belong to");
  assert.equal((await archive(who(["read", "write"], ["document.archive"]), documentId, 1)).status, "applied");
  assert.equal((await archive(who(["read", "write"], ["document.archive"]), documentId, 2, projectId, "document.restore").catch(e => e)).code, "FORBIDDEN", "an archiver cannot restore");
  assert.equal((await archive(reviewer, documentId, 2, projectId, "document.restore")).status, "applied", "a reviewer is unchanged");
});
