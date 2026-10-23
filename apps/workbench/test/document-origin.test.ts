import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskRevision } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { verifiedOriginRun, verifiedOriginTask } from "../src/documents/originValidation.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const taskRevisionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const documentId = "55555555-5555-4555-8555-555555555555";
const documentRevisionId = "66666666-6666-4666-8666-666666666666";
const origin = { taskId, taskRevisionId, runId };

test("a source title is trusted only from the recorded Task revision, never its current head", () => {
  const fixed = { projectId, taskId, id: taskRevisionId, title: "原始问题任务", version: 2 } as TaskRevision;
  assert.equal(verifiedOriginTask(projectId, origin, fixed), fixed);
  assert.equal(verifiedOriginTask(projectId, origin, { ...fixed, id: runId, title: "当前任务标题" }), null);
  assert.equal(verifiedOriginTask(projectId, origin, { ...fixed, taskId: documentId }), null);
  assert.equal(verifiedOriginTask(projectId, origin, { ...fixed, projectId: documentId }), null);
});

test("Run entry is available only for the same project, Task, fixed revision and recorded Run", () => {
  const run = { projectId, id: runId, taskId, taskRevisionId, state: "completed" } as RuntimeRunRecord;
  assert.equal(verifiedOriginRun(projectId, origin, run), run);
  for (const wrong of [{ id: documentId }, { projectId: documentId }, { taskId: documentId }, { taskRevisionId: documentRevisionId }]) {
    assert.equal(verifiedOriginRun(projectId, origin, { ...run, ...wrong }), null);
  }
  assert.equal(verifiedOriginRun(projectId, { ...origin, runId: null }, run), null);
});
