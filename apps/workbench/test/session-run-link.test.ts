import assert from "node:assert/strict";
import { test } from "node:test";
import { taskRunFromHash, taskSectionFromHash, taskSectionHref } from "../src/orchestration/navigation.ts";
import { observedRunTaskLink, taskRunLink } from "../src/sessions/taskRunLink.ts";

test("Session's recent Run opens its Task runtime and retains the Session return", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const returnRoute = `#/p/${projectId}/runtime?session=owned%3Acurrent&tab=queue&filter=all`;
  const params = new URLSearchParams({ return: returnRoute, actor: "reader", returnTitle: "当前 Session" });
  const taskHref = `${taskSectionHref(projectId, taskId)}?${params}`;

  const link = taskRunLink(taskHref, runId);
  const query = new URLSearchParams(link.split("?")[1]);
  assert.equal(taskSectionFromHash(link, projectId, taskId), "runtime");
  assert.equal(taskRunFromHash(link, projectId, taskId), runId);
  assert.equal(taskRunFromHash(link, projectId, "other-task"), null);
  assert.equal(query.get("return"), returnRoute);
  assert.equal(query.get("actor"), "reader");
  assert.equal(query.get("returnTitle"), "当前 Session");
});

test("failed Run uses its own recorded Task, and missing association cannot create a direct link", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const currentTaskId = "22222222-2222-4222-8222-222222222222";
  const runTaskId = "44444444-4444-4444-8444-444444444444";
  const runId = "33333333-3333-4333-8333-333333333333";
  const returnRoute = `#/p/${projectId}/runtime?session=owned%3A55555555-5555-4555-8555-555555555555&tab=queue`;
  const visitedTasks: string[] = [];
  const taskHref = (taskId: string) => {
    visitedTasks.push(taskId);
    return `${taskSectionHref(projectId, taskId)}?${new URLSearchParams({ return: returnRoute, actor: "reader", returnTitle: "原 Session" })}`;
  };
  const link = observedRunTaskLink({ id: runId, taskId: runTaskId }, taskHref);

  assert.ok(link);
  assert.equal(taskSectionFromHash(link, projectId, runTaskId), "runtime");
  assert.equal(taskRunFromHash(link, projectId, runTaskId), runId);
  assert.equal(taskRunFromHash(link, projectId, currentTaskId), null);
  assert.equal(new URLSearchParams(link.split("?")[1]).get("return"), returnRoute);
  assert.equal(observedRunTaskLink({ id: runId, taskId: null }, taskHref), null);
  assert.equal(observedRunTaskLink({ id: runId, taskId: "" }, taskHref), null);
  assert.equal(observedRunTaskLink({ id: runId, taskId: "unverified" }, taskHref), null);
  assert.deepEqual(visitedTasks, [runTaskId], "missing association must not route through the current Task");
});
