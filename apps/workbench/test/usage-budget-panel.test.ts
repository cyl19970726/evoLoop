import assert from "node:assert/strict";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { UsageOverview } from "@evoloop/contracts";
import { UsageBudgetView } from "../src/features/sessions/UsageBudgetPanel.tsx";

// Shared parts written for the automatic JSX runtime expect React in scope under this test loader.
Object.assign(globalThis, { React: ReactModule });

const overview: UsageOverview = {
  projectId: "project", from: "2026-11-05", to: "2026-11-11", timeZone: "Asia/Shanghai",
  observedAt: "2026-11-11T02:00:00.000Z",
  sessions: [{
    sessionId: "session", roleId: "role", nativeThreadId: "thread",
    recorded: true,
    days: [{ day: "2026-11-11", inputTokens: 186_000, outputTokens: 2_000, cachedInputTokens: 100_000,
      costUsd: 0, costReported: false }],
    today: { day: "2026-11-11", inputTokens: 186_000, outputTokens: 2_000, cachedInputTokens: 100_000,
      costUsd: 0, costReported: false },
    total: { inputTokens: 186_000, outputTokens: 2_000, cachedInputTokens: 100_000, costUsd: 0, costReported: false },
    contextInputTokens: 186_000, observedAt: "2026-11-11T02:00:00.000Z",
    context: { configured: true, state: "handoff_required", inputTokens: 186_000, limit: 150_000,
      ratio: 1.24, warningRatio: 0.8, pauseOrdinaryTurns: true, observedAt: "2026-11-11T02:00:00.000Z",
      reason: "请交接到新线程" },
  }],
  daily: [
    { day: "2026-11-10", inputTokens: 120_000, outputTokens: 1_000, cachedInputTokens: 80_000,
      costUsd: 0.02, costReported: true },
    { day: "2026-11-11", inputTokens: 186_000, outputTokens: 2_000, cachedInputTokens: 100_000,
      costUsd: 0, costReported: false },
  ],
  budget: { configured: true, state: "warning", limitKind: "input_tokens", limit: 500_000,
    used: 306_000, ratio: 0.612, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason: null },
};

test("the Session panel shows per-Session and per-day usage, context handoff and budget state", () => {
  const html = renderToStaticMarkup(createElement(UsageBudgetView, { usage: overview, sessionId: "session" }));
  assert.match(html, /今日（本智能体）/);
  assert.match(html, /18\.6 万/);
  assert.match(html, /需交接新线程/);
  assert.match(html, /请交接新线程/);
  assert.match(html, /最近 2 天的项目用量/);
  assert.match(html, /2026-11-10/);
  assert.match(html, /费用 未报告/);
  assert.equal(html.includes("$0.0000"), false, "an unreported cost is never rendered as $0");
});
