import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextHandoffSummary, contextPressure } from "@evoloop/core/context-budget";
import { usageBudget } from "@evoloop/core/usage";
import { loadIntegrations } from "../src/configuration.ts";
import { ordinaryTurnAdmission } from "../src/session-messages/ordinary-turn-admission.ts";

test("a synthetic private configuration exercises warning, daily pause, and context handoff without production I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-budget-verification-"));
  const file = join(directory, "integrations.json");
  try {
    await writeFile(file, JSON.stringify({
      runtime: {
        enabled: true,
        grants: [],
        dailyBudget: {
          enabled: true,
          maxInputTokens: 1_000,
          warningRatio: 0.8,
          pauseOrdinaryTurns: true,
          timeZone: "Asia/Tashkent",
        },
        contextBudget: {
          enabled: true,
          maxInputTokens: 5_000,
          warningRatio: 0.8,
          pauseOrdinaryTurns: true,
        },
      },
    }));
    const integrations = await loadIntegrations(file);
    const budgetConfig = integrations.runtime?.dailyBudget;
    const contextConfig = integrations.runtime?.contextBudget;
    assert.ok(budgetConfig?.enabled);
    assert.ok(contextConfig?.enabled);

    const day = (inputTokens: number) => ({ day: "2026-11-12", inputTokens, outputTokens: 0,
      cachedInputTokens: 0, costUsd: null, costReported: false });
    const observedAt = "2026-11-12T02:00:00.000Z";
    const warningBudget = usageBudget(budgetConfig, day(850));
    const warningContext = contextPressure(contextConfig, {
      inputTokens: 4_200, modelContextWindow: null, observedAt,
    });
    assert.equal(warningBudget.state, "warning");
    assert.equal(warningContext.state, "warning");
    assert.deepEqual(ordinaryTurnAdmission({
      isNotice: true, budget: warningBudget, context: warningContext,
    }), { allowed: true, reason: null, warning: true });

    const exhaustedBudget = usageBudget(budgetConfig, day(1_000));
    const dailyPause = ordinaryTurnAdmission({
      isNotice: true, budget: exhaustedBudget, context: warningContext,
    });
    assert.equal(dailyPause.allowed, false);
    assert.match(dailyPause.reason ?? "", /^DAILY_BUDGET_EXHAUSTED/);
    assert.equal(ordinaryTurnAdmission({
      isNotice: false, budget: exhaustedBudget, context: warningContext,
    }).allowed, true, "a business Task Run or a person's message remains eligible");

    const handoffContext = contextPressure(contextConfig, {
      inputTokens: 5_000, modelContextWindow: null, observedAt,
    });
    const contextPause = ordinaryTurnAdmission({
      isNotice: true, budget: warningBudget, context: handoffContext,
    });
    assert.equal(contextPause.allowed, false);
    assert.match(contextPause.reason ?? "", /^CONTEXT_HANDOFF_REQUIRED/);
    const summary = contextHandoffSummary({
      roleId: "role-verification",
      sessionId: "session-verification",
      nativeThreadId: "thread-verification",
      pressure: handoffContext,
      generatedAt: observedAt,
      nextResponsibility: "Read the fixed Task and pending result notices before acting.",
    });
    assert.match(summary, /session-verification/);
    assert.match(summary, /thread-verification/);
    assert.match(summary, /5000 \/ 5000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
