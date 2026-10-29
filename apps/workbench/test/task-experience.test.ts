import test from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { assignmentSessionKey, currentDelivery, executionSummary, isMyCurrentWork, matchingProjection, taskListRoute, taskListView } from "../src/workflow/taskExperience.ts";

const work = (overrides: Partial<LeaderWorkTask> = {}) => ({ taskId: "task", version: 2, currentRevisionId: "rev2", taskState: "in_progress",
  assignment: { state: "accepted", targetKind: "external", targetId: "session", recipientActorId: "me" }, latestRun: null,
  ...overrides }) as LeaderWorkTask;
test("my current work uses the verified recipient, never a Role, consumer or released assignment", () => {
  assert.equal(isMyCurrentWork(work(), "me"), true);
  assert.equal(isMyCurrentWork(work(), "other"), false);
  assert.equal(isMyCurrentWork(work({ assignment: null }), "me"), false);
  assert.equal(isMyCurrentWork(work({ taskState: "done" }), "me"), false);
  assert.equal(isMyCurrentWork(work({ assignment: { ...work().assignment!, state: "released" } }), "me"), false);
  assert.equal(isMyCurrentWork(work({ assignment: { ...work().assignment!, state: "assigned" } }), "me"), true);
});
test("assignment remains the concrete Session when next responsibility moves to the consumer", () => {
  assert.equal(assignmentSessionKey(work({ responsible: { kind: "consumer", id: "consumer", label: "consumer" } })), "external:session");
  assert.equal(assignmentSessionKey(work({ assignment: { ...work().assignment!, state: "released" } })), null);
});
test("accepted and assigned are distinct from running; external absence of Run is unknown", () => {
  assert.equal(executionSummary(work()), "外部运行状态未知");
  assert.equal(executionSummary(work({ assignment: { ...work().assignment!, targetKind: "owned" } })), "已接手，尚无当前 Run");
  assert.equal(executionSummary(work({ assignment: { ...work().assignment!, targetKind: "owned", state: "assigned" } })), "待接受，尚无当前 Run");
  assert.equal(executionSummary(work({ latestRun: { runId: "run", state: "unknown" } })), "Run · 结果未知");
});
test("old successful delivery cannot stand in for the current revision", () => {
  const detail = { task: { currentRevisionId: "rev2" }, deliveries: [
    { id: "old-passed", taskRevisionId: "rev1" }, { id: "current-failed", taskRevisionId: "rev2" },
    { id: "old-late", taskRevisionId: "rev1" },
  ] } as unknown as TaskDetail;
  assert.equal(currentDelivery(detail)?.id, "current-failed");
  assert.equal(currentDelivery({ ...detail, task: { currentRevisionId: "new-revision" } as Task }), undefined);
});
test("current completion and projection must match task version and revision", () => {
  const task = { id: "task", version: 2, currentRevisionId: "rev2" };
  assert.equal(matchingProjection(task, work({ taskState: "done", latestRun: { runId: "old-failed", state: "failed" } }))?.taskState, "done");
  assert.equal(matchingProjection(task, work({ version: 1 })), undefined);
  assert.equal(matchingProjection(task, work({ currentRevisionId: "rev1" })), undefined);
});
test("filters and selected row survive a URL round trip, including long and non-ASCII titles", () => {
  const value = { query: "很长的任务 / & 结果?", filter: "done", kind: "validation", scope: "mine", selected: "task" };
  assert.deepEqual(taskListView(taskListRoute("project", value)), value);
  assert.deepEqual(taskListView("#/p/project/work"), { query: "", filter: "open", kind: "all", scope: "all", selected: "" });
});
test("done tasks keep the exact closure-bound delivery, while reopened tasks cannot reuse it", () => {
  const detail = { task: { state: "done", currentRevisionId: "closed-rev" },
    closures: [{ taskRevisionId: "closed-rev", deliveryId: "accepted" }],
    deliveries: [{ id: "accepted", taskRevisionId: "executed-rev" }, { id: "unrelated-later", taskRevisionId: "other-rev" }],
  } as unknown as TaskDetail;
  assert.equal(currentDelivery(detail)?.id, "accepted");
  assert.equal(currentDelivery({ ...detail, task: { state: "in_progress", currentRevisionId: "reopened-rev" } as Task }), undefined);
});

test("closed assignments retain their Session link but are never labelled current acceptance or execution", async () => {
  const { assignmentStatusLabel } = await import("../src/workflow/taskExperience.ts");
  for (const taskState of ["done", "cancelled"] as const) {
    const closed = work({ taskState });
    assert.equal(assignmentSessionKey(closed), "external:session", "retain the evidence entry");
    assert.equal(assignmentStatusLabel(closed), "历史承接 · 当时已接受");
    assert.equal(isMyCurrentWork(closed, "me"), false);
    assert.match(executionSummary(closed), /历史 Run/);
    assert.doesNotMatch(executionSummary(closed), /已接手|外部运行状态未知/);
    assert.match(executionSummary(work({ ...closed, latestRun: { runId: "old", state: "running" } })), /历史 Run：运行中/);
  }
  assert.equal(assignmentStatusLabel(work()), "已接受");
});

test("the first render after a selection change rejects the previous Task or project before effects", async () => {
  const { matchingTaskDetail } = await import("../src/workflow/taskExperience.ts");
  const loadedA = { task: { id: "A", projectId: "project-one", title: "A facts" }, deliveries: [] } as unknown as TaskDetail;
  assert.equal(matchingTaskDetail(loadedA, "project-one", "A"), loadedA);
  assert.equal(matchingTaskDetail(loadedA, "project-one", "B"), null, "A body cannot appear beside the B link");
  assert.equal(matchingTaskDetail(loadedA, "project-two", "A"), null, "same Task id in a different project is not the same selection");
  assert.equal(matchingTaskDetail(null, "project-one", "B"), null);
});
