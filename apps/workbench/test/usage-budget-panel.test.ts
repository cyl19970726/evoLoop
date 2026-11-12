import assert from "node:assert/strict";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { UsageOverview } from "@evoloop/contracts";
import { SessionUsageView } from "../src/features/sessions/UsageBudgetPanel.tsx";

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

test("the agent's usage card shows its context first, today in small figures, and keeps project-wide facts out", () => {
  const quiet = { ...overview, budget: { ...overview.budget, state: "ok" as const } };
  const html = renderToStaticMarkup(createElement(SessionUsageView, { usage: quiet, sessionId: "session", projectId: "project" }));
  assert.match(html, /上下文/);
  assert.match(html, /需交接新线程/);
  assert.match(html, /请交接新线程/);
  assert.match(html, /aria-valuenow="100"/, "the bar is full past the threshold");
  assert.match(html, /18\.6 万 \/ 15 万（124%）/);
  assert.match(html, /今日/);
  assert.match(html, /18\.6 万/);
  assert.match(html, /未报告/);
  assert.equal(html.includes("$0.0000"), false, "an unreported cost is never rendered as $0");
  // The project's daily limit, its recent days and the usage time zone belong to the project, not to this agent.
  for (const projectWide of ["每日上限", "最近 2 天的项目用量", "2026-11-10", "Asia/Shanghai"]) assert.equal(html.includes(projectWide), false, projectWide);
  // The project's budget is fine: no reminder.
  assert.equal(html.includes("去统筹安排"), false);
});

test("a project close to its daily limit is one reminder line linking to 统筹安排; an agent without records says so", () => {
  const warning = { ...overview, budget: { ...overview.budget, state: "warning" as const, ratio: 0.86 } };
  const html = renderToStaticMarkup(createElement(SessionUsageView, { usage: warning, sessionId: "session", projectId: "project" }));
  assert.match(html, /项目今日用量接近每日上限（86%）/);
  assert.match(html, /href="\/p\/project\/sessions"[^>]*>去统筹安排/);
  const none = renderToStaticMarkup(createElement(SessionUsageView, { usage: overview, sessionId: "other", projectId: "project" }));
  assert.match(none, /没有记录/);
  assert.match(none, /这个智能体还没有用量记录，不按 0 计/);
  assert.equal(none.includes("本会话累计"), false);
});
