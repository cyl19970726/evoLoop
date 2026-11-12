import assert from "node:assert/strict";
import test from "node:test";
import type { ContextBudgetConfig, Principal, UsageBucketRow, UsageBudgetConfig, UsageContextRow } from "@evoloop/contracts";
import { contextHandoffSummary, contextPressure } from "../src/context-budget.ts";
import { UsageService, usageBudget, usageDay } from "../src/usage.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const principal: Principal = { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] };
const contextConfig: ContextBudgetConfig = { enabled: true, maxInputTokens: 150_000, warningRatio: 0.8, pauseOrdinaryTurns: true };

test("usageDay uses the configured local calendar day, not the UTC date", () => {
  assert.equal(usageDay("2026-11-10T16:30:00.000Z", "Asia/Shanghai"), "2026-11-11");
  assert.equal(usageDay("2026-11-10T16:30:00.000Z", "UTC"), "2026-11-10");
});

test("contextPressure keeps unknown separate from zero and asks for a handoff at the ceiling", () => {
  const unconfigured = contextPressure(null, null);
  assert.equal(unconfigured.state, "unconfigured");
  assert.equal(unconfigured.inputTokens, null);

  const unknown = contextPressure(contextConfig, { inputTokens: null, modelContextWindow: null, observedAt: null });
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.reason ?? "", /没有报告/);

  const ok = contextPressure(contextConfig, { inputTokens: 60_000, modelContextWindow: 256_000, observedAt: "2026-11-10T00:00:00.000Z" });
  assert.equal(ok.state, "ok");
  assert.equal(ok.ratio, 0.4);

  const warning = contextPressure(contextConfig, { inputTokens: 120_000, modelContextWindow: 256_000, observedAt: "2026-11-10T00:00:00.000Z" });
  assert.equal(warning.state, "warning");

  const required = contextPressure(contextConfig, { inputTokens: 150_000, modelContextWindow: 256_000, observedAt: "2026-11-10T00:00:00.000Z" });
  assert.equal(required.state, "handoff_required");
  assert.match(required.reason ?? "", /业务 Task Run 不受影响/);
});

test("contextHandoffSummary cites fixed identifiers and the successor responsibility only", () => {
  const pressure = contextPressure(contextConfig, { inputTokens: 186_000, modelContextWindow: 256_000,
    observedAt: "2026-11-10T00:00:00.000Z" });
  const summary = contextHandoffSummary({ roleId: "role-1", sessionId: "session-1", nativeThreadId: "thread-1",
    pressure, generatedAt: "2026-11-10T01:00:00.000Z",
    nextResponsibility: "读取固定 Task 9ec056a3 与待处理结果通知，再决定下一步。" });
  assert.match(summary, /session-1/);
  assert.match(summary, /thread-1/);
  assert.match(summary, /9ec056a3/);
  assert.match(summary, /186000 \/ 150000/);
  assert.match(summary, /不会因交接而视为已读/);
  assert.equal(summary.includes("secret native text"), false);
});

test("usageBudget distinguishes warning, exhaustion and incomplete cost reporting", () => {
  const config: UsageBudgetConfig = { enabled: true, maxInputTokens: 100_000, warningRatio: 0.8,
    pauseOrdinaryTurns: true, timeZone: "UTC" };
  const day = (inputTokens: number, costUsd: number | null, costReported: boolean) =>
    ({ day: "2026-11-10", inputTokens, outputTokens: 0, cachedInputTokens: 0, costUsd, costReported });
  assert.equal(usageBudget(config, day(79_999, 0, true)).state, "ok");
  assert.equal(usageBudget(config, day(80_000, 0, true)).state, "warning");
  assert.equal(usageBudget(config, day(100_000, 0, true)).state, "exhausted");
  const unknownCost = usageBudget({ ...config, maxInputTokens: undefined, maxCostUsd: 5 },
    day(100, 0, false));
  assert.equal(unknownCost.state, "unknown");
  assert.equal(unknownCost.used, null);
});

