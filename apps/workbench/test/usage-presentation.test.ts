import assert from "node:assert/strict";
import test from "node:test";
import type { ContextPressure, UsageBudget } from "@evoloop/contracts";
import { budgetText, contextText, costText, tokenText, usageDayText } from "../src/features/sessions/usagePresentation.ts";

test("usage keeps an unreported cost out of $0 and never turns unknown tokens into zero", () => {
  assert.equal(costText({ costUsd: 0, costReported: false }), "未报告");
  assert.equal(costText({ costUsd: 0.0123, costReported: true }), "$0.0123");
  assert.equal(tokenText(null), "未知");
  assert.equal(tokenText(9_999), "9999");
  assert.equal(tokenText(186_000), "18.6 万");
  assert.match(usageDayText({ inputTokens: 186_000, outputTokens: 2_000, cachedInputTokens: 100_000,
    costUsd: 0, costReported: false }), /费用 未报告/);
});

test("the budget line says configured, warning and exhausted states without inventing a number", () => {
  const base: UsageBudget = { configured: true, state: "ok", limitKind: "input_tokens", limit: 200_000,
    used: 50_000, ratio: 0.25, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null };
  assert.match(budgetText(base), /正常 · 输入词元 5 万 \/ 20 万/);
  assert.match(budgetText({ ...base, state: "warning", ratio: 0.85 }), /接近上限/);
  assert.match(budgetText({ ...base, state: "exhausted", ratio: 1 }), /普通结果通知已暂停/);
  assert.match(budgetText({ ...base, configured: false, limit: null, used: null, ratio: null }), /未配置每日上限/);
  assert.match(budgetText({ ...base, limitKind: "cost_usd", limit: 25, used: 12.5, ratio: 0.5 }),
    /费用 \$12\.50 \/ \$25\.00/);
});

test("context text names the handoff state and the missing observation", () => {
  const base: ContextPressure = { configured: true, state: "warning", inputTokens: 186_000, limit: 200_000,
    ratio: 0.93, warningRatio: 0.8, pauseOrdinaryTurns: true, observedAt: "2026-11-10T00:00:00.000Z", reason: null };
  assert.match(contextText(base), /接近交接阈值 · 上下文 18.6 万 \/ 20 万（93%）/);
  assert.match(contextText({ ...base, state: "handoff_required", ratio: 1 }), /需交接新线程/);
  assert.match(contextText({ ...base, state: "unknown", inputTokens: null, ratio: null }), /当前用量未知/);
});

test("from one hundred million up a count is shown in 亿 so the unit stays in view, with the exact value kept for tooltips and screen readers", async () => {
  const { tokenFullText, todayTiles } = await import("../src/features/sessions/usagePresentation");
  assert.equal(tokenText(99_990_000), "9999 万", "below 亿 the earlier form is unchanged");
  assert.equal(tokenText(100_000_000), "1 亿"); assert.equal(tokenText(231_390_851_234), "2313.9 亿"); assert.equal(tokenText(1_234_567_890), "12.3 亿");
  assert.equal(tokenFullText(231_390_851_234), "231,390,851,234 个令牌"); assert.equal(tokenFullText(null), null);
  const day = { day: "2026-11-12", inputTokens: 231_390_851_234, outputTokens: 2_142_580_000, cachedInputTokens: 1_000_000_000, costUsd: null, costReported: false };
  const tiles = todayTiles({ recorded: true, today: day })!;
  assert.deepEqual(tiles.map(tile => [tile.label, tile.value]), [["输入", "2313.9 亿"], ["输出", "21.4 亿"], ["缓存输入", "10 亿"], ["费用", "未报告"]]);
  assert.equal(tiles[0]!.full, "231,390,851,234 个令牌"); assert.equal(tiles[3]!.full, null);
  const small = todayTiles({ recorded: true, today: { ...day, inputTokens: 8800, outputTokens: 9200, cachedInputTokens: 4400 } })!;
  assert.deepEqual(small.slice(0, 3).map(tile => tile.full), [null, null, null], "an exact small count needs no second value");
});

test("after #402: no record today is not 0, a recorded 0 is, and both keep working next to billion-scale figures and project usage", async () => {
  const { projectBudgetGauge, recentProjectDays, todayTiles } = await import("../src/features/sessions/usagePresentation");
  const zero = { day: "2026-11-12", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, costReported: false };
  const big = { ...zero, day: "2026-11-11", inputTokens: 231_390_851_234, outputTokens: 2_142_580_000, cachedInputTokens: 1_000_000_000 };
  assert.equal(todayTiles({ recorded: true, today: zero, days: [big] }), null, "nothing recorded today, only a big yesterday: no figures");
  assert.deepEqual(todayTiles({ recorded: true, today: zero, days: [big, zero] })!.map(tile => tile.value), ["0", "0", "0", "未报告"], "a recorded 0 shows 0");
  assert.deepEqual(todayTiles({ recorded: true, today: big, days: [big] })!.map(tile => tile.value), ["2313.9 亿", "21.4 亿", "10 亿", "未报告"]);
  // Project usage: the same formatting in the limit line and the day rows, exact counts kept.
  const budget = { configured: true, state: "warning", limitKind: "input_tokens", limit: 4_000_000_000, used: 3_300_000_000, ratio: 0.825, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null } as never;
  assert.equal(projectBudgetGauge(budget, true).detail, "输入 33 亿 / 40 亿（83%）");
  assert.match(projectBudgetGauge(budget, false).detail, /今日没有记录，不按 0 计 · 每日上限 40 亿/);
  const rows = recentProjectDays([big, { ...big, day: "2026-11-10", inputTokens: 99_990_000 }], "2026-11-11", 3);
  const [first, second, third] = rows as Array<Record<string, unknown>>;
  assert.equal(first!.input, "2313.9 亿"); assert.equal(first!.inputFull, "231,390,851,234 个令牌");
  assert.equal(second!.input, "9999 万", "below 亿 the earlier form is unchanged"); assert.equal(third!.recorded, false, "a day without a row says so, never 0");
});

test("the project limit line carries its exact used amount and limit; a cost limit is exact already; nothing is invented without a figure", async () => {
  const { projectBudgetGauge } = await import("../src/features/sessions/usagePresentation");
  const tokens = { configured: true, state: "ok", limitKind: "input_tokens", limit: 300_000_000_000, used: 2_142_579_630, ratio: 2_142_579_630 / 300_000_000_000,
    warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null } as never;
  const gauge = projectBudgetGauge(tokens, true);
  assert.equal(gauge.detail, "输入 21.4 亿 / 3000 亿（1%）", "the line is rounded, as the reviewer saw it");
  assert.equal(gauge.exact, "已用 2,142,579,630 / 上限 300,000,000,000 个令牌", "the exact amounts are available");
  assert.equal(projectBudgetGauge({ ...(tokens as object), limitKind: "cost_usd", limit: 20, used: 4.5, ratio: 0.225 } as never, true).exact, "已用 $4.50 / 上限 $20.00");
  assert.equal(projectBudgetGauge({ ...(tokens as object), used: null, ratio: null, state: "unknown" } as never, true).exact, null, "no used amount: nothing to state");
  assert.equal(projectBudgetGauge({ ...(tokens as object), configured: false } as never, true).exact, null);
  assert.equal(projectBudgetGauge(tokens, false).exact, null, "no record today: no bar and no amounts");
});
