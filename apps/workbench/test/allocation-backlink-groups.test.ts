import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllocationTrace } from "@evoloop/contracts/allocation-relations";
import { groupAllocationBacklinks, loadedBacklinkSummary } from "../src/discussions/allocationBacklinkGroups.ts";

const discussion = { id: "discussion-a", version: 2, status: "decided" as const, title: "确定职责分工",
  document: { id: "document-a", revisionId: "revision-a" }, latestDecisionEventId: "decision-a" };
const base = { discussion, decisionEventId: "decision-a", decisionDocumentRevisionId: "revision-a",
  decisionIsLatest: true, sources: [] };
const role = { ...base, id: "relation-role", relation: { kind: "decision-target" as const, actionEventId: "action-role",
  target: { kind: "role" as const, id: "role-a", revisionId: "role-revision-a" }, targetStatus: "current" as const } } satisfies AllocationTrace;
const task = { ...base, id: "relation-task", relation: { kind: "decision-target" as const, actionEventId: "action-task",
  target: { kind: "task" as const, id: "task-a", revisionId: "task-revision-a" }, targetStatus: "current" as const } } satisfies AllocationTrace;
const accepted = { ...base, id: "relation-accepted", relation: { kind: "task-recipient" as const, taskActionEventId: "action-task",
  task: { id: "task-a", revisionId: "task-revision-a" }, assignment: { version: 3, target: { kind: "owned" as const, sessionId: "session-a" },
    acceptedAt: "2026-10-26T00:00:00Z", method: "lead-observed" as const, actorId: null, observerActorId: "lead-a" },
  taskRevisionStatus: "current" as const, assignmentStatus: "current" as const } } satisfies AllocationTrace;

test("loaded pages group one discussion while retaining distinct target and acceptance paths", () => {
  const other = { ...role, id: "relation-other", discussion: { ...discussion, id: "discussion-b", title: "另一讨论" } };
  const groups = groupAllocationBacklinks([role, task, other, task, accepted]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.discussion.id, discussion.id);
  assert.deepEqual(groups[0]!.traces.map(trace => trace.id), [role.id, task.id, accepted.id]);
  assert.equal(groups[0]!.traces[0]!.relation.kind, "decision-target");
  assert.equal(groups[0]!.traces[2]!.relation.kind, "task-recipient");
  assert.equal(loadedBacklinkSummary(groups[0]!, true), "已读 3 条关系：2 条正式目标、1 条同修订接受；后续页或来源未读全，非总数");
  assert.equal(loadedBacklinkSummary(groups[0]!, false), "已读 3 条关系：2 条正式目标、1 条同修订接受");
  assert.deepEqual(groups[1]!.traces.map(trace => trace.id), [other.id]);
});

test("a later page can add a path to an existing discussion without inferring Role ownership", () => {
  const firstPage = groupAllocationBacklinks([role]);
  const laterPage = groupAllocationBacklinks([role, accepted]);
  assert.equal(firstPage[0]!.traces.length, 1);
  assert.equal(laterPage[0]!.traces.length, 2);
  assert.equal(laterPage[0]!.traces[1]!.relation.kind, "task-recipient");
  assert.equal(loadedBacklinkSummary(firstPage[0]!, true).includes("非总数"), true);
});
