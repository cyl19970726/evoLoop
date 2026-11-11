import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRollout } from "./context-baseline.mjs";

const event = (type, payload) => JSON.stringify({ type: "event_msg", payload: { type, ...payload } });
const response = (type, payload) => JSON.stringify({ type: "response_item", payload: { type, ...payload } });

test("summarizeRollout reports per-turn maximum context and byte shares", () => {
  const lines = [
    event("task_started", {}),
    event("token_count", { info: { last_token_usage: { input_tokens: 100_000 }, total_token_usage: { input_tokens: 100_000, output_tokens: 10 } } }),
    response("function_call_output", { output: "x".repeat(100) }),
    event("token_count", { info: { last_token_usage: { input_tokens: 186_000 }, total_token_usage: { input_tokens: 186_000, output_tokens: 20 } } }),
    event("task_complete", {}),
    JSON.stringify({ type: "compacted", payload: {} }),
    event("task_started", {}),
    event("token_count", { info: { last_token_usage: { input_tokens: 76_000 }, total_token_usage: { input_tokens: 262_000, output_tokens: 30 } } }),
    event("task_complete", {}),
  ];
  const summary = summarizeRollout(lines);
  assert.equal(summary.turns, 2);
  assert.deepEqual([summary.meanInputTokens, summary.maxInputTokens], [131_000, 186_000]);
  assert.equal(summary.cumulativeInputTokens, 262_000);
  assert.equal(summary.compactions, 1);
  assert.equal(summary.turnsOverLimit, null);
  assert.equal(summarizeRollout(lines, 150_000).turnsOverLimit, 1);
  assert.ok(summary.categories.some(item => item.category === "response_item.function_call_output" && item.bytes > 100));
});
