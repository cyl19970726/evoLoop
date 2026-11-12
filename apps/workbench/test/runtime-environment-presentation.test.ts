// 运行环境 and 上下文与用量 in the agent's right column (docs/frontend/pages/sessions.md 右栏): one main line that says where each
// value comes from, a tag only while a target is not yet in effect, a context bar against the hand-off threshold, today in
// small figures, and the project budget only as a reminder. A missing value is said, never shown as 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextPressure, UsageBudget } from "@evoloop/contracts";
import { adjustBlocked, runtimeEnvironment } from "../src/features/sessions/environmentPresentation.ts";
import { budgetReminder, contextGauge, projectBudgetGauge, projectToday, recentProjectDays, todayTiles } from "../src/features/sessions/usagePresentation.ts";
import type { RecoveryRead } from "../src/features/sessions/recoveryPresentation.ts";

const revision = { revisionId: "r2", version: 2, model: "gpt-6-astra", reasoningEffort: "max", sandbox: "danger-full-access", approvalPolicy: "never" };
const ready = (activationState: string, extra: Record<string, unknown> = {}): RecoveryRead => ({ status: "ready", view: { executionProfile: {
  revision, activationState, activeRevisionId: activationState === "active" ? "r2" : "r1", activeModel: "gpt-6-sol", activeReasoningEffort: "high", ...extra } } } as never);
const owned = { kind: "owned" as const, provider: "codex" as const, configuredModel: null };

test("the main line shows an actual model as actual and the effort as configured; all-target lines are said once", () => {
  const actual = runtimeEnvironment({ ...owned, recovery: ready("active"), actualModel: "gpt-6-astra" });
  assert.deepEqual([actual.runtime, actual.model, actual.effort, actual.change, actual.permission],
    ["Codex", { text: "gpt-6-astra", source: "actual" }, { text: "max", source: "target" }, null, "权限：完整权限"]);
  const target = runtimeEnvironment({ ...owned, recovery: ready("active"), actualModel: null, modelLabelOf: model => `Astra · ${model}` });
  assert.deepEqual([target.model, target.effort, target.note], [{ text: "Astra · gpt-6-astra", source: "target" }, { text: "max", source: "target" }, null]);
  assert.equal(runtimeEnvironment({ ...owned, provider: "claude", recovery: ready("active"), actualModel: null }).runtime, "Claude");
});

test("while a new target waits, the line keeps what is in effect and the tag says what comes next", () => {
  const pending = runtimeEnvironment({ ...owned, recovery: ready("pending"), actualModel: "gpt-6-sol" });
  assert.deepEqual([pending.model, pending.effort], [{ text: "gpt-6-sol", source: "actual" }, { text: "high", source: "confirmed" }],
    "never the old actual model beside the new target's effort");
  assert.deepEqual(pending.change, { tone: "waiting", label: "下一轮改为 gpt-6-astra / max" });
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: ready("pending"), actualModel: null }).model, { text: "gpt-6-sol", source: "confirmed" });
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: ready("attempting"), actualModel: null }).change, { tone: "progress", label: "正在改为 gpt-6-astra / max" });
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: ready("unknown"), actualModel: null }).change, { tone: "unknown", label: "激活结果未知，需核对" });
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: ready("rejected"), actualModel: null }).change, { tone: "blocked", label: "改为 gpt-6-astra / max 被拒绝" });
  // Recorded active, but the active revision is another one: the record needs checking.
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: ready("active", { activeRevisionId: "r1" }), actualModel: null }).change, { tone: "waiting", label: "激活记录待核对" });
});

