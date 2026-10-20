import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { WorkflowService } from "@evoloop/core";
import { buildServer } from "../../apps/coordinator/src/server.ts";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_integration_test(?:\?|$)/.test(database)) throw new Error("Use dedicated evoloop_integration_test database");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("real CLI and PostgreSQL share fixed inputs, observable changes, no replay after lost response, and Task lifecycle", async t => {
  const schema = `cli_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  const service = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha } });
  const directory = await mkdtemp(join(tmpdir(), "evoloop-cli-"));
  const projectId = randomUUID(), documentId = randomUUID(), taskId = randomUUID(), lostOperationId = randomUUID();
  const token = randomUUID() + randomUUID(), rotatedToken = randomUUID() + randomUUID(), readerToken = randomUUID() + randomUUID();
  const blobs = new LocalBlobStore(join(directory, "blobs"), async () => true,
    async ref => !!await uow.read(ref.projectId, reader => reader.getRegisteredBlob(ref.id)));
  const app = await buildServer({ service, credentials: [
    { token, actorId: "cli-test-agent", projectIds: [projectId], permissions: ["read", "write", "review"] },
    { token: rotatedToken, actorId: "cli-test-agent", projectIds: [projectId], permissions: ["read", "write", "review"] },
    { token: readerToken, actorId: "test-observer", projectIds: [projectId], permissions: ["read"] },
  ], documents: { uow, blobsForPrincipal: () => blobs },
  references: { uow, gitForPrincipal: () => ({ read: async () => ({ status: "unavailable", reason: "No Git source in this fixture" }) }) as never,
    knowledgeForPrincipal: () => ({}) as never } });
  let postCount = 0;
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "POST" && request.url === "/api/commands") {
      postCount++;
      if ((request.body as { operationId?: string }).operationId === lostOperationId) reply.raw.destroy();
    }
    return payload;
  });
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close(); await pool.end(); await rm(directory, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  async function cli(args: string[], credential = token, expected = 0) {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], {
        env: { ...process.env, EVOLOOP_API_URL: apiUrl, EVOLOOP_TOKEN: credential, EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: join(directory, "receipts") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
      child.once("error", reject); child.once("close", code => resolveResult({ code, stdout, stderr }));
    });
    assert.equal(result.code, expected, result.stderr);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    return result.stdout ? JSON.parse(result.stdout) : { diagnostic: result.stderr };
  }
  async function command(type: string, fields: Record<string, unknown>, expected = 0, operationId = randomUUID(), credential = token) {
    const file = join(directory, `${operationId}.json`);
    await writeFile(file, JSON.stringify({ type, operationId, projectId, ...fields }), { mode: 0o600 });
    return cli(["command", "run", file], credential, expected);
  }
  const task = () => cli(["task", taskId]);
  await command("project.create", { title: "Isolated CLI integration" });
  const source = "# Fixed acceptance\r\nRead this exact r1 text.\r\n";
  await command("document.create", { documentId, title: "Fixed input", body: source });
  let document = await cli(["document", documentId]);
  const r1 = document.current.id;
  await command("document.adopt", { documentId, revisionId: r1, expectedVersion: document.document.version, reason: "Use fixture r1" });
  await command("task.create", { taskId, title: "Read fixed input", content: "# Verify exact r1\nRead the fixed source.", acceptance: "Original r1 remains readable after source change",
    owner: "cli-test-agent", documentIds: [documentId] });
  await command("task.start", { taskId, expectedVersion: (await task()).task.version, basis: [{ documentId, revisionId: r1 }], reason: "Bounded fixed-input fixture" });
  const sealedRevision = (await task()).revision.id;
  let context = await cli(["context", taskId]);
  assert.equal(context.status, "complete"); assert.equal(context.documents.find((item: { revision: { documentId: string } }) => item.revision.documentId === documentId)?.body, source);
  document = await cli(["document", documentId]);
  await command("document.revise", { documentId, expectedVersion: document.document.version, body: "# New current input\nDo not silently replace r1.", reason: "Upstream changed" }, 3, lostOperationId);
  const sent = postCount;
  await cli(["command", "run", join(directory, `${lostOperationId}.json`)], token, 3);
  assert.equal(postCount, sent, "pending original is not sent again");
  await cli(["receipts", "reconcile", lostOperationId], readerToken, 1);
  assert.equal((await cli(["receipts", "reconcile", lostOperationId], rotatedToken)).state, "confirmed", "rotated credential for the same server-verified actor can reconcile");
  document = await cli(["document", documentId]);
  assert.notEqual(document.current.id, r1);
  await command("document.adopt", { documentId, revisionId: document.current.id, expectedVersion: document.document.version, reason: "Adopt r2 separately" });
  const affected = await task();
  const impact = affected.impacts.find((item: { state: string }) => item.state === "pending"); assert.ok(impact);
  const stale = await command("task.reviewBasis", { taskId, expectedVersion: 9999, impactId: impact.id, decision: "retain", reason: "Stale fixture" }, 1);
  assert.match(stale.diagnostic, /VERSION_CONFLICT/);
  await command("task.reviewBasis", { taskId, expectedVersion: affected.task.version, impactId: impact.id, decision: "retain", reason: "Acceptance explicitly verifies r1 history" });
  context = await cli(["context", taskId, "--revision", sealedRevision]);
  assert.equal(context.status, "complete"); assert.equal(context.documents.find((item: { revision: { documentId: string } }) => item.revision.documentId === documentId)?.revision.id, r1);
  assert.equal((await cli(["original", documentId, "--revision", r1])).body, source);
  const request = { command: { mode: "create", projectId, operationId: randomUUID(), documentId: randomUUID(), revisionId: randomUUID(),
    title: "HTML original", format: "html", mediaType: "text/html", originalName: "index.html", author: "cli-test-agent", reason: "Archive bytes",
    source: { storage: "blob", payloadRef: randomUUID(), contentHash: sha("<h1>Fixed</h1>\r\n"), size: Buffer.byteLength("<h1>Fixed</h1>\r\n"), entrypoint: "index.html", assets: [] } }, uploads: [] as unknown[] };
  request.uploads.push({ blobId: request.command.source.payloadRef, base64: Buffer.from("<h1>Fixed</h1>\r\n").toString("base64") });
  const importFile = join(directory, "import.json"); await writeFile(importFile, JSON.stringify(request), { mode: 0o600 });
  await cli(["request", "document.import", "--file", importFile]);
  const exportDir = join(directory, "exported");
  await cli(["original", request.command.documentId, "--revision", request.command.revisionId, "--out", exportDir]);
  assert.equal(sha(await readFile(join(exportDir, "index.html"))), request.command.source.contentHash);
  await command("delivery.record", { taskId, expectedVersion: (await task()).task.version, artifactRef: `document:${documentId}@${r1}`,
    artifactRevision: r1, contentHash: sha(source), technicalResult: "passed", technicalEvidence: "Deterministic test verified exact fixed bytes", reason: "Synthetic delivery fixture" });
  const delivery = (await task()).deliveries[0]; assert.ok(delivery);
  await command("observation.record", { taskId, deliveryId: delivery.id, observer: "cli-test-agent", observerKind: "agent", result: "used",
    evidence: "Synthetic integration, not human or independent Agent use", reason: "Exercise record boundary" });
  await command("task.close", { taskId, expectedVersion: (await task()).task.version, deliveryId: delivery.id, acceptanceResult: "met",
    acceptanceEvidence: "Synthetic fixed-original test passed", reason: "Fixture complete" });
  const view = await fetch(`${apiUrl}/api/projects/${projectId}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${readerToken}` } }).then(r => r.json());
  assert.equal(view.task.state, "done"); assert.equal(view.basis.members.find((item: { documentId: string }) => item.documentId === documentId).revisionId, r1);
  assert.equal(view.task.content, "# Verify exact r1\nRead the fixed source.");
  assert.equal(view.observations[0].observerKind, "agent");
  assert.ok((await cli(["task", taskId, "--history"])).some((entry: { revision: { state: string } }) => entry.revision.state === "in_progress"));
  await command("task.reopen", { taskId, expectedVersion: view.task.version, reason: "Reader cannot mutate" }, 1, randomUUID(), readerToken);
});
