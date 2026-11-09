// Every Role command the 职责 page sends: the version it was read at travels with it, so a stale form is refused by
// the service instead of overwriting a newer revision.
import assert from "node:assert/strict";
import test from "node:test";
import { commandSchema } from "@evoloop/contracts";
import type { RoleHandoff, RoleRecord } from "@evoloop/contracts/roles";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import {
  ackHandoffForm, bindForm, buildProposal, decideForm, handoffForm, proposalFields, registerHostForm, retireForm, reviewForm, verifyHostForm,
} from "../src/features/roles/roleForms.ts";

const projectId = "36000001-0000-4000-8000-000000000001";
const roleId = "36000002-0000-4000-8000-000000000002";
const otherRole = "36000003-0000-4000-8000-000000000003";
const taskId = "36000004-0000-4000-8000-000000000004";
const role = { projectId, id: roleId, version: 7, state: "trial" } as RoleRecord;
const sent = (command: Record<string, unknown>) => commandSchema.parse({ ...command, projectId, operationId: "36000009-0000-4000-8000-000000000009" });

test("decide, review, handoff, acknowledge, bind and retire carry the Role version they were read at", () => {
  const decide = sent(decideForm(role).build({ decision: "accept-trial", reason: "证据充分" }));
  assert.deepEqual([decide.type, (decide as { expectedVersion: number }).expectedVersion], ["role.decide", 7]);
  const review = reviewForm(role).build({ decision: "continue-trial", effectEvidence: "返工减少", effectEvidenceRefs: "task://1\ntask://2", costEvidence: "两天",
    costEvidenceRefs: "task://3", baselineComparison: "从三次到一次", nextReviewAtUtc: "2026-12-01T09:00:00+08:00", mergeTargetRoleId: "", reason: "延长" });
  assert.deepEqual([review.expectedVersion, review.effectEvidenceRefs, review.nextReviewAtUtc, "mergeTargetRoleId" in review],
    [7, ["task://1", "task://2"], "2026-12-01T01:00:00.000Z", false]);
  sent(review);
  const handoff = handoffForm(role).build({ kind: "task", sourceRef: taskId, targetRoleId: otherRole, observedTaskVersion: "3", note: "移交" });
  assert.deepEqual([handoff.expectedVersion, handoff.observedTaskVersion], [7, 3]);
  sent(handoff);
  assert.equal("observedTaskVersion" in handoffForm(role).build({ kind: "knowledge", sourceRef: "doc://1", targetRoleId: otherRole, observedTaskVersion: "", note: "资料" }), false);
  const ack = sent(ackHandoffForm(role, { id: "36000005-0000-4000-8000-000000000005" } as RoleHandoff).build({ note: "已接收" }));
  assert.deepEqual([ack.type, (ack as { expectedVersion: number }).expectedVersion], ["role.ackHandoff", 7]);
  const bind = sent(bindForm(role).build({ sessionId: "36000006-0000-4000-8000-000000000006", note: "主承载" }));
  assert.equal((bind as { expectedVersion: number }).expectedVersion, 7);
  const retire = sent(retireForm(role).build({ reason: "职责合并", knowledgeDisposition: "已归档", runtimeDisposition: "无在途" }));
  assert.deepEqual([retire.type, (retire as { expectedVersion: number }).expectedVersion], ["role.retire", 7]);
});

test("external chats are registered and verified against the Role's version and the link's own version", () => {
  const register = registerHostForm(role).build({ ref: "01a158d7-f842-7ca3-9899-ce1efc33c030", reason: "人工核对" });
  assert.deepEqual([register.type, register.expectedRoleVersion, (register.host as { ref: string }).ref],
    ["host.register", 7, "codex://threads/01a158d7-f842-7ca3-9899-ce1efc33c030"]);
  assert.throws(() => registerHostForm(role).build({ ref: "https://example.com/chat", reason: "x" }), /Codex 聊天引用/);
  const verify = verifyHostForm(role, { id: "36000007-0000-4000-8000-000000000007", version: 4 } as HostLink)
    .build({ verifiedCapabilities: JSON.stringify(["open", "read"]), evidence: "亲自打开", reason: "核实" });
  assert.deepEqual([verify.type, verify.expectedVersion, verify.expectedRoleVersion, verify.verifiedCapabilities], ["host.verify", 4, 7, ["open", "read"]]);
});

test("a proposal is built from every field and passes the command schema", () => {
  const values: Record<string, string> = Object.fromEntries(proposalFields.map(field => [field.name, field.value ?? "填写"]));
  Object.assign(values, { inputs: "任务\n设计", writableAssets: "", deliverables: "页面", triggers: "分派", gapKind: "rework", firstTaskId: taskId,
    gapObservedAtUtc: "2026-11-01T00:00:00Z", effectObservedAtUtc: "2026-11-02T00:00:00Z", costObservedAtUtc: "2026-11-03T00:00:00Z",
    trialDays: "14", reviewAtUtc: "2026-11-20T09:00:00+08:00" });
  const proposal = buildProposal(values);
  assert.deepEqual(proposal.inputs, ["任务", "设计"]);
  assert.deepEqual(proposal.writableAssets, []);
  assert.deepEqual(proposal.evidence.map(item => item.kind), ["rework", "effect", "cost"]);
  sent({ type: "role.propose", roleId, proposal });
});
