import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedRecoveryView, recoveryActivationLabel, recoveryBudget, recoveryNextActionLabel, recoveryPhaseLabel, type SessionRecoveryView } from "../src/sessions/recoveryPresentation.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const base: SessionRecoveryView = {
  sessionId, executionProfile: null, gate: null, decisions: [], queues: [], nextAction: "normal_work", partial: false,
  observedAtUtc: "2026-10-27T00:00:00.000Z",
};

test("all five recovery phases describe permission and waiting rather than inferred execution", () => {
  assert.deepEqual(["open", "blocked", "retrying", "message_pending", "awaiting_acceptance"].map(phase =>
    recoveryPhaseLabel(phase as NonNullable<SessionRecoveryView["gate"]>["phase"])), [
    "可按正常规则接续", "已停止接续", "等待原任务重试", "等待原排队消息", "等待交付与验收",
  ]);
  assert.match(recoveryNextActionLabel("await_authorized_retry"), /是否运行以 Run 记录为准/);
  assert.match(recoveryNextActionLabel("await_original_message"), /消息记录为准/);
  assert.match(recoveryNextActionLabel("reconcile_original_operation"), /核对原操作/);
  assert.match(recoveryNextActionLabel("normal_work", "closed"), /已关闭.*不能直接接续/);
  assert.match(recoveryNextActionLabel("normal_work", "ready"), /正常工作规则/);
  assert.match(recoveryActivationLabel("unknown"), /结果未知/);
});

test("queue budget keeps failed and unknown attempts in cumulative used count", () => {
  const queue = { queueId: "q", version: 2, adoptedVersion: 1, maxRuns: 5, attemptsUsed: 3, attemptsRemaining: 2 };
  assert.deepEqual(recoveryBudget(queue), { used: 3, max: 5, remaining: 2 });
  assert.equal(checkedRecoveryView({ ...base, queues: [queue] }, projectId, sessionId).queues[0]?.attemptsUsed, 3);
  assert.throws(() => checkedRecoveryView({ ...base, queues: [{ ...queue, attemptsRemaining: 4 }] }, projectId, sessionId), /内容不完整/);
});

test("a mismatched or incomplete recovery response cannot be shown on another Session", () => {
  assert.throws(() => checkedRecoveryView(base, projectId, "33333333-3333-4333-8333-333333333333"), /所选 Session 不符/);
  assert.equal(checkedRecoveryView(base, projectId, sessionId).gate, null);
  assert.equal(checkedRecoveryView({ ...base, partial: true }, projectId, sessionId).partial, true);
  assert.throws(() => checkedRecoveryView({ ...base, executionProfile: undefined } as unknown as SessionRecoveryView, projectId, sessionId), /内容不完整/);
  const gate: NonNullable<SessionRecoveryView["gate"]> = { projectId, sessionId, phase: "blocked", causeKind: "run", causeId: null,
    causeState: "unknown", reason: "原结果未知", queueId: null, claimId: null, retryRunId: null, resumeMessageId: null,
    decisionOperationId: null, updatedAt: base.observedAtUtc };
  const executionProfile: NonNullable<SessionRecoveryView["executionProfile"]> = {
    revision: { projectId, sessionId, revisionId: "44444444-4444-4444-8444-444444444444", version: 2, model: "gpt-6-sol",
      createdAt: base.observedAtUtc, actorId: "owner", reason: "明确修订", evidenceRef: null },
    activeRevisionId: null, activationState: "pending", activationOperationId: null, attemptedAt: null, activationEvidence: null,
  };
  assert.equal(checkedRecoveryView({ ...base, gate, executionProfile }, projectId, sessionId).executionProfile?.revision.model, "gpt-6-sol");
  assert.throws(() => checkedRecoveryView({ ...base, gate: { ...gate, projectId: "33333333-3333-4333-8333-333333333333" } }, projectId, sessionId), /内容不完整/);
});
