import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerCredentialBroker } from "../src/workers/credentials.ts";
import { workerBootstrap } from "../src/workers/bootstrap.ts";
import type { WorkerScope } from "../src/workers/types.ts";

const scope = (): WorkerScope => ({ projectId: randomUUID(), loopId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
  sessionId: randomUUID(), roleId: "builder", kind: "business", allowedRoleIds: ["builder"] });

test("private worker credential survives restart, expires and revokes without entering bootstrap", async () => {
  const base = await mkdtemp(join(tmpdir(), "evoloop-worker-test-"));
  let now = Date.now();
  const options = { workerRoot: join(base, "workers"), apiUrl: "http://127.0.0.1:12345", cliMain: "/private/cli.js",
    nodeExecutable: process.execPath, ttlMs: 5000, now: () => now };
  try {
    const broker = new WorkerCredentialBroker(options), workerScope = scope();
    const issued = await broker.issue(workerScope);
    const token = await readFile(join(base, "workers", workerScope.runId, "credential"), "utf8");
    const wrapper = await readFile(issued.wrapperPath, "utf8");
    const prompt = workerBootstrap({ issued, scope: workerScope, skillPaths: ["/private/skills/worker/SKILL.md"],
      fixedContext: "Task revision fixed", taskInstruction: "Return evidence", waitUntilUtc: new Date(now + 5000).toISOString() });
    assert.equal(wrapper.includes(token), false);
    assert.equal(prompt.includes(token), false);
    assert.equal(JSON.stringify(issued).includes(token), false);
    assert.equal((await stat(join(base, "workers", workerScope.runId))).mode & 0o777, 0o700);
    assert.equal((await stat(join(base, "workers", workerScope.runId, "credential"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(base, "workers", workerScope.runId, "metadata.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await new WorkerCredentialBroker(options).authenticate(`Bearer ${token}`))?.scope, workerScope);
    await assert.rejects(broker.issue(workerScope));
    await broker.revoke(workerScope.runId);
    assert.equal(await new WorkerCredentialBroker(options).authenticate(`Bearer ${token}`), null);
    const next = scope(); await broker.issue(next);
    const nextToken = await readFile(join(base, "workers", next.runId, "credential"), "utf8");
    now += 5001;
    assert.equal(await new WorkerCredentialBroker(options).authenticate(`Bearer ${nextToken}`), null);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("wrapper passes scoped private environment to existing CLI without credential in argv or output", async () => {
  const base = await mkdtemp(join(tmpdir(), "evoloop-worker-cli-"));
  try {
    const cliMain = join(base, "cli.mjs");
    await writeFile(cliMain, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),project:process.env.EVOLOOP_PROJECT,url:process.env.EVOLOOP_API_URL,hasToken:!!process.env.EVOLOOP_TOKEN,state:process.env.EVOLOOP_STATE_DIR}))");
    const workerScope = scope();
    const broker = new WorkerCredentialBroker({ workerRoot: join(base, "workers"), apiUrl: "http://127.0.0.1:12345",
      cliMain, nodeExecutable: process.execPath, ttlMs: 5000 });
    const issued = await broker.issue(workerScope);
    const token = await readFile(join(base, "workers", workerScope.runId, "credential"), "utf8");
    const result = spawnSync(process.execPath, [issued.wrapperPath, "session"], { encoding: "utf8",
      env: { ...process.env, EVOLOOP_TOKEN: "untrusted-parent-token", EVOLOOP_PROJECT: uFake() } });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, ["session"]);
    assert.equal(output.project, workerScope.projectId);
    assert.equal(output.url, "http://127.0.0.1:12345");
    assert.equal(output.hasToken, true);
    assert.equal(output.state, join(base, "workers", workerScope.runId, "receipts"));
    assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false);
    await broker.revoke(workerScope.runId);
    const revoked = spawnSync(process.execPath, [issued.wrapperPath, "session"], { encoding: "utf8" });
    assert.equal(revoked.status, 1);
    assert.equal(revoked.stdout.includes(token) || revoked.stderr.includes(token), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

function uFake(): string { return randomUUID(); }
