// 跨空间返回: which pages a link may come back to, how the way back is named, and that it survives tab changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReturnLink } from "../src/shared/ui/ReturnLink.tsx";
import { originHref } from "../src/features/settings/operationsPresentation.ts";
import { hereOrigin, readReturn, returnPlaceOf, returnSource, returnText, withReturn } from "../src/shared/returnLink.ts";
import { taskSessionReturn, taskTabHref } from "../src/shared/taskNavigation.ts";
import { sessionTaskReturn } from "../src/features/sessions/sessionReturn.ts";
import { documentReturnPlace } from "../src/features/documents/documentPresentation.ts";
import { tableOrigin, taskOrigin } from "../src/features/workflow/taskOrigin.ts";

const project = "96000001-0000-4000-8000-000000000001";
const task = "96000002-0000-4000-8000-000000000002";
const other = "96000003-0000-4000-8000-000000000003";
const agent = "owned:96000004-0000-4000-8000-000000000004";
const p = `/p/${project}`;

test("only pages of this project are places to come back to", () => {
  assert.deepEqual(returnPlaceOf(`${p}/tasks/${task}?tab=runtime`, project), { kind: "task", taskId: task });
  assert.deepEqual(returnPlaceOf(`${p}/work?state=all&selected=${task}`, project), { kind: "tasks", selected: task });
  assert.deepEqual(returnPlaceOf(`${p}/work`, project), { kind: "tasks", selected: null });
  assert.deepEqual(returnPlaceOf(`${p}/sessions`, project), { kind: "arrangement" }, "/sessions without an agent is 统筹安排");
  assert.deepEqual(returnPlaceOf(`${p}/sessions?session=${encodeURIComponent(agent)}&tab=queue`, project), { kind: "agent", sessionKey: agent });
  assert.deepEqual(returnPlaceOf(`${p}/runtime?session=${encodeURIComponent(agent)}`, project), { kind: "agent", sessionKey: agent }, "an older agent link");
  assert.deepEqual(returnPlaceOf(`${p}/runtime?session=${task}`, project), { kind: "page", section: "runtime" }, "a managed agent in 分工与运行 stays there");
  assert.deepEqual(returnPlaceOf(`${p}/documents/${task}?revision=${other}`, project), { kind: "document", documentId: task });
  assert.deepEqual(returnPlaceOf(`${p}/overview`, project), { kind: "page", section: "overview" });
  for (const bad of [`/p/${other}/tasks/${task}`, `${p}/tasks/not-a-task`, `${p}/sessions?session=garbage`, `${p}/unknown`,
    `https://example.test${p}/work`, `${p}/work?x=1?y=2`, `${p}/work#top`, `${p}/tasks/new`, null])
    assert.equal(returnPlaceOf(bad, project), null, String(bad));
});

test("the way back says where it goes and names it once, without nested brackets", () => {
  assert.equal(returnText({ kind: "task", taskId: task }, "【合成示例】右栏信息核对"), "返回任务：【合成示例】右栏信息核对");
  assert.equal(returnText({ kind: "agent", sessionKey: agent }, "【合成示例】前端开发"), "返回智能体：【合成示例】前端开发");
  assert.equal(returnText({ kind: "task", taskId: task }, null), "返回任务", "no name yet: no guessed name");
  assert.equal(returnText({ kind: "agent", sessionKey: agent }, " "), "返回智能体");
  assert.equal(returnText({ kind: "arrangement" }, "anything"), "返回统筹安排");
  assert.equal(returnText({ kind: "tasks", selected: task }, "任务甲"), "返回任务：任务甲");
  assert.equal(returnText({ kind: "tasks", selected: null }, "任务甲"), "返回任务列表");
  assert.equal(returnText({ kind: "document", documentId: task }, "需求总图"), "返回文档：需求总图");
  assert.equal(returnText({ kind: "page", section: "documents" }), "返回文档列表");
  assert.equal(returnText({ kind: "page", section: "overview" }), "返回总览");
  // A schedule is named (N2): “返回日程：<名称>”; without its name, “返回日程”.
  assert.equal(returnText({ kind: "page", section: "schedules" }, "季度巡检"), "返回日程：季度巡检");
  assert.equal(returnText({ kind: "page", section: "schedules" }), "返回日程");
  assert.doesNotMatch(returnText({ kind: "task", taskId: task }, "x".repeat(200)), /x{81}/, "a long name is cut at 80 characters");
});

