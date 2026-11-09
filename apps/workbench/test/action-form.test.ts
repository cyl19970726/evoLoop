// ActionForm keeps its field-list interface on top of the one command form (shared/command). These pin what the old
// ActionForm did and the new one must keep: every field type and default, the permission gate, the disclosure, kept
// drafts with their baseline, the copyable draft text, and the parts of the command that are checked before sending.
// Sending, receipts and unknown results are useCommand's (use-command.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Permission } from "@evoloop/contracts";
import {
  ActionForm, actionBaseline, clearCommandDrafts, commandDrafts, option, readableDraft, reasonField, toFormField, type ActionFormProps, type Field, type MutationContext,
} from "../src/shared/ActionForm.tsx";
import { draftKeyFor, initialValues, missingFields } from "../src/shared/command/index.ts";

const projectId = "20000001-0000-4000-8000-000000000001";
const context = (patch: Partial<MutationContext> = {}, permissions: Permission[] = ["read", "write", "review"]): MutationContext => ({
  token: "", projectId, blocked: false, principal: { actorId: "writer", projectIds: [projectId], permissions } as MutationContext["principal"],
  onAttempt: () => true, onKnown: () => undefined, onChanged: () => undefined, ...patch,
});
const render = (props: Partial<ActionFormProps> & Pick<ActionFormProps, "context">) =>
  renderToStaticMarkup(createElement(ActionForm, { title: "保存日程修订", fields: [reasonField], build: values => ({ type: "task.cancel", ...values }), ...props }));
// The class list mentions `disabled:` variants; the attribute itself renders as disabled="".
const submitDisabled = (html: string) => /<button[^>]*type="submit"[^>]*\sdisabled=""/.test(html);

test("every field type renders with its default value, hint, optional mark and advanced fold", () => {
  const fields: Field[] = [
    { name: "title", label: "新提议任务的名称", value: "每日核对", hint: "例如“每日核对”" },
    { name: "content", label: "新任务正文（Markdown）", kind: "textarea", value: "正文" },
    { name: "state", label: "日程状态", kind: "select", value: "paused", options: [option("active", "启用后续检查"), option("paused", "暂停")] },
    { name: "ruleKind", label: "触发方式", kind: "select", options: [option("once", "仅一次")] },
    { name: "supersedesId", label: "更正此前判定（可选）", kind: "select", optional: true, options: [option("a1", "第一条")] },
    { name: "capabilities", label: "亲自核实的能力", kind: "multi", value: JSON.stringify(["read"]), options: [option("open", "打开原聊天"), option("read", "读取原聊天")] },
    { name: "atUtc", label: "仅一次：UTC 时刻", optional: true },
    { name: "executeAt", label: "执行时间", kind: "datetime", value: "2026-11-12T09:00" },
    { name: "slot", label: "依据槽位", advanced: true, value: "s1" },
  ];
  const html = render({ context: context(), fields, embedded: true });
  assert.match(html, /<input[^>]*name="title"[^>]*value="每日核对"/);
  assert.match(html, /例如“每日核对”/, "the hint is shown under the field");
  assert.match(html, /<textarea[^>]*name="content"[^>]*>正文<\/textarea>/);
  assert.match(html, /<option value="paused" selected="">暂停<\/option>/, "a select starts on its value");
  assert.doesNotMatch(html.slice(html.indexOf('name="state"'), html.indexOf('name="ruleKind"')), /请选择/, "a select with a valid value offers no empty choice");
  assert.match(html.slice(html.indexOf('name="ruleKind"')), /<option value="" selected="">请选择<\/option>/, "a required select without a value asks to choose");
  assert.match(html, /<option value="" selected="">不设置<\/option>/, "an optional select can stay unset");
  assert.match(html, /更正此前判定（可选）</, "a label that already says 可选 is not marked twice");
  assert.match(html, /仅一次：UTC 时刻（可选）/);
  // React writes attributes in its own order; find each tag, then look inside it.
  const tag = (pattern: string) => html.match(new RegExp(`<input(?=[^>]*${pattern})[^>]*>`))?.[0] ?? "";
  assert.match(tag('value="read"'), /type="checkbox".*checked=""/, "several choices are checkboxes, ticked from the JSON value");
  assert.match(tag('value="open"'), /type="checkbox"/);
  assert.doesNotMatch(tag('value="open"'), /checked=""/);
  assert.match(tag('name="executeAt"'), /type="datetime-local".*value="2026-11-12T09:00"/);
  assert.match(html, /<details[^>]*><summary[^>]*>高级选项<\/summary><div[^>]*>.*name="slot"/, "advanced fields are folded");
  assert.match(html, /<form data-ui=""[^>]*aria-label="保存日程修订"/, "the form is named by its title and marked as new markup");
  assert.match(html, /<button type="submit"[^>]*>保存日程修订<\/button>/, "the title is the submit button");
  assert.equal(submitDisabled(html), false);
  assert.deepEqual(initialValues(fields.map(toFormField)).capabilities, "[\"read\"]");
  assert.equal(initialValues([toFormField({ name: "x", label: "x", kind: "multi" })]).x, "[]", "an empty multi starts as an empty list");
});

