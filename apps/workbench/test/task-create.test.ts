// 新建任务: the one task.create command a draft becomes, field by field against the two earlier forms on main
// (CreateTaskPage and JourneyBoard's 建立任务), and what the form asks to fix before sending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSchema } from "@evoloop/contracts";
import { draftFieldLabels, emptyTaskDraft, hiddenFields, taskCreateCommand, taskDraftProblems, zonedInstant, type TaskDraft } from "../src/features/workflow/taskCreate.ts";

const taskId = "41000001-0000-4000-8000-000000000001";
const roleId = "41000002-0000-4000-8000-000000000002";
const stageId = "41000003-0000-4000-8000-000000000003";
const documentId = "41000004-0000-4000-8000-000000000004";
const draft = (patch: Partial<TaskDraft>): TaskDraft => ({ ...emptyTaskDraft("Asia/Taipei"), title: "整理验收清单", why: "上次验收漏了截图。",
  outcome: "一份可复用的验收清单", acceptance: "另一位智能体按清单独立核对", owner: roleId, ...patch });
const parse = (command: Record<string, unknown>) =>
  commandSchema.parse({ ...command, projectId: "41000000-0000-4000-8000-000000000000", operationId: "41000005-0000-4000-8000-000000000005" });

test("the create page's fields: content with 期望结果, acceptance mode, use required, consumer, timing, evidence and stop condition", () => {
  // main CreateTaskPage built: { type, taskId, title, kind: v.kind || null, content: `${content}\n\n期望结果\n${outcome}`, acceptance, owner,
  // acceptanceMode, useRequired: true, consumer?, timing?: { executeAtUtc, timezone, repeat }, evidence?, stopCondition? }.
  const command = taskCreateCommand(draft({ consumer: "  reviewer-actor  ", executeAt: "2026-11-12T09:30", repeat: "daily",
    kind: "validation", evidence: " 上次验收记录 ", stopCondition: " 清单超过一页 " }), taskId);
  assert.deepEqual(command, {
    type: "task.create", taskId, title: "整理验收清单", kind: "validation",
    content: "上次验收漏了截图。\n\n期望结果\n一份可复用的验收清单", acceptance: "另一位智能体按清单独立核对", owner: roleId,
    acceptanceMode: "independent_agent", useRequired: true, consumer: "reviewer-actor",
    timing: { executeAtUtc: "2026-11-12T01:30:00.000Z", timezone: "Asia/Taipei", repeat: "daily" },
    evidence: "上次验收记录", stopCondition: "清单超过一页",
  });
  assert.equal(parse(command).type, "task.create");
});

test("optional fields are left out when empty, as main's create page did; kind falls back to null", () => {
  const command = taskCreateCommand(draft({ acceptanceMode: "human_required", consumer: "owner-actor" }), taskId);
  assert.deepEqual(command, {
    type: "task.create", taskId, title: "整理验收清单", kind: null,
    content: "上次验收漏了截图。\n\n期望结果\n一份可复用的验收清单", acceptance: "另一位智能体按清单独立核对", owner: roleId,
    acceptanceMode: "human_required", useRequired: true, consumer: "owner-actor",
  });
  const once = taskCreateCommand(draft({ executeAt: "2026-11-12T09:30", repeat: "none" }), taskId);
  assert.deepEqual(once.timing, { executeAtUtc: "2026-11-12T01:30:00.000Z", timezone: "Asia/Taipei", repeat: "none" });
  parse(once);
});

test("the journey form's fields: stage, linked published documents, consumer, evidence and stop condition", () => {
  // main JourneyBoard built: { type, taskId, title, content, acceptance, owner, kind: v.kind || null, documentIds, stageId?, consumer?,
  // useRequired, evidence?, stopCondition? }. The new form always names the acceptance mode (the service's default) and sends
  // documentIds only when some are chosen (the service reads a missing list as empty).
  const command = taskCreateCommand(draft({ stageId, documentIds: [documentId], consumer: "user-actor", evidence: "用户反馈", stopCondition: "反馈消失", kind: "research" }), taskId);
  assert.deepEqual(command, {
    type: "task.create", taskId, title: "整理验收清单", kind: "research",
    content: "上次验收漏了截图。\n\n期望结果\n一份可复用的验收清单", acceptance: "另一位智能体按清单独立核对", owner: roleId,
    acceptanceMode: "independent_agent", useRequired: true, consumer: "user-actor", stageId, documentIds: [documentId],
    evidence: "用户反馈", stopCondition: "反馈消失",
  });
  parse(command);
});

