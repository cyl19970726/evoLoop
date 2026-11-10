// 结果未知的操作: which object a receipt's operation was about, the link there with the way back, and what is said
// while the object is read, when it is not in the project, and when the receipt names only the project.
import assert from "node:assert/strict";
import test from "node:test";
import { Fragment, Suspense, createElement } from "react";
import {
  areaHref, operationsTitle, originArea, originCandidates, originHref, originLinkKind, originText, receiptOf, receiptOrigin, type ReceiptFacts,
} from "../src/features/settings/operationsPresentation.ts";
import { inboxNavigation, sectionLabels } from "../src/app/shell/spaces.ts";

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

test("the receipt is found on the check the page is handed, inside its wrapper", () => {
  const facts = receipt("task.update");
  const Check = (_: { receipt: ReceiptFacts }) => null;
  assert.deepEqual(receiptOf(createElement(Suspense, { key: facts.operationId, fallback: null }, createElement(Check, { receipt: facts }))), facts);
  assert.deepEqual(receiptOf(createElement(Check, { receipt: facts })), facts);
  assert.deepEqual(receiptOf(createElement(Fragment, null, "text", createElement(Check, { receipt: facts }))), facts);
  assert.equal(receiptOf(createElement(Check, { receipt: { ...facts, operationId: "" } })), null, "an incomplete receipt is not taken");
  assert.equal(receiptOf("plain text"), null);
});
