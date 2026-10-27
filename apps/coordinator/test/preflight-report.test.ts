import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@evoloop/contracts/ports";
import { PreflightError, safePreflightReport } from "../src/runtime/preflight-report.js";

test("preflight receipt keeps actionable facts without leaking source exception text", () => {
  const report = safePreflightReport(new PreflightError("INPUT_LIMIT",
    { kind: "task", id: "task-fixed", revisionId: "rev-fixed" }, 1_900_000, 262_144));
  assert.equal(report.report.modelStarted, false);
  assert.equal(report.report.actualBytes, 1_900_000);
  assert.equal(report.report.limitBytes, 262_144);
  assert.match(report.summary, /^evoloop-preflight-v1:/);
  assert.equal(JSON.parse(report.summary.slice("evoloop-preflight-v1:".length)).code, "INPUT_LIMIT");
  const unavailable = safePreflightReport(new DomainError("BASIS_UNAVAILABLE", "secret=private"));
  assert.equal(unavailable.report.code, "FIXED_SOURCE_UNAVAILABLE");
  assert.doesNotMatch(unavailable.summary, /secret=private/);
});
