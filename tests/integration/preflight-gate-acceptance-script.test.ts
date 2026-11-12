// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The acceptance script is the controlled path an acceptor runs on a one-off database; CI keeps it working.
test("scripts/ops/preflight-gate-acceptance.ts passes on a one-off database and reports both scenarios", () => {
  const database = process.env.TEST_DATABASE_URL;
  assert.ok(database, "TEST_DATABASE_URL is set by the integration runner");
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/ops/preflight-gate-acceptance.ts"], { encoding: "utf8", env: process.env, timeout: 120_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(run.stdout) as { result: string; scenarios: Record<string, Record<string, unknown>>; receipts: Array<{ type?: string }> };
  assert.equal(report.result, "passed");
  const a = report.scenarios.A_preflight_failure!, b = report.scenarios.B_real_failure!;
  assert.equal((a.afterFailure as { gate: { phase: string } }).gate.phase, "open");
  assert.equal(a.resumeIssued, false);
  assert.equal((b.blocked as { gate: { phase: string } }).gate.phase, "blocked");
  assert.equal(report.receipts.filter(receipt => receipt.type === "runtime.session.recovery.resume").length, 1, "only scenario B resumes, and explicitly");
});