test("a configuration that is read, unreadable or missing is said on the main line, never left blank", () => {
  assert.equal(runtimeEnvironment({ ...owned, recovery: { status: "loading" }, actualModel: null }).note, "正在读取运行配置…");
  assert.equal(runtimeEnvironment({ ...owned, recovery: { status: "failed", message: "x" }, actualModel: null }).note, "运行配置暂不可读取");
  assert.equal(runtimeEnvironment({ ...owned, recovery: { status: "ready", view: { executionProfile: null } } as never, actualModel: null }).note, "未登记执行配置");
  // A model the snapshot recorded stays the target when the profile could not be read.
  assert.deepEqual(runtimeEnvironment({ ...owned, configuredModel: "gpt-6-sol", recovery: { status: "failed", message: "x" }, actualModel: null }).model, { text: "gpt-6-sol", source: "target" });
  const external = runtimeEnvironment({ kind: "external", provider: null, recovery: { status: "loading" }, configuredModel: null, actualModel: null });
  assert.deepEqual([external.runtime, external.model, external.note], ["外部接入", null, null], "外部接入不提供 is said in the open 配置记录");
  assert.deepEqual(runtimeEnvironment({ kind: "external", provider: null, recovery: { status: "loading" }, configuredModel: "o5", actualModel: null }).model, { text: "o5", source: "target" });
});

const pressure = (overrides: Partial<ContextPressure>): ContextPressure => ({ configured: true, state: "ok", inputTokens: 96_000, limit: 200_000,
  ratio: 0.48, warningRatio: 0.8, pauseOrdinaryTurns: true, observedAt: "2026-11-12T00:00:00Z", reason: null, ...overrides });

test("上下文 is a bar against the hand-off threshold with a state; without a threshold it is the size alone", () => {
  assert.deepEqual(contextGauge(pressure({})), { ratio: 0.48, tone: "done", status: "正常", detail: "9.6 万 / 20 万（48%）", handoff: false });
  assert.deepEqual(contextGauge(pressure({ state: "warning", inputTokens: 172_000, ratio: 0.86 })),
    { ratio: 0.86, tone: "waiting", status: "接近交接", detail: "17.2 万 / 20 万（86%）", handoff: false });
  const handoff = contextGauge(pressure({ state: "handoff_required", inputTokens: 212_000, ratio: 1.06 }));
  assert.deepEqual([handoff.ratio, handoff.tone, handoff.status, handoff.detail, handoff.handoff], [1, "blocked", "需交接新线程", "21.2 万 / 20 万（106%）", true],
    "the bar is full; the figure keeps the real percentage");
  assert.deepEqual(contextGauge(pressure({ configured: false, state: "unconfigured", limit: null, ratio: null, inputTokens: 31_000 })),
    { ratio: null, tone: "idle", status: "未设阈值", detail: "当前上下文 3.1 万 · 未设交接阈值", handoff: false });
  assert.equal(contextGauge(pressure({ state: "unknown", inputTokens: null })).status, "无法判断");
  assert.deepEqual(contextGauge(null), { ratio: null, tone: "unknown", status: "没有记录", detail: "这个智能体还没有上下文记录", handoff: false });
});

test("today is four small figures in 万; nothing recorded is said, not 0; a missing cost is 未报告", () => {
  const day = { day: "2026-11-12", inputTokens: 182_400, outputTokens: 9_200, cachedInputTokens: 91_200, costUsd: null, costReported: false };
  assert.deepEqual(todayTiles({ recorded: true, today: day }),
    [{ label: "输入", value: "18.2 万" }, { label: "输出", value: "9200" }, { label: "缓存输入", value: "9.1 万" }, { label: "费用", value: "未报告" }]);
  assert.equal(todayTiles({ recorded: true, today: { ...day, costUsd: 0.0123, costReported: true } })![3]!.value, "$0.0123");
  assert.equal(todayTiles({ recorded: false, today: day }), null);
  assert.equal(todayTiles(null), null);
});

test("the project's daily limit is one reminder line only when it is close or reached", () => {
  const budget = (state: UsageBudget["state"], ratio: number | null, configured = true): UsageBudget => ({ configured, state, limitKind: "input_tokens",
    limit: 1_000_000, used: null, ratio, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null });
  assert.equal(budgetReminder(budget("ok", 0.3)), null);
  assert.equal(budgetReminder(budget("unconfigured", null, false)), null);
  assert.deepEqual(budgetReminder(budget("warning", 0.86)), { tone: "waiting", text: "项目今日用量接近每日上限（86%）" });
  assert.deepEqual(budgetReminder(budget("exhausted", 1.02)), { tone: "blocked", text: "项目今日用量已达每日上限（102%），普通结果通知已暂停" });
});

