// Conversation flow and composer rules from docs/frontend/components.md (对话流组件).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Composer, LiveStatusLine, MessageBubble, QuestionCard, QueuedMessages, TodoList, ToolSummary, TurnSummary, composerMenu, matchQuery,
  type ComposerAgent, type ComposerCommand,
} from "../src/index.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const noop = () => undefined;

test("composerMenu opens / only at the start and @ only at a word start", () => {
  assert.deepEqual(composerMenu("/"), { kind: "command", query: "", start: 0 });
  assert.deepEqual(composerMenu("/需求"), { kind: "command", query: "需求", start: 0 });
  assert.equal(composerMenu("/需求 整理"), null, "a space ends the command");
  assert.equal(composerMenu("看 /stop"), null, "/ in the middle is text");
  assert.deepEqual(composerMenu("@"), { kind: "mention", query: "", start: 0 });
  assert.deepEqual(composerMenu("请 @架"), { kind: "mention", query: "架", start: 2 });
  assert.equal(composerMenu("mail@example"), null, "@ inside a word is text");
  assert.deepEqual(composerMenu("请 @架 看一下", 4), { kind: "mention", query: "架", start: 2 }, "the caret decides");
  assert.ok(matchQuery("REQ", "需求整理", "evoloop-requirements"));
  assert.ok(!matchQuery("设计", "需求整理", "evoloop-requirements"));
});

const commands: ComposerCommand[] = [
  { id: "s1", name: "需求整理", description: "把目标整理成任务", slug: "evoloop-requirements", kind: "skill" },
  { id: "c1", name: "停止这一轮", slug: "/stop", kind: "command" },
];
const agents: ComposerAgent[] = [
  { id: "a1", name: "架构", state: "空闲", delivery: "now" },
  { id: "a2", name: "独立验收", state: "运行中", delivery: "queued" },
  { id: "a3", name: "统筹", state: "空闲", delivery: "now", system: true },
];

test("typing / lists skills before commands, with the original names on the right", () => {
  const markup = html(h(Composer, { value: "/", onChange: noop, onSend: noop, commands, skillScope: "功能开发可用" }));
  assert.match(markup, /role="listbox" aria-label="技能与命令"/);
  assert.ok(markup.indexOf("技能 · 功能开发可用") < markup.indexOf("命令<"), "skills come first");
  assert.match(markup, /evoloop-requirements/);
  assert.match(markup, /aria-expanded="true"/);
});

test("typing @ lists agents with how the message will arrive, system agents last", () => {
  const markup = html(h(Composer, { value: "请 @", onChange: noop, onSend: noop, agents }));
  assert.match(markup, /aria-label="选择智能体"/);
  assert.match(markup, /立即送达/);
  assert.match(markup, /排队/);
  assert.ok(markup.indexOf("独立验收") < markup.indexOf("统筹"));
  assert.match(markup, /可以 @ 多个/);
});

test("no menu without a trigger; the action button follows the turn state", () => {
  const idle = html(h(Composer, { value: "", onChange: noop, onSend: noop, commands, agents }));
  assert.doesNotMatch(idle, /role="listbox"/);
  assert.match(idle, /aria-label="发送"[^>]*disabled/);
  assert.match(html(h(Composer, { value: "", onChange: noop, onSend: noop, running: true, onStop: noop })), /aria-label="停止这一轮"/);
  assert.match(html(h(Composer, { value: "补一句", onChange: noop, onSend: noop, running: true, onStop: noop })), /aria-label="发送，排到下一轮"/);
});

test("attachments show as removable chips", () => {
  const markup = html(h(Composer, { value: "", onChange: noop, onSend: noop, attachments: [{ id: "t", label: "任务 · 右栏信息核对", kind: "task" }], onRemoveAttachment: noop }));
  assert.match(markup, /任务 · 右栏信息核对/);
  assert.match(markup, /aria-label="移除 任务 · 右栏信息核对"/);
});

test("flow rows: bubble footer, failures counted, live status announced", () => {
  assert.match(html(h(MessageBubble, { footer: "已转给架构", children: "看一下" })), /已转给架构/);
  const tools = html(h(ToolSummary, { summary: "执行了 3 个指令", steps: [{ text: "a" }, { text: "b", failed: true }] }));
  assert.match(tools, /1 次失败/);
  assert.match(html(h(LiveStatusLine, { text: "正在运行测试", elapsed: "1 分 04 秒" })), /role="status" aria-live="polite"/);
  assert.match(html(h(TurnSummary, { produced: "改了 3 个文件", next: "下一步等你验收" })), /本轮：改了 3 个文件/);
});

test("a question card offers 其他 and folds once answered", () => {
  const open = html(h(QuestionCard, { question: "怎样显示？", options: [{ key: "A", label: "折叠" }, { key: "B", label: "展开" }] }));
  assert.match(open, /role="radiogroup"/);
  assert.match(open, />其他</);
  assert.match(open, /<button[^>]*disabled[^>]*>提交/);
  assert.match(html(h(QuestionCard, { question: "怎样显示？", options: [], answer: "折叠" })), /已回答：折叠/);
});

test("todo list folds when all done; empty queue renders nothing", () => {
  assert.match(html(h(TodoList, { items: [{ text: "a", status: "done" }, { text: "b", status: "active" }] })), /进行中：/);
  assert.match(html(h(TodoList, { items: [{ text: "a", status: "done" }, { text: "b", status: "done" }] })), /待办 2 \/ 2 已完成/);
  assert.equal(html(h(QueuedMessages, { items: [] })), "");
  assert.match(html(h(QueuedMessages, { items: [{ id: "1", text: "补一句" }], onCancel: noop })), />撤回</);
});
