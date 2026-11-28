import assert from "node:assert/strict";
import test from "node:test";
import { assertReadOnlySql } from "./scheduling-metrics.mjs";
import {
  DEFAULT_THRESHOLDS, LEDGER_QUERIES, TEMPORARY, UNCLASSIFIED, buildLedger, dutyOf, flagsFor, periodFrom, renderMarkdown, roleDuty,
} from "./duty-ledger.mjs";

const PERIOD = { start: "2026-11-16T19:00:00.000Z", end: "2026-11-23T19:00:00.000Z",
  dates: ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"] };
const DEV_ROLE = "role-dev";
const REVIEW_ROLE = "role-review";

const session = (id, patch = {}) => ({ session_id: id, role_id: DEV_ROLE, state: "ready", created_at: "2026-11-09T00:00:00Z",
  updated_at: "2026-11-09T00:00:00Z", close_verified_at: null, role_title: "功能开发（Codex）", display_name: null, membership: "current", tenure: "resident", ...patch });
const run = (id, sessionId, start, end, task = `task-${id}`) => ({ run_id: id, task_id: task, session_id: sessionId, state: "completed", created_at: start, updated_at: end });

function fixture() {
  return {
    sessions: [
      session("dev-1", { display_name: "功能开发 · GPT 1" }),
      session("dev-2", { display_name: "功能开发 · GPT 2" }),
      session("qa-1", { display_name: "验收 · GPT 1" }),
      session("review-1", { role_id: REVIEW_ROLE, role_title: "方案审阅（GPT）", display_name: "方案审阅 · GPT" }),
      session("sample-1", { display_name: "模型强度样本", tenure: "temporary", state: "closed", updated_at: "2026-11-15T00:00:00Z" }),
      session("late-1", { display_name: "功能开发 · GPT 3", created_at: "2026-11-25T00:00:00Z" }),
    ],
    roles: [
      { role_id: DEV_ROLE, state: "trial", review_at_utc: "2026-11-23T00:00:00Z", title: "功能开发（Codex）", role_class: "business", reviewed: false },
      { role_id: REVIEW_ROLE, state: "trial", review_at_utc: "2026-12-09T00:00:00Z", title: "方案审阅（GPT）", role_class: "business", reviewed: false },
    ],
    runs: [
      run("r1", "dev-1", "2026-11-17T00:00:00Z", "2026-11-17T06:00:00Z"),
      run("r2", "dev-1", "2026-11-17T05:00:00Z", "2026-11-17T08:00:00Z"),
      run("r3", "dev-1", "2026-11-22T00:00:00Z", "2026-11-22T04:00:00Z"),
      run("r4", "qa-1", "2026-11-22T05:00:00Z", "2026-11-22T06:00:00Z"),
      run("r5", "review-1", "2026-11-18T00:00:00Z", "2026-11-18T01:00:00Z"),
      run("r6", "late-1", "2026-11-25T01:00:00Z", "2026-11-25T02:00:00Z"),
    ],
    deliveries: [
      { delivery_id: "d1", task_id: "task-r1", run_id: "r1", created_at: "2026-11-17T06:00:00Z" },
      { delivery_id: "d2", task_id: "task-r2", run_id: "r2", created_at: "2026-11-17T08:00:00Z" },
      { delivery_id: "d3", task_id: "task-r3", run_id: "r3", created_at: "2026-11-22T04:00:00Z" },
      { delivery_id: "d4", task_id: "task-r4", run_id: "r4", created_at: "2026-11-22T06:00:00Z" },
      { delivery_id: "d5", task_id: "task-x", run_id: null, created_at: "2026-11-20T00:00:00Z" },
      { delivery_id: "d6", task_id: "task-old", run_id: "r1", created_at: "2026-11-10T00:00:00Z" },
    ],
    observations: [
      { delivery_id: "d1", result: "used" },
      { delivery_id: "d2", result: "failed" },
      { delivery_id: "d4", result: "used" },
    ],
    usage: [
      { session_id: "dev-1", day: "2026-11-17", cost_usd: "12.50", cost_reported: true, cost_scope: "all_turns" },
      { session_id: "dev-1", day: "2026-11-22", cost_usd: "7.50", cost_reported: true, cost_scope: "all_turns" },
      { session_id: "dev-1", day: "2026-11-10", cost_usd: "99.00", cost_reported: true, cost_scope: "all_turns" },
      { session_id: "qa-1", day: "2026-11-22", cost_usd: "0", cost_reported: false, cost_scope: "all_turns" },
      { session_id: "review-1", day: "2026-11-18", cost_usd: "5.00", cost_reported: false, cost_scope: "runs_only" },
    ],
  };
}

const ledgerOf = (patch = {}) => buildLedger({ projectId: "project-1", period: PERIOD, data: fixture(), generatedAt: "2026-11-24T00:00:00.000Z", ...patch });
const row = (ledger, duty) => ledger.duties.find(item => item.duty === duty);

test("a session's duty follows its display name, then its role title without the runtime suffix", () => {
  assert.equal(dutyOf({ display_name: "验收 · GPT 1", role_title: "功能开发（Codex）" }), "验收");
  assert.equal(dutyOf({ display_name: null, role_title: "功能开发（Codex）" }), "功能开发");
  assert.equal(dutyOf({ display_name: "模型样本", role_title: "功能开发", tenure: "temporary" }), TEMPORARY);
  assert.equal(dutyOf({ display_name: "", role_title: "" }), UNCLASSIFIED);
  assert.equal(roleDuty({ title: "CI/CD 优化 (GPT)" }), "CI/CD 优化");
  assert.equal(dutyOf({ session_id: "s", role_id: "r", display_name: "验收 · GPT 1" }, { roles: { r: "质量" } }), "质量");
  assert.equal(dutyOf({ session_id: "s", role_id: "r", display_name: "验收 · GPT 1" }, { roles: { r: "质量" }, sessions: { s: "验收" } }), "验收");
});

test("acceptance sessions under the development role are counted as their own duty", () => {
  const ledger = ledgerOf();
  // the closed temporary session did nothing in the period, so its duty has no row
  assert.deepEqual(ledger.duties.map(item => item.duty).sort(), ["功能开发", "方案审阅", "验收"].sort());
  assert.equal(row(ledger, "功能开发").sessions.ready, 2);
  assert.equal(row(ledger, "验收").sessions.ready, 1);
  assert.equal(row(ledger, "验收").runs, 1);
});

test("runs, tasks and overlapping run time are counted once per session inside the period", () => {
  const dev = row(ledgerOf(), "功能开发");
  assert.equal(dev.runs, 3);
  assert.equal(dev.tasks, 3);
  assert.equal(dev.runHours, 12);
  assert.equal(dev.sessions.active, 1);
  // two ready sessions existed for the whole 7 days: 12 h of 336 h
  assert.equal(dev.busyShare, 0.036);
});

test("deliveries are judged by their observations, and the reject rate only counts observed ones", () => {
  const ledger = ledgerOf();
  const dev = row(ledger, "功能开发");
  assert.deepEqual([dev.deliveries, dev.observed, dev.accepted, dev.rejected, dev.pending], [3, 2, 1, 1, 1]);
  assert.equal(dev.rejectRate, 0.5);
  assert.equal(ledger.totals.unattributedDeliveries, 1);
  assert.equal(ledger.totals.deliveries, 4);
});

test("cost is the recorded lower bound for the period, and says which sessions are partial or unreported", () => {
  const ledger = ledgerOf();
  const dev = row(ledger, "功能开发");
  assert.equal(dev.cost.usd, 20);
  assert.equal(dev.costPerAccepted, 20);
  const qa = row(ledger, "验收");
  assert.equal(qa.cost.usd, null);
  assert.deepEqual(qa.cost.unreportedSessions, ["验收 · GPT 1"]);
  assert.equal(qa.costPerAccepted, null);
  const review = row(ledger, "方案审阅");
  assert.equal(review.cost.usd, 5);
  assert.deepEqual(review.cost.partialSessions, ["方案审阅 · GPT"]);
  assert.equal(review.costPerAccepted, null);
  assert.equal(ledger.totals.costUsd, 25);
});

test("flags name idle sessions, sessions that never ran and trial roles past their review date", () => {
  const ledger = ledgerOf();
  const codes = duty => row(ledger, duty).flags.map(flag => flag.code);
  assert.deepEqual(codes("功能开发"), ["TRIAL_OVERDUE", "NEVER_RAN"]);
  assert.deepEqual(row(ledger, "功能开发").sessions.neverRan.map(item => item.name), ["功能开发 · GPT 2"]);
  assert.deepEqual(codes("验收"), ["TRIAL_OVERDUE"]);
  assert.deepEqual(codes("方案审阅"), ["IDLE"]);
  assert.equal(row(ledger, "方案审阅").sessions.idle[0].idleDays, 5);
  assert.equal(row(ledger, "方案审阅").roles[0].overdue, false);
  assert.equal(ledger.totals.rolesOverdue, 1);
});

test("a reviewed role is no longer overdue, and sessions created after the period are left out", () => {
  const data = fixture();
  data.roles[0].reviewed = true;
  const ledger = buildLedger({ projectId: "project-1", period: PERIOD, data });
  assert.equal(ledger.totals.rolesOverdue, 0);
  assert.equal(row(ledger, "功能开发").sessions.ready, 2);
  assert.equal(ledger.totals.runs, 5);
});

test("the rework flag needs enough observed deliveries before it fires", () => {
  const base = { roles: [], sessions: { neverRan: [], idle: [] } };
  assert.deepEqual(flagsFor({ ...base, observed: 4, rejected: 4, rejectRate: 1 }), []);
  assert.deepEqual(flagsFor({ ...base, observed: 10, rejected: 3, rejectRate: 0.3 }).map(flag => flag.code), ["REWORK"]);
  assert.deepEqual(flagsFor({ ...base, observed: 10, rejected: 3, rejectRate: 0.3 }, { ...DEFAULT_THRESHOLDS, reworkRate: 0.5 }), []);
});

test("an explicit duty map overrides the naming convention", () => {
  const ledger = ledgerOf({ map: { sessions: { "qa-1": "功能开发" } } });
  assert.equal(row(ledger, "验收"), undefined);
  assert.equal(row(ledger, "功能开发").sessions.ready, 3);
});

test("the markdown ledger has one row per duty, the flags and the definitions", () => {
  const markdown = renderMarkdown(ledgerOf());
  assert.match(markdown, /^# 分工账（2026-11-17 至 2026-11-23）/);
  assert.match(markdown, /\| 功能开发 \| 2 \| 1 \| 3 \| 3 \| 3 \| 1 \| 1 \| 50% \| 4% \| 1 天 \| 20\.00 \| 20\.00 \|/);
  assert.match(markdown, /\*\*方案审阅\*\*：连续 3 天以上没有 Run/);
  assert.match(markdown, /\*\*方案审阅\*\*：只记了一部分：方案审阅 · GPT。/);
  assert.match(markdown, /\*\*验收\*\*：运行时没有报费用：验收 · GPT 1。/);
  assert.match(markdown, /另有 1 份交付没有对应的 Run/);
});

test("periods are whole Asia/Tashkent days, by count or by explicit range", () => {
  const byCount = periodFrom({ now: new Date("2026-11-24T03:00:00Z"), days: 7 });
  assert.deepEqual(byCount, PERIOD);
  const byRange = periodFrom({ start: "2026-11-17", end: "2026-11-23" });
  assert.deepEqual(byRange, PERIOD);
  assert.throws(() => periodFrom({ start: "2026-11-23", end: "2026-11-17" }), { code: "INVALID_RANGE" });
});

test("run totals from the database decide idle time and never-ran, even when the runs lie before the period", () => {
  const data = fixture();
  data.runs = data.runs.filter(item => item.session_id !== "review-1");
  data.runTotals = [
    { session_id: "dev-1", total_runs: 3, last_run_at: "2026-11-22T04:00:00Z" },
    { session_id: "dev-2", total_runs: 4, last_run_at: "2026-11-12T00:00:00Z" },
    { session_id: "qa-1", total_runs: 1, last_run_at: "2026-11-22T06:00:00Z" },
    { session_id: "review-1", total_runs: 0, last_run_at: null },
  ];
  const ledger = buildLedger({ projectId: "project-1", period: PERIOD, data });
  const dev = row(ledger, "功能开发");
  assert.deepEqual(dev.sessions.neverRan, []);
  assert.deepEqual(dev.sessions.idle.map(item => [item.name, item.idleDays]), [["功能开发 · GPT 2", 11]]);
  assert.deepEqual(row(ledger, "方案审阅").sessions.neverRan.map(item => item.name), ["方案审阅 · GPT"]);
});

test("a delivery is attributed through its own session when its run lies before the period", () => {
  const data = fixture();
  data.deliveries.push({ delivery_id: "d7", run_id: "r-old", session_id: "qa-1", created_at: "2026-11-21T00:00:00Z" });
  data.observations.push({ delivery_id: "d7", result: "notUsed" });
  const qa = row(buildLedger({ projectId: "project-1", period: PERIOD, data }), "验收");
  assert.deepEqual([qa.deliveries, qa.accepted, qa.rejected], [2, 1, 1]);
});

test("every ledger query passes the read-only guard and reads only the period where it can", () => {
  for (const { sql } of Object.values(LEDGER_QUERIES)) assert.doesNotThrow(() => assertReadOnlySql(sql));
  for (const key of ["runs", "deliveries", "observations"]) assert.equal(LEDGER_QUERIES[key].params, "range");
  assert.equal(LEDGER_QUERIES.runTotals.params, "until");
  assert.equal(LEDGER_QUERIES.usage.params, "days");
});
