import assert from "node:assert/strict";
import test from "node:test";
import type { ContextPressure, UsageBudget } from "@evoloop/contracts";
import { ordinaryTurnAdmission } from "../src/session-messages/ordinary-turn-admission.ts";

const okBudget: UsageBudget = { configured: true, state: "ok", limitKind: "input_tokens", limit: 100,
  used: 10, ratio: 0.1, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null };
const okContext: ContextPressure = { configured: true, state: "ok", inputTokens: 10_000, limit: 150_000,
  ratio: 0.07, warningRatio: 0.8, pauseOrdinaryTurns: true, observedAt: "2026-11-10T00:00:00.000Z", reason: null };

test("a business Task Run or a person's message is never blocked by ordinary-turn guards", () => {
  const admission = ordinaryTurnAdmission({ isNotice: false,
    budget: { ...okBudget, state: "exhausted" }, context: { ...okContext, state: "handoff_required" } });
  assert.equal(admission.allowed, true);
  assert.equal(admission.reason, null);
});

test("an exhausted daily budget blocks only the result notice with a recoverable reason", () => {
  const admission = ordinaryTurnAdmission({ isNotice: true, budget: { ...okBudget, state: "exhausted" }, context: okContext });
  assert.equal(admission.allowed, false);
  assert.match(admission.reason ?? "", /^DAILY_BUDGET_EXHAUSTED/);
  assert.match(admission.reason ?? "", /业务 Task Run 不受影响/);
  assert.equal(admission.warning, true);
});

test("context at the handoff ceiling pauses ordinary notices and names the Session", () => {
  const admission = ordinaryTurnAdmission({ isNotice: true, budget: okBudget,
    context: { ...okContext, state: "handoff_required", inputTokens: 160_000 } });
  assert.equal(admission.allowed, false);
  assert.match(admission.reason ?? "", /^CONTEXT_HANDOFF_REQUIRED/);
  assert.match(admission.reason ?? "", /160000/);
});

test("warning states stay visible without stopping a notice", () => {
  const admission = ordinaryTurnAdmission({ isNotice: true,
    budget: { ...okBudget, state: "warning", ratio: 0.85 }, context: { ...okContext, state: "warning" } });
  assert.equal(admission.allowed, true);
  assert.equal(admission.warning, true);
});

test("a maintainer can turn off pausing while keeping the warning", () => {
  const admission = ordinaryTurnAdmission({ isNotice: true,
    budget: { ...okBudget, state: "exhausted", pauseOrdinaryTurns: false },
    context: { ...okContext, state: "handoff_required", pauseOrdinaryTurns: false } });
  assert.equal(admission.allowed, true);
  assert.equal(admission.warning, true);
});