test("a link carries the way back for its reader; the page reads it only for that reader", () => {
  const from = { href: `${p}/tasks/${task}?tab=runtime&return=${encodeURIComponent(`${p}/sessions`)}&actor=me&returnTitle=x`, actorId: "me", title: "任务甲" };
  const link = withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, from);
  const params = new URLSearchParams(link.split("?")[1]);
  assert.equal(params.get("session"), agent);
  assert.equal(params.get("return"), `${p}/tasks/${task}?tab=runtime`, "the source's own way back is dropped, so links never nest");
  assert.equal(params.get("actor"), "me");
  assert.equal(params.get("returnTitle"), "任务甲");
  assert.equal(withReturn("/x", null), "/x", "without a reader the link stays plain");
  assert.deepEqual(readReturn(link, project, "me"), { href: `${p}/tasks/${task}?tab=runtime`, place: { kind: "task", taskId: task },
    title: "任务甲", label: "返回任务：任务甲" });
  assert.equal(readReturn(link, project, "someone-else"), null, "the way back belongs to the reader the link was made for");
  assert.equal(readReturn(link, other, "me"), null, "only this project");
  assert.equal(readReturn(`${link}&return=${encodeURIComponent(`${p}/work`)}`, project, "me"), null, "one way back only");
  assert.equal(returnSource(`${p}/work?state=all&return=x&actor=me&returnTitle=t`), `${p}/work?state=all`);
  assert.deepEqual(hereOrigin("me", `${p}/runtime`), { href: `${p}/runtime`, actorId: "me" });
});

test("an agent page comes back to a task, the task table or 统筹安排, never to itself", () => {
  const open = (from: string, title?: string) => withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, { href: from, actorId: "me", title: title ?? null });
  assert.equal(sessionTaskReturn(open(`${p}/tasks/${task}?tab=runtime`, "任务甲"), project, agent, "me")?.label, "返回任务：任务甲");
  assert.equal(sessionTaskReturn(open(`${p}/work?selected=${task}`, "任务甲"), project, agent, "me")?.href, `${p}/work?selected=${task}`);
  assert.equal(sessionTaskReturn(open(`${p}/sessions`), project, agent, "me")?.label, "返回统筹安排");
  assert.equal(sessionTaskReturn(open(`${p}/sessions?session=${encodeURIComponent(agent)}`), project, agent, "me"), null);
  assert.equal(sessionTaskReturn(open(`${p}/tasks/${task}`), project, "owned:other", "me"), null, "a link made for another agent");
});

test("a task page comes back to an agent, 统筹安排 or a document, and keeps it across its tabs", () => {
  const taskPath = `${p}/tasks/${task}`;
  const fromArrangement = withReturn(taskPath, { href: `${p}/sessions`, actorId: "me" });
  assert.equal(taskSessionReturn(fromArrangement, project, task, "me")?.label, "返回统筹安排");
  const fromAgent = withReturn(taskPath, { href: `${p}/sessions?session=${encodeURIComponent(agent)}`, actorId: "me" });
  assert.equal(taskSessionReturn(fromAgent, project, task, "me")?.label, "返回智能体", "without a name the agent page's link names the place only");
  const fromDocument = withReturn(taskPath, { href: `${p}/documents/${other}`, actorId: "me", title: "需求总图" });
  assert.equal(taskSessionReturn(fromDocument, project, task, "me")?.label, "返回文档：需求总图");
  const fromInbox = `${taskPath}?${new URLSearchParams({ tab: "delivery", return: `${p}/inbox`, actor: "me", returnTitle: "待我验收与判断" })}`;
  assert.equal(taskSessionReturn(fromInbox, project, task, "me")?.label, "返回待我验收与判断", "the link 待我处理 writes (inboxModel.deliveryLink)");
  assert.equal(taskSessionReturn(withReturn(taskPath, { href: taskPath, actorId: "me" }), project, task, "me"), null, "never to itself");
  const next = new URLSearchParams(taskTabHref(fromArrangement, project, task, "runtime", "me").split("?")[1]);
  assert.equal(next.get("return"), `${p}/sessions`);
  assert.equal(next.get("returnTitle"), null, "no name is invented for a page without one");
});

