import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeFailureLine, nativeFailureWording } from "../src/features/sessions/nativeFailurePresentation.ts";
import { recoveryReasonSummary } from "../src/features/sessions/recoveryPresentation.ts";

test("a quota or authentication failure says work is blocked and who must act", () => {
  for (const category of ["quota_exhausted", "authentication_failed"]) {
    const line = nativeFailureLine(category)!;
    assert.match(line, /运行受阻/);
    assert.match(line, /账户使用者/);
    assert.match(line, /充值或重新授权/);
  }
});

test("the other classes say what happened without calling the work blocked on the account", () => {
  assert.match(nativeFailureLine("context_window_exceeded")!, /上下文超长.*压缩/);
  assert.match(nativeFailureLine("connection_lost")!, /连接中断/);
  assert.match(nativeFailureLine("provider_unavailable")!, /连接中断/);
  assert.match(nativeFailureLine("native_failure")!, /原生运行失败/);
  assert.doesNotMatch(nativeFailureLine("native_failure")!, /运行受阻/);
});

test("an unclassified failure adds nothing", () => {
  assert.equal(nativeFailureLine(null), null);
  assert.equal(nativeFailureLine(undefined), null);
  assert.equal(nativeFailureWording(""), null);
});

test("the recovery gate summary names the class of the failed message, and stays plain without one", () => {
  const gate = (failureCategory: string | null) => ({ projectId: "p", sessionId: "s", version: 1, phase: "blocked" as const, causeKind: "message" as const,
    causeId: "m", causeState: "failed", reason: "x", queueId: null, claimId: null, retryRunId: null, resumeMessageId: null,
    decisionOperationId: null, updatedAt: "2026-11-11T00:00:00.000Z", failureCategory });
  assert.match(recoveryReasonSummary(gate("quota_exhausted")), /运行受阻.*账户使用者.*原消息处理已记录为失败/);
  assert.equal(recoveryReasonSummary(gate(null)), "原消息处理已记录为失败");
});
