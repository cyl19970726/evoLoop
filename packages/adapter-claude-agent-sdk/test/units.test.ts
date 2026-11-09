import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResult, turnCost, usageOf } from "../src/classify.js";
import { TurnLedger } from "../src/ledger.js";
import { carriesUserMessage } from "../src/process.js";
import { observeInit } from "../src/context.js";

const plain = { assistantError: null, interruptRequested: false };

test("results classify into the neutral Turn outcomes", () => {
  assert.deepEqual(classifyResult({ subtype: "success", is_error: false }, plain), { status: "completed" });
  assert.deepEqual(classifyResult({ subtype: "error_during_execution", terminal_reason: "aborted_streaming" },
    { assistantError: null, interruptRequested: true }), { status: "interrupted" });
  const unrequested = classifyResult({ subtype: "error_during_execution", terminal_reason: "aborted_streaming" }, plain);
  assert.equal(unrequested.status, "failed", "an abort nobody requested is a failure");
  const cases: Array<[Parameters<typeof classifyResult>, string, string | null]> = [
    [[{ subtype: "error_max_turns" }, plain], "budget_exceeded", "error_max_turns"],
    [[{ subtype: "success", is_error: true }, { assistantError: "rate_limit", interruptRequested: false }], "rate_limited", "rate_limit"],
    [[{ subtype: "success", is_error: true }, { assistantError: "overloaded", interruptRequested: false }], "provider_unavailable", "overloaded"],
    [[{ subtype: "success", is_error: true }, { assistantError: "model_not_found", interruptRequested: false }], "unsupported_model", "model_not_found"],
    [[{ subtype: "success", is_error: true }, { assistantError: "billing_error", interruptRequested: false }], "provider_rejected", "billing_error"],
    [[{ subtype: "success", is_error: true }, { assistantError: "oauth_org_not_allowed", interruptRequested: false }], "authentication_failed", "oauth_org_not_allowed"],
    [[{ subtype: "error_during_execution", terminal_reason: "budget_exhausted" }, plain], "budget_exceeded", "budget_exhausted"],
    [[{ subtype: "error_during_execution", terminal_reason: "Some Text!" }, plain], "native_failure", null],
  ];
  for (const [input, category, providerCode] of cases) {
    const classified = classifyResult(...input);
    assert.equal(classified.status, "failed");
    if (classified.status !== "failed") continue;
    assert.equal(classified.error.category, category);
    assert.equal(classified.error.providerCode, providerCode);
  }
});

test("Turn cost is the difference of cumulative totals and null when unproven", () => {
  assert.equal(turnCost(0.03, 0.01), 0.02);
  assert.equal(turnCost(0.5, 0), 0.5);
  assert.equal(turnCost(null, 0), null);
  assert.equal(turnCost(0.2, null), null);
  assert.equal(turnCost(0.01, 0.4), null, "a total that went backwards proves nothing");
});

test("usage keeps unreported counts null", () => {
  assert.equal(usageOf(null), null);
  assert.deepEqual(usageOf({ input_tokens: 3, output_tokens: -1 }), { inputTokens: 3, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null });
});

test("only user-message writes count as the prompt reaching the child", () => {
  assert.equal(carriesUserMessage(`${JSON.stringify({ type: "control_request", request: { subtype: "initialize" } })}\n`), false);
  assert.equal(carriesUserMessage(`${JSON.stringify({ type: "user", message: { role: "user", content: "x" } })}\n`), true);
  assert.equal(carriesUserMessage("{not json"), true, "an unreadable write is treated as possibly sent");
});

test("the ledger tolerates a torn final line but not mid-file corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "evoloop-ledger-"));
  try {
    const ledger = new TurnLedger(root), projectId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
    await ledger.append(projectId, sessionId, { kind: "session", at: "t", projectId, sessionId, nativeSessionId: sessionId, cwd: "/w" });
    await ledger.append(projectId, sessionId, { kind: "turn.started", at: "t", turnId, operationId: randomUUID(), input: "x", resume: false });
    await appendFile(join(root, projectId, `${sessionId}.jsonl`), '{"kind":"turn.se');
    assert.equal((await ledger.read(projectId, sessionId)).turns.length, 1);
    await appendFile(join(root, projectId, `${sessionId}.jsonl`), `\n${JSON.stringify({ kind: "turn.sent", at: "t", turnId })}\n`);
    await assert.rejects(ledger.read(projectId, sessionId), /corrupted/);
    await assert.rejects(ledger.append("../escape", sessionId, { kind: "session.archived", at: "t" }), /invalid ledger identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("init observation keeps MCP server names so an unconfigured server is visible", () => {
  const observed = observeInit({ mode: "explicit", plan: null, allowedSkills: null, instructions: null },
    { skills: ["simplify"], plugins: [], mcp_servers: [{ name: "claude.ai Fake Docs", status: "connected" }, { name: "bad\nname" }, null] }, "t");
  assert.deepEqual(observed.mcpServers, ["claude.ai Fake Docs", "unrecognized"]);
  assert.deepEqual(observeInit({ mode: "project", plan: null, allowedSkills: null, instructions: null }, {}, "t").mcpServers, []);
});
