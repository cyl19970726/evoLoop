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
