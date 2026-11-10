// 结果未知的操作: which object a receipt's operation was about, the link there with the way back, and what is said
// while the object is read, when it is not in the project, and when the receipt names only the project.
import assert from "node:assert/strict";
import test from "node:test";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  areaHref, operationsTitle, originArea, originCandidates, originHref, originLinkKind, originText, receiptOrigin, type ReceiptFacts,
} from "../src/features/settings/operationsPresentation.ts";
import { OperationsPage } from "../src/features/settings/OperationsPage.tsx";
import { inboxNavigation, sectionLabels } from "../src/app/shell/spaces.ts";

// Shared parts written for the automatic JSX runtime expect React in scope under this test loader.
Object.assign(globalThis, { React: ReactModule });

const projectId = "10000000-0000-4000-8000-000000000001";
const objectId = "20000000-0000-4000-8000-000000000002";
const receipt = (commandType: string, taskId = objectId): ReceiptFacts => ({ actorId: "lead", projectId, taskId, operationId: "30000000-0000-4000-8000-000000000003", commandType });

test("the page title is the navigation's name for it", () => {
  assert.equal(operationsTitle, sectionLabels.operations);
  assert.equal(operationsTitle, inboxNavigation.find(item => item.section === "operations")?.label);
});

test("the object kind follows from the command type, in the order the receipt keeps IDs", () => {
  assert.deepEqual(originCandidates("task.assignment.set"), ["task"]);
  assert.deepEqual(originCandidates("work.plan.set"), ["task"]);
  assert.deepEqual(originCandidates("reference.git"), ["task"], "a Git source registered from a task names the task");
  assert.deepEqual(originCandidates("reference.formal"), ["task", "document"], "a formal decision names its task, else its document");
  assert.deepEqual(originCandidates("document.payload"), ["document"]);
  assert.deepEqual(originCandidates("discussion.prepare"), ["discussion"], "the discussion is kept before its document");
  assert.deepEqual(originCandidates("stage.propose"), ["goal"], "a proposed stage names its goal first");
  assert.deepEqual(originCandidates("stage.accept"), ["stage"]);
  assert.deepEqual(originCandidates("goal.revise"), ["goal"]);
});

test("a receipt that keeps only the project's ID names an area, or nothing", () => {
  assert.deepEqual(receiptOrigin(receipt("session.message.interrupt", projectId)), { kind: "area", area: "agents" });
  assert.deepEqual(receiptOrigin(receipt("role.propose", projectId)), { kind: "area", area: "roles" });
  assert.deepEqual(receiptOrigin(receipt("reference.git", projectId)), { kind: "area", area: "repository" });
  assert.deepEqual(receiptOrigin(receipt("queue.adopt", projectId)), { kind: "area", area: "runtime" });
  assert.equal(originArea("project.create"), null);
  assert.equal(originText({ kind: "area", area: "agents" }, { state: "reading" }), "回执只记下了项目，没有记下是哪个智能体；可以到智能体核对。");
  assert.match(originText({ kind: "area", area: null }, { state: "reading" }), /无法判断该回到哪里/);
  assert.equal(originLinkKind({ kind: "area", area: "agents" }, { state: "reading" }), null);
  assert.equal(areaHref(projectId, "agents"), `/p/${projectId}/sessions`);
});

test("the link opens the object and carries the way back to this page", () => {
  const back = new URLSearchParams({ return: `/p/${projectId}/operations`, actor: "lead", returnTitle: "结果未知的操作" }).toString();
  assert.equal(originHref(projectId, "task", objectId, "lead"), `/p/${projectId}/tasks/${objectId}?${back}`);
  assert.equal(originHref(projectId, "document", objectId, "lead"), `/p/${projectId}/documents/${objectId}?${back}`);
  assert.equal(originHref(projectId, "goal", objectId, "lead"), `/p/${projectId}/journey?goal=${objectId}&${back}`);
  assert.equal(originHref(projectId, "stage", objectId, "lead"), `/p/${projectId}/journey?stage=${objectId}&${back}`);
  assert.equal(originHref(projectId, "discussion", objectId, "lead"), `/p/${projectId}/discussions?discussion=${objectId}&${back}`);
});

test("what is said follows what reading the object found; a missing object gets no link", () => {
  const origin = receiptOrigin(receipt("reference.formal"));
  assert.equal(originText(origin, { state: "reading" }), "原操作所在：任务或文档（名称正在读取）");
  assert.equal(originText(origin, { state: "found", kind: "document", name: "接口说明" }), "原操作所在：文档 · 接口说明");
  assert.equal(originLinkKind(origin, { state: "found", kind: "document", name: "接口说明" }), "document");
  assert.match(originText(origin, { state: "missing" }), /^在本项目里读不到这个任务或文档。如果原操作是新建，它可能还没有建立/);
  assert.equal(originLinkKind(origin, { state: "missing" }), null);
  assert.equal(originText(origin, { state: "failed", reason: "连接中断" }), "原操作所在的任务或文档暂时读不到（连接中断），无法判断它现在的状态。");
  assert.equal(originLinkKind(origin, { state: "failed", reason: "x" }), "task", "an unreadable object may still be there: the likeliest link stays");
  assert.doesNotMatch(originText(origin, { state: "found", kind: "task", name: "t" }), /[0-9a-f]{8}-/, "no identifier in the reading text");
});

test("the page shows each receipt it is handed, with that receipt's own object, beside its check card", () => {
  const documentId = "40000000-0000-4000-8000-000000000004";
  const items = [
    { receipt: { ...receipt("document.revise", documentId), operationId: "50000000-0000-4000-8000-000000000005" },
      check: createElement("section", { "data-check": "first" }, "第一张核对卡") },
    { receipt: { ...receipt("session.message.interrupt", projectId), operationId: "60000000-0000-4000-8000-000000000006" },
      check: createElement("section", { "data-check": "second" }, "第二张核对卡") },
  ];
  // Rendered once on the server: the object's name is not read yet, so each row says it is being read.
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(OperationsPage, { projectId, items })));
  const rows = [...html.matchAll(/data-receipt-origin="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(rows, items.map(item => item.receipt.operationId), "one row per receipt, in the order handed in");
  assert.ok(html.indexOf("第一张核对卡") < html.indexOf(`data-receipt-origin="${items[0]!.receipt.operationId}"`), "the row follows its own card");
  assert.ok(html.indexOf("第二张核对卡") < html.indexOf(`data-receipt-origin="${items[1]!.receipt.operationId}"`));
  assert.match(html, /原操作所在：文档（名称正在读取）/);
  const back = new URLSearchParams({ return: `/p/${projectId}/operations`, actor: "lead", returnTitle: "结果未知的操作" }).toString().replaceAll("&", "&amp;");
  assert.ok(html.includes(`href="/p/${projectId}/documents/${documentId}?${back}"`), "the link opens the receipt's own object, for its identity");
  assert.match(html, /回执只记下了项目，没有记下是哪个智能体；可以到智能体核对。/);
  assert.ok(html.includes(`href="/p/${projectId}/sessions"`));
  assert.doesNotMatch(html, /没有结果未知的操作/);
});

test("with no receipt handed in, the page says so without claiming the project has none", () => {
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(OperationsPage, { projectId, items: [] })));
  assert.match(html, /没有结果未知的操作/);
  assert.match(html, /不代表项目里没有结果未知的事/);
  assert.doesNotMatch(html, /data-receipt-origin/);
});