test("UsageService aggregates Session-day buckets and exposes context pressure without inventing cost", async () => {
  const rows: UsageBucketRow[] = [
    { sessionId: "session-a", roleId: "role", nativeThreadId: "thread", day: "2026-11-10",
      inputTokens: 120_000, outputTokens: 2_000, cachedInputTokens: 100_000, costUsd: 0, costReported: false },
    { sessionId: "session-a", roleId: "role", nativeThreadId: "thread", day: "2026-11-11",
      inputTokens: 40_000, outputTokens: 1_000, cachedInputTokens: 30_000, costUsd: 0, costReported: false },
    { sessionId: "session-b", roleId: "role", nativeThreadId: null, day: "2026-11-11",
      inputTokens: 10_000, outputTokens: 500, cachedInputTokens: 0, costUsd: 0.25, costReported: true },
  ];
  const contexts: UsageContextRow[] = [{ sessionId: "session-a", roleId: "role", nativeThreadId: "thread",
    contextInputTokens: 160_000, observedAt: "2026-11-11T00:00:00.000Z" }];
  const added: unknown[] = [];
  const uow = {
    read: async (_project: string, action: (reader: unknown) => Promise<unknown>) => action({
      usage: { listUsage: async () => rows, listUsageContext: async () => contexts } }),
    transaction: async (_project: string, action: (tx: unknown) => Promise<unknown>) => action({
      usage: { addUsage: async (...args: unknown[]) => { added.push(args); } } }),
  };
  const service = new UsageService({ uow: uow as never, clock: { now: () => "2026-11-11T02:00:00.000Z" } });
  const overview = await service.overview(principal, projectId, "2026-11-10", "2026-11-11", "UTC",
    { enabled: true, maxInputTokens: 150_000, warningRatio: 0.8, pauseOrdinaryTurns: true, timeZone: "UTC" },
    contextConfig);
  assert.equal(overview.sessions.length, 2);
  const a = overview.sessions.find(item => item.sessionId === "session-a")!;
  assert.equal(a.recorded, true);
  assert.equal(a.total.inputTokens, 160_000);
  assert.equal(a.today.inputTokens, 40_000);
  assert.equal(a.today.costReported, false);
  assert.equal(a.today.costUsd, null, "an unreported cost is never displayed as $0");
  assert.equal(a.context.state, "handoff_required");
  assert.equal(overview.sessions.find(item => item.sessionId === "session-b")!.context.state, "unknown");
  assert.equal(overview.daily.find(day => day.day === "2026-11-11")!.inputTokens, 50_000);
  assert.equal(overview.budget.state, "ok");
  await service.record(projectId, "session-a", "2026-11-11", { inputTokens: 50, outputTokens: 5,
    cachedInputTokens: 0, costUsd: null });
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], [projectId, "session-a", "2026-11-11",
    { inputTokens: 50, outputTokens: 5, cachedInputTokens: 0, costUsd: 0, costReported: false }]);
});

// The budget alert is "today" in the project's time zone. UsageService already counts it there; what a reader must do is ask for a window that
// contains that day, which is not always the UTC day. Both directions of the offset are covered, at the moments the two calendars disagree.
test("the budget's today is the project's calendar day: a window of only the UTC day misses it when the time zone is ahead or behind UTC", async () => {
  const budget: UsageBudgetConfig = { enabled: true, maxInputTokens: 100_000, warningRatio: 0.8, pauseOrdinaryTurns: true, timeZone: "UTC" };
  const read = (day: string) => async (_project: string, action: (reader: unknown) => Promise<unknown>) => action({
    usage: { listUsage: async (_p: string, from: string, to: string) => (day >= from && day <= to
      ? [{ sessionId: "s", roleId: "r", nativeThreadId: null, day, inputTokens: 120_000, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, costReported: false }] : []),
    listUsageContext: async () => [] } });
  const overview = (now: string, timeZone: string, day: string, from: string, to: string) =>
    new UsageService({ uow: { read: read(day) } as never, clock: { now: () => now } })
      .overview(principal, projectId, from, to, timeZone, { ...budget, timeZone });
  // Ahead of UTC (+5): UTC is still 2026-11-12 at 20:00, the project is already on 2026-11-13.
  assert.equal((await overview("2026-11-12T20:00:00.000Z", "Asia/Tashkent", "2026-11-13", "2026-11-12", "2026-11-12")).budget.state, "ok", "the UTC day alone does not contain the project's today");
  assert.equal((await overview("2026-11-12T20:00:00.000Z", "Asia/Tashkent", "2026-11-13", "2026-11-11", "2026-11-13")).budget.state, "exhausted", "a window around the UTC day does");
  // Behind UTC (-5, no daylight saving in November here): UTC is already 2026-11-13 at 02:00, the project is still on 2026-11-12.
  assert.equal((await overview("2026-11-13T02:00:00.000Z", "America/Bogota", "2026-11-12", "2026-11-13", "2026-11-13")).budget.state, "ok");
  assert.equal((await overview("2026-11-13T02:00:00.000Z", "America/Bogota", "2026-11-12", "2026-11-12", "2026-11-14")).budget.state, "exhausted");
});