test("a decision-only task can be saved: nothing hidden is asked for, useRequired is false, and the owner is the consumer", () => {
  // The form hides 验收方式 and 使用成果的身份 here; the service accepts useRequired false only when consumer === owner.
  const decision = draft({ closeRule: "decision", stageId, kind: "research", evidence: "证据", stopCondition: "停止" });
  assert.deepEqual(taskDraftProblems(decision, { canReview: true }), {});
  const command = taskCreateCommand(decision, taskId);
  assert.equal(command.useRequired, false);
  assert.equal("acceptanceMode" in command, false);
  assert.equal(command.consumer, roleId);
  assert.equal(command.stageId, stageId);
  parse(command);
});

test("a problem is never reported for a field the form hides", () => {
  const drafts = [draft({ closeRule: "decision" }), draft({ closeRule: "decision", stageId, acceptanceMode: "human_required" }),
    { ...emptyTaskDraft("Asia/Taipei"), closeRule: "decision" as const, stageId, repeat: "daily" as const }];
  for (const candidate of drafts) {
    const hidden = hiddenFields(candidate);
    assert.deepEqual(hidden.sort(), ["acceptanceMode", "consumer"]);
    for (const key of Object.keys(taskDraftProblems(candidate, { canReview: false }))) assert.equal(hidden.includes(key as keyof TaskDraft), false, key);
  }
  assert.deepEqual(hiddenFields(draft({})), []);
  for (const key of Object.keys(emptyTaskDraft()) as (keyof TaskDraft)[]) assert.ok(draftFieldLabels[key], key);
});

test("the draft names each missing or contradictory field before anything is sent", () => {
  assert.deepEqual(Object.keys(taskDraftProblems(emptyTaskDraft("Asia/Taipei"), { canReview: true })).sort(), ["acceptance", "outcome", "owner", "title", "why"]);
  assert.deepEqual(taskDraftProblems(draft({}), { canReview: false }), {});
  assert.deepEqual(Object.keys(taskDraftProblems(draft({ stageId }), { canReview: true })).sort(), ["consumer", "evidence", "stopCondition"]);
  assert.match(taskDraftProblems(draft({ acceptanceMode: "human_required" }), { canReview: true }).consumer ?? "", /本人验收/);
  const daily = taskDraftProblems(draft({ repeat: "daily" }), { canReview: false });
  assert.match(daily.repeat ?? "", /审阅权限/);
  assert.match(daily.executeAt ?? "", /首次执行时间/);
  const decision = taskDraftProblems(draft({ closeRule: "decision" }), { canReview: true });
  assert.ok(decision.stageId && decision.kind);
  assert.match(taskDraftProblems(draft({ executeAt: "2026-02-31T09:00" }), { canReview: true }).executeAt ?? "", /无效/);
  assert.match(taskDraftProblems(draft({ executeAt: "2026-11-12T09:00", timezone: "Mars/Base" }), { canReview: true }).executeAt ?? "", /IANA/);
  assert.ok(taskDraftProblems(draft({ documentIds: Array.from({ length: 21 }, (_, n) => `41000010-0000-4000-8000-${String(n).padStart(12, "0")}`) }), { canReview: true }).documentIds);
});

test("a local time in an IANA zone becomes the UTC instant the service stores", () => {
  assert.equal(zonedInstant("2026-11-07T08:00", "Asia/Taipei"), "2026-11-07T00:00:00.000Z");
  assert.equal(zonedInstant("2026-07-01T09:15", "America/New_York"), "2026-07-01T13:15:00.000Z");
  assert.equal(zonedInstant("2026-12-01T09:15", "America/New_York"), "2026-12-01T14:15:00.000Z");
  assert.throws(() => zonedInstant("2026-03-08T02:30", "America/New_York"), /夏令时/);
  assert.throws(() => zonedInstant("2026-11-07", "Asia/Taipei"));
  assert.throws(() => zonedInstant("2026-11-07T08:00", "Nowhere/Zone"));
});
