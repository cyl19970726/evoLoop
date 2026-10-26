import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail } from "@evoloop/contracts";
import type { MutationContext } from "../src/workflow/ActionForm.tsx";
import { TaskWorkflow } from "../src/workflow/TaskWorkflow.tsx";

const owner = "10000002-0000-4000-8000-000000000002";
const task = { projectId: "10000001-0000-4000-8000-000000000001", id: "10000003-0000-4000-8000-000000000003",
  version: 2, currentRevisionId: "10000004-0000-4000-8000-000000000004", title: "保留原任务编辑", kind: "implementation",
  content: "已写正文", acceptance: "独立验收", owner, state: "todo" };
const detail = { task, revision: { id: task.currentRevisionId }, basis: null, links: [], impacts: [], deliveries: [], observations: [], closures: [] } as unknown as TaskDetail;
const context = { token: "fixture", projectId: task.projectId,
  principal: { actorId: "editor", projectIds: [task.projectId], permissions: ["read", "write"] }, blocked: false,
  onAttempt: () => true, onKnown: () => {}, onChanged: () => {}, draftScope: `task:${task.id}`, draftBaseline: task.currentRevisionId } as MutationContext;

test("Task edit remains available while the Role directory is loading or unavailable", () => {
  const html = renderToStaticMarkup(createElement(TaskWorkflow, { context, detail, mode: "actions" }));
  assert.match(html, /更新任务内容/);
  assert.match(html, /name="content"/);
  assert.match(html, /name="acceptance"/);
  assert.match(html, /当前负责者（职责目录待核对）/);
  assert.match(html, new RegExp(`value="${owner}"`));
});