test("required fields are checked before sending, with what to do about each", () => {
  const fields = [
    toFormField({ name: "title", label: "项目名称" }),
    toFormField({ name: "stage", label: "交接阶段", kind: "select", options: [option("read", "实际阅读")] }),
    toFormField({ name: "caps", label: "能力", kind: "multi", options: [option("open", "打开")] }),
    toFormField({ name: "note", label: "补充", optional: true }),
  ];
  assert.deepEqual(missingFields(fields, initialValues(fields)), { title: "请填写项目名称。", stage: "请选择交接阶段。", caps: "请至少选择一项。" });
  assert.deepEqual(missingFields(fields, { title: " 甲 ", stage: "read", caps: "[\"open\"]", note: "" }), {});
  assert.deepEqual(missingFields(fields, { title: "   ", stage: "read", caps: "[\"open\"]" }), { title: "请填写项目名称。" }, "spaces alone are not an answer");
});

test("folded behind its title by default; open when asked, or when a kept draft comes back; embedded draws the form in place", () => {
  clearCommandDrafts();
  const folded = render({ context: context() });
  assert.match(folded, /^<details data-ui=""[^>]*><summary[^>]*>保存日程修订<\/summary>/);
  assert.doesNotMatch(folded.slice(0, folded.indexOf("<summary")), /open=""/);
  assert.match(render({ context: context(), initiallyOpen: true }), /^<details data-ui="" open=""/);
  assert.match(render({ context: context(), embedded: true }), /^<form data-ui=""/);
  const scoped = context({ draftScope: "schedule:s1" });
  commandDrafts.set(draftKeyFor(scoped, "schedule:s1", "保存日程修订"), { values: { base: { reason: "" }, values: { reason: "写到一半" } }, baseline: undefined });
  assert.match(render({ context: scoped }), /^<details data-ui="" open=""/, "a form with a kept draft opens, so its notice is seen");
  clearCommandDrafts();
});

test("review and other permissions: the form says what the identity lacks and does not send", () => {
  const writer = context({}, ["read", "write"]);
  const review = render({ context: writer, review: true, embedded: true });
  assert.match(review, /当前身份没有审阅权限。/);
  assert.equal(submitDisabled(review), true);
  const write = render({ context: writer, embedded: true });
  assert.doesNotMatch(write, /当前身份没有/);
  assert.equal(submitDisabled(write), false, "write permission is enough by default");
  const exact = render({ context: context({}, ["read", "review"]), requiredPermissions: ["write", "review"], embedded: true });
  assert.match(exact, /当前身份没有写入权限。/);
  assert.equal(submitDisabled(exact), true);
});