test("links out of a task come back to the address on screen: its tab, or the table with its row", () => {
  assert.deepEqual(taskOrigin(project, { id: task, title: "任务甲" }, "me", `/p/${project}/tasks/${task}?tab=runtime`),
    { href: `/p/${project}/tasks/${task}?tab=runtime`, title: "任务甲", actorId: "me" });
  assert.deepEqual(taskOrigin(project, { id: task, title: "任务甲" }, "me", `/p/${project}/work?selected=${task}`).href, `/p/${project}/work?selected=${task}`);
  assert.equal(taskOrigin(project, { id: task }, "me", `/p/${project}/overview`).href, `/p/${project}/tasks/${task}`, "another page on screen: the task itself");
  assert.equal(tableOrigin(project, "me", `/p/${project}/work?state=all`).href, `/p/${project}/work?state=all`);
});

test("a link in a table row is named after that row, never after the row that happens to be selected", () => {
  const agentLink = (from: ReturnType<typeof tableOrigin>) => withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, from);
  const onScreen = `${p}/work?state=all&selected=${task}`;
  // Row B's agent while row A is selected: back to the table with B selected, named B.
  const rowB = readReturn(agentLink(tableOrigin(project, "me", onScreen, { id: other, title: "任务乙" })), project, "me")!;
  assert.equal(rowB.label, "返回任务：任务乙");
  assert.equal(rowB.href, `${p}/work?state=all&selected=${other}`, "the filter stays, the row comes along");
  // A link that belongs to no row (an agent in 阶段与验收容量): the list, not the selected row.
  const noRow = readReturn(agentLink(tableOrigin(project, "me", onScreen)), project, "me")!;
  assert.equal(noRow.label, "返回任务列表");
  assert.equal(noRow.href, onScreen);
});

test("the return link on screen says exactly what readReturn says for the same link", () => {
  Object.assign(globalThis, { React: ReactModule });
  const links = [
    withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, tableOrigin(project, "me", `${p}/work?selected=${task}`, { id: other, title: "任务乙" })),
    withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, tableOrigin(project, "me", `${p}/work?selected=${task}`)),
    withReturn(`${p}/sessions?session=${encodeURIComponent(agent)}`, { href: `${p}/tasks/${task}`, actorId: "me" }),
    withReturn(`${p}/tasks/${task}`, { href: `${p}/sessions`, actorId: "me" }),
  ];
  for (const link of links) {
    const source = readReturn(link, project, "me")!;
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(ReturnLink, { projectId: project, href: source.href, place: source.place, label: source.label })));
    assert.equal(html.replace(/<[^>]+>/g, ""), source.label, link);
  }
});

test("“结果未知的操作” opens a task with its way back, and the task page names it", () => {
  const link = originHref(project, "task", task, "me");
  assert.equal(taskSessionReturn(link, project, task, "me")?.label, "返回结果未知的操作");
  assert.equal(taskSessionReturn(link, project, task, "me")?.href, `${p}/operations`);
});

test("the document page names where its way back goes, and falls back to the list", () => {
  assert.deepEqual(documentReturnPlace(`${p}/tasks/${task}?tab=delivery`, project), { href: `${p}/tasks/${task}?tab=delivery`, place: { kind: "task", taskId: task } });
  assert.deepEqual(documentReturnPlace(`${p}/sessions?session=${encodeURIComponent(agent)}&tab=results`, project).place, { kind: "agent", sessionKey: agent });
  assert.deepEqual(documentReturnPlace("/", project), { href: `${p}/documents`, place: { kind: "page", section: "documents" } });
});