test("why the model cannot be adjusted is one short reason, with where to fix it when there is such a place", () => {
  const ok = { permitted: true, pendingOperation: false, runtimeReady: true, fullAccess: true, catalog: "available" as const, viewMismatch: false };
  assert.equal(adjustBlocked(ok), null);
  assert.deepEqual(adjustBlocked({ ...ok, fullAccess: false }), { text: "不是完整权限", link: { label: "去分工与运行", place: "runtime" } });
  assert.deepEqual(adjustBlocked({ ...ok, pendingOperation: true }), { text: "有结果未确认的操作", link: { label: "去核对", place: "operations" } });
  assert.deepEqual(adjustBlocked({ ...ok, permitted: false, fullAccess: false }), { text: "需要写入与复核权限", link: null }, "the first reason that applies");
  assert.deepEqual(adjustBlocked({ ...ok, runtimeReady: false }), { text: "智能体还没有就绪", link: null });
  assert.deepEqual(adjustBlocked({ ...ok, catalog: "unavailable" }), { text: "模型目录读不到", link: null });
  assert.deepEqual(adjustBlocked({ ...ok, catalog: "empty" }), { text: "模型目录为空", link: null });
  assert.deepEqual(adjustBlocked({ ...ok, viewMismatch: true }), { text: "两次读取的修订不一致，请重新读取", link: null });
  // Facts not read yet are not reasons.
  assert.equal(adjustBlocked({ ...ok, runtimeReady: null, fullAccess: null, catalog: null }), null);
  for (const reason of [{ ...ok, fullAccess: false }, { ...ok, pendingOperation: true }, { ...ok, viewMismatch: true }])
    assert.ok(adjustBlocked(reason)!.text.length <= 18, "short enough for one line");
});

test("项目用量 on 统筹安排: today against the daily limit with the same states, and seven days newest first in 万", () => {
  const budget = (overrides: Partial<UsageBudget>): UsageBudget => ({ configured: true, state: "ok", limitKind: "input_tokens", limit: 1_500_000, used: 523_000,
    ratio: 523_000 / 1_500_000, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null, ...overrides });
  assert.deepEqual(projectBudgetGauge(budget({})), { ratio: 523_000 / 1_500_000, tone: "done", status: "正常", detail: "输入 52.3 万 / 150 万（35%）", handoff: false });
  assert.deepEqual(projectBudgetGauge(budget({ state: "warning", used: 1_290_000, ratio: 0.86 })).status, "接近上限");
  assert.deepEqual(projectBudgetGauge(budget({ state: "exhausted", used: 1_530_000, ratio: 1.02 })),
    { ratio: 1, tone: "blocked", status: "已达上限", detail: "输入 153 万 / 150 万（102%） · 普通结果通知已暂停", handoff: false });
  assert.equal(projectBudgetGauge(budget({ limitKind: "cost_usd", limit: 20, used: 4.5, ratio: 0.225 })).detail, "费用 $4.50 / $20.00（23%）");
  assert.deepEqual(projectBudgetGauge(budget({ configured: false, state: "unconfigured", limit: null, ratio: null })),
    { ratio: null, tone: "idle", status: "未设上限", detail: "未配置每日上限，只记录用量", handoff: false });
  assert.equal(projectBudgetGauge(budget({ state: "unknown", ratio: null, costComplete: false })).detail, "有的记录没有报告费用，费用上限暂时无法判定");
  const day = (d: string, input: number) => ({ day: d, inputTokens: input, outputTokens: input ? 7_300 : 0, cachedInputTokens: input ? 31_000 : 0, costUsd: null, costReported: false });
  // The service lists only days with ledger rows: 11-08 and 11-05 had none; 11-07 was recorded as 0.
  const daily = [day("2026-11-03", 90_000), day("2026-11-04", 120_000), day("2026-11-06", 61_200), day("2026-11-07", 0), day("2026-11-09", 401_200), day("2026-11-10", 523_000)];
  const days = recentProjectDays(daily, "2026-11-10");
  assert.deepEqual(days.map(row => row.day), ["2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04"],
    "seven calendar days ending today, newest first; 11-03 is outside them");
  assert.deepEqual(days[0], { day: "2026-11-10", recorded: true, input: "52.3 万", output: "7300", cached: "3.1 万", cost: "未报告" });
  assert.deepEqual(days[2], { day: "2026-11-08", recorded: false }, "a day with no record is said to have none, never 0");
  assert.deepEqual(days[3], { day: "2026-11-07", recorded: true, input: "0", output: "0", cached: "0", cost: "未报告" }, "a day recorded as 0 shows 0");
  assert.deepEqual(days[5], { day: "2026-11-05", recorded: false });
  // A month boundary, and no usable today: then only the recorded days, newest first.
  assert.deepEqual(recentProjectDays([], "2026-12-02").map(row => row.day).slice(0, 3), ["2026-12-02", "2026-12-01", "2026-11-30"]);
  assert.deepEqual(recentProjectDays(daily, null).map(row => row.day)[0], "2026-11-10");
  assert.equal(recentProjectDays(daily, null).every(row => row.recorded), true);
  // Today is the project's own calendar day at the time of the read.
  assert.equal(projectToday("2026-11-10T17:30:00.000Z", "Asia/Shanghai"), "2026-11-11");
  assert.equal(projectToday("2026-11-10T17:30:00.000Z", "UTC"), "2026-11-10");
  assert.equal(projectToday("2026-11-10T17:30:00.000Z", "Not/AZone"), null);
  assert.equal(projectToday("not a time", "UTC"), null);
});

