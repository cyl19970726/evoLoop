// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
// Task b5993311: the `merged` completion boundary against a real PostgreSQL project database and real git repositories (no network): a Task whose Delivery names a PR
// closes only once that PR is merged into the repository's main line; a closer's claim counts for nothing; `delivered` and older Tasks close as before.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";
import { gitMergeFacts } from "../../apps/coordinator/src/completion/merge-facts.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/evoloop.*test/.test(new URL(url).pathname)) throw new Error("dedicated evoloop test DB required");
const schema = `el_completion_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID();
const dir = mkdtempSync(join(tmpdir(), "evoloop-completion-"));
const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const commit = (name: string) => { writeFileSync(join(dir, name), name); git("add", name); git("commit", "-q", "-m", `add ${name}`); return git("rev-parse", "HEAD"); };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const owner: Principal = { actorId: "owner", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
const consumer: Principal = { actorId: "consumer", projectIds: [projectId], permissions: ["task", "document", "session"] };
const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha },
  mergeFacts: gitMergeFacts(() => [{ projectId, root: dir }]), requireCompletionBoundary: true });
const run = (who: Principal, data: Record<string, unknown>): Promise<CommandResult> => service.execute(who, { ...data, projectId, operationId: randomUUID() } as Command);
const yes = (r: CommandResult) => { assert.equal(r.status, "applied", JSON.stringify(r)); return r as Extract<CommandResult, { status: "applied" }>; };
const refused = (r: CommandResult, code: string) => { assert.equal(r.status, "rejected", JSON.stringify(r)); return r.status === "rejected" ? (assert.equal(r.code, code), r.message) : ""; };

test("a `merged` Task closes only after its PR is merged into the repository's main line", async t => {
  await migrate(url, schema);
  t.after(async () => { await pool.end(); const c = new pg.Client({ connectionString: url }); await c.connect(); try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); } rmSync(dir, { recursive: true, force: true }); });
  git("init", "-q", "-b", "main"); commit("base");
  git("checkout", "-q", "-b", "feature"); const headSha = commit("feature");
  git("checkout", "-q", "main");
  const roleId = fixtureRoleId("owner"); yes(await run(owner, { type: "project.create", title: "Completion boundary" })); await seedFixtureRole(pool, projectId, roleId);

  // A new delivery Task must declare a boundary.
  const base = { type: "task.create", title: "Ship it", content: "Deliver", acceptance: "Used and merged", owner: roleId, consumer: "consumer", useRequired: true };
  const missing = refused(await run(owner, { ...base, taskId: randomUUID() }), "COMPLETION_BOUNDARY_REQUIRED");
  assert.match(missing, /completionBoundary/);

  const taskId = randomUUID();
  yes(await run(owner, { ...base, taskId, completionBoundary: "merged" }));
  yes(await run(owner, { type: "task.start", taskId, expectedVersion: 1, reason: "Start" }));
  const prUrl = "https://github.com/owner/repo/pull/12";
  const delivered = yes(await run(owner, { type: "delivery.record", taskId, expectedVersion: 2, artifactRef: prUrl, artifactRevision: headSha, contentHash: "c".repeat(64),
    technicalResult: "passed", technicalEvidence: "CI green", reason: "Delivered" }));
  const deliveryId = delivered.revisionId!;
  yes(await run(consumer, { type: "observation.record", taskId, deliveryId, observer: "consumer", observerKind: "agent", result: "used", evidence: "Used it", reason: "Checked" }));
  const close = (extra: Record<string, unknown> = {}) => run(owner, { type: "task.close", taskId, expectedVersion: delivered.version, deliveryId, acceptanceResult: "met", acceptanceEvidence: "Independent review passed", reason: "Close", ...extra });

  // Not merged: refused, readable; the readback says not met.
  const message = refused(await close(), "MERGE_NOT_VERIFIED");
  assert.match(message, /PR #12/); assert.match(message, new RegExp(headSha.slice(0, 8))); assert.match(message, /not merged into the main line/);
  const before = (await service.getTask(owner, projectId, taskId)).completion;
  assert.deepEqual([before?.boundary, before?.met, before?.pullRequest], ["merged", false, 12]);
  // The closer's claim counts for nothing.
  refused(await close({ acceptanceEvidence: "PR #12 已合并进主干", reason: "已合并" }), "MERGE_NOT_VERIFIED");
  // The same PR merged (a merge commit made by the host): the same close is accepted.
  git("merge", "--no-ff", "-q", "-m", "Merge pull request #12 from owner/feature", "feature");
  assert.equal((await service.getTask(owner, projectId, taskId)).completion?.met, true);
  yes(await close());
  assert.equal((await service.getTask(owner, projectId, taskId)).task.state, "done");

  // A squash-merged PR (head not in main, the PR number in the subject) counts as merged only when the squash commit carries exactly the head's change.
  const facts = gitMergeFacts(() => [{ projectId, root: dir }]);
  git("checkout", "-q", "-b", "squash-src", "main"); const squashHead = commit("squash-src"); git("checkout", "-q", "main");
  git("merge", "--squash", "-q", "squash-src"); git("commit", "-q", "-m", "Add squashed work (#33)");
  const squashed = await facts({ projectId, pullRequest: 33, head: squashHead });
  assert.equal(squashed.state, "merged"); assert.match(squashed.detail, /改动一致/);
  // Counter-examples (acceptance-2): the PR number on main never decides on its own; the fact is about THIS head.
  // C1 — the PR was merged with an older head; the Delivery names a reworked head that never landed.
  git("checkout", "-q", "-b", "rework", "feature"); const reworkHead = commit("rework"); git("checkout", "-q", "main");
  const c1 = await facts({ projectId, pullRequest: 12, head: reworkHead });
  assert.equal(c1.state, "not_merged", "a reworked head is not merged because PR #12 has a merge commit");
  // C2 — a head that is in the repository but not on main, under a PR number that does have a merge commit.
  git("checkout", "-q", "-b", "other", "main"); const otherHead = commit("other"); git("checkout", "-q", "main");
  const c2 = await facts({ projectId, pullRequest: 33, head: otherHead });
  assert.equal(c2.state, "not_merged", "an unmerged head is not merged under a squashed PR number");
  assert.match(c2.detail, /不等于这个头合并了/);
  // C3 — a head the repository has never seen, under a PR number that has a squash commit: nothing can be matched to it.
  const c3 = await facts({ projectId, pullRequest: 33, head: "0".repeat(39) + "a" });
  assert.equal(c3.state, "unreadable"); assert.match(c3.detail, /不能替代头提交/);
  assert.equal((await facts({ projectId, pullRequest: 12, head: "e".repeat(40) })).state, "unreadable");
  // A project with no registered repository cannot be read at all.
  assert.equal((await gitMergeFacts(() => [])({ projectId, pullRequest: 12, head: headSha })).state, "unreadable");

  // `delivered` closes on the Delivery alone, with no repository read.
  const plain = randomUUID();
  yes(await run(owner, { ...base, taskId: plain, completionBoundary: "delivered" }));
  yes(await run(owner, { type: "task.start", taskId: plain, expectedVersion: 1, reason: "Start" }));
  const plainDelivery = yes(await run(owner, { type: "delivery.record", taskId: plain, expectedVersion: 2, artifactRef: "repo://x", artifactRevision: "r1", contentHash: "d".repeat(64), technicalResult: "passed", technicalEvidence: "ok", reason: "d" }));
  yes(await run(consumer, { type: "observation.record", taskId: plain, deliveryId: plainDelivery.revisionId, observer: "consumer", observerKind: "agent", result: "used", evidence: "ok", reason: "c" }));
  yes(await run(owner, { type: "task.close", taskId: plain, expectedVersion: plainDelivery.version, deliveryId: plainDelivery.revisionId, acceptanceResult: "met", acceptanceEvidence: "ok", reason: "Close" }));
  assert.equal((await service.getTask(owner, projectId, plain)).completion?.boundary, "delivered");
});
