// The component sample page (/ui) renders every section on fake data, inside the data-ui isolation scope.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UiSamplesPage from "../src/app/ui-samples/UiSamplesPage.tsx";
import { sampleAgents, sampleTasks } from "../src/shared/fixtures/index.ts";

test("the sample page renders all sections inside the data-ui scope", () => {
  const markup = renderToStaticMarkup(createElement(UiSamplesPage));
  assert.match(markup, /^<div data-ui=""/);
  for (const title of ["按钮与输入", "状态", "空、加载、失败与未知", "列表、折叠与页签", "头像与标志"]) assert.ok(markup.includes(`>${title}<`), title);
  for (const task of sampleTasks) assert.ok(markup.includes(task.title), task.title);
  assert.ok(markup.includes("返回工作台"));
});

test("fake agents point at known roles and every task owner exists", () => {
  const ids = new Set(sampleAgents.map(agent => agent.id));
  for (const task of sampleTasks) if (task.ownerId) assert.ok(ids.has(task.ownerId), `${task.title} owner`);
});