test("a day with no ledger row is never shown as 0: not in today's figures, not in the project's limit bar", () => {
  const zero = { day: "2026-11-12", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, costReported: false };
  const yesterday = { ...zero, day: "2026-11-11", inputTokens: 120_000 };
  // The service fills today with zeros when there is no row for it; only `days` tells whether it was recorded.
  assert.equal(todayTiles({ recorded: true, today: zero, days: [yesterday] }), null, "recorded yesterday, nothing today: no figures");
  assert.deepEqual(todayTiles({ recorded: true, today: zero, days: [yesterday, zero] })!.map(tile => tile.value), ["0", "0", "0", "未报告"], "a recorded 0 is 0");
  const budget: UsageBudget = { configured: true, state: "ok", limitKind: "input_tokens", limit: 400_000, used: 0, ratio: 0, warningRatio: 0.8,
    pauseOrdinaryTurns: true, costComplete: true, reason: null };
  assert.deepEqual(projectBudgetGauge(budget, false), { ratio: null, tone: "idle", status: "今日没有记录", detail: "今日没有记录，不按 0 计 · 每日上限 40 万", handoff: false });
  assert.deepEqual(projectBudgetGauge(budget, true).detail, "输入 0 / 40 万（0%）", "recorded as 0: the bar and 0% are right");
  assert.equal(projectBudgetGauge({ ...budget, limitKind: "cost_usd", limit: 20 }, false).detail, "今日没有记录，不按 0 计 · 每日上限 $20.00");
  assert.equal(projectBudgetGauge({ ...budget, configured: false, state: "unconfigured", limit: null, ratio: null }, false).status, "未设上限");
});

test("while a new target waits, a strength or model nobody confirmed is said so, never the new target's", () => {
  const waiting = (extra: Record<string, unknown>): RecoveryRead => ({ status: "ready", view: { executionProfile: {
    revision, activationState: "pending", activeRevisionId: "r1", activeModel: "gpt-6-sol", activeReasoningEffort: null, ...extra } } } as never);
  const noEffort = runtimeEnvironment({ ...owned, recovery: waiting({}), actualModel: null });
  assert.deepEqual([noEffort.model, noEffort.effort], [{ text: "gpt-6-sol", source: "confirmed" }, { text: "强度未确认", source: null }]);
  assert.deepEqual(runtimeEnvironment({ ...owned, recovery: waiting({ activeModel: null }), actualModel: null }).model, { text: "模型未确认", source: null });
  assert.deepEqual(noEffort.change, { tone: "waiting", label: "下一轮改为 gpt-6-astra / max" });
});