test("an operation with an unknown result, or a pause, stops sending and says why", () => {
  const blocked = render({ context: context({ blocked: true }), embedded: true });
  assert.match(blocked, /本项目仍有结果未确认的操作，请先核对上方回执。/);
  assert.equal(submitDisabled(blocked), true);
  const paused = render({ context: context(), embedded: true, paused: "评价记录最近一次重读失败；写入暂停。" });
  assert.match(paused, /评价记录最近一次重读失败；写入暂停。/);
  assert.equal(submitDisabled(paused), true);
});

test("a kept draft comes back with the baseline it was written against: same baseline sends, a moved one asks first", () => {
  clearCommandDrafts();
  const scope = "runtime-close:s1";
  const kept = (draftBaseline: string) => context({ draftScope: scope, draftBaseline });
  const key = draftKeyFor(kept("1"), scope, "请求关闭受管智能体");
  const fields = [{ ...reasonField, label: "关闭理由与核对依据" }];
  commandDrafts.set(key, { values: { base: { reason: "" }, values: { reason: "已核对没有在途运行" } }, baseline: "1" });
  const same = render({ context: kept("1"), title: "请求关闭受管智能体", fields, embedded: true });
  assert.match(same, />已核对没有在途运行<\/textarea>/, "the draft is restored");
  assert.doesNotMatch(same, /打开表单后内容已被更新/);
  assert.equal(submitDisabled(same), false);
  assert.match(same, /data-dirty="true"/, "the page knows there is unsaved input");
  const moved = render({ context: kept("2"), title: "请求关闭受管智能体", fields, embedded: true });
  assert.match(moved, />已核对没有在途运行<\/textarea>/);
  assert.match(moved, /这份草稿写于较早的版本/, "a draft from an earlier mount says it was written on an older version");
  assert.match(moved, /按最新内容重填/);
  assert.match(moved, /保留我的修改/);
  assert.match(moved, /复制当前草稿/, "the draft can be copied before refilling");
  assert.equal(submitDisabled(moved), true, "it is not sent on a version it was not written against");
  // A form without draftScope keeps nothing between mounts.
  assert.doesNotMatch(render({ context: context({ draftBaseline: "2" }), title: "请求关闭受管智能体", fields, embedded: true }), /已核对没有在途运行/);
  clearCommandDrafts();
});

test("the baseline: named fixed inputs, the older draftBaseline string, or both", () => {
  assert.deepEqual(actionBaseline({ sessionVersion: 3 }, undefined), { sessionVersion: 3 });
  assert.equal(actionBaseline(undefined, "3"), "3");
  assert.deepEqual(actionBaseline({ sessionVersion: 3 }, "role:2"), { sessionVersion: 3, draftBaseline: "role:2" });
  assert.equal(actionBaseline(undefined, undefined), undefined);
});

test("a message composer: one growing field with the button beside it, ⌘/Ctrl + Enter submits", () => {
  const html = render({ context: context(), embedded: true, submitOnModEnter: true, title: "保存消息",
    fields: [{ name: "content", label: "消息内容", kind: "textarea", placeholder: "给当前 Session 发消息…", autoGrow: true }] });
  assert.match(html, /<textarea[^>]*name="content"[^>]*rows="1"[^>]*placeholder="给当前 Session 发消息…"/);
  assert.match(html, /\[&amp;&gt;label\]:sr-only/, "the label stays for assistive technology but is not drawn");
  assert.match(html, /<label[^>]*>消息内容<\/label>/);
});

test("the copyable draft includes every current field and preserves user text, without identifiers", () => {
  const fields = [
    { name: "stage", label: "阶段" },
    { name: "task", label: "任务" },
    { name: "options", label: "备选做法", kind: "textarea" as const },
  ];
  const draft = readableDraft("生成讨论包", fields, { stage: "阶段A", task: "任务B", options: "方案一\n方案二" });
  assert.match(draft, /^生成讨论包/);
  assert.match(draft, /阶段\n阶段A/);
  assert.match(draft, /任务\n任务B/);
  assert.match(draft, /备选做法\n方案一\n方案二/);
  assert.doesNotMatch(draft, /token|operationId|\(stage\)|\(options\)/);
});
