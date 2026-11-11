// The agent page's flow wording (conversationPresentation) and what its composer does (composerPresentation).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionResult } from "@evoloop/contracts/session-observation";
import type { WorkspaceEntry, WorkspaceTool, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import {
  elapsedText, latestPlan, liveStatusText, planExplanation, planSteps, recordLabel, toolDetailReason, toolGroupStatus, toolGroupSummary, toolLabel,
  toolStepState, toolStepText, turnSummaries,
} from "../src/features/sessions/conversationPresentation";
import { composerPlan, contextUseText, mentionedAgents, messageWithSkill, type ComposerFacts } from "../src/features/sessions/composerPresentation";
import { sessionTaskReturn, sourceParams } from "../src/features/sessions/sessionReturn";

test("an agent page opened from another page offers the way back only to that project's page and its reader", () => {
  const project = "96000001-0000-4000-8000-000000000001", task = "96000000-0000-4000-8000-000000000005", key = "owned:96000000-0000-4000-8000-000000000002";
  const taskPath = `/p/${project}/tasks/${task}`;
  const link = (from: string, actor = "reader") => `/p/${project}/sessions?${new URLSearchParams({ session: key, return: from, actor, returnTitle: "新版智能体页" })}`;
  assert.deepEqual(sessionTaskReturn(link(taskPath), project, key, "reader"),
    { href: taskPath, place: { kind: "task", taskId: task }, title: "新版智能体页", label: "返回任务：新版智能体页" });
  assert.equal(sessionTaskReturn(link(taskPath, "someone-else"), project, key, "reader"), null, "the way back belongs to the reader the link was made for");
  assert.equal(sessionTaskReturn(link(taskPath), project, "owned:other", "reader"), null);
  assert.equal(sessionTaskReturn(link(`/p/other/tasks/${task}`), project, key, "reader"), null, "only this project");
  assert.equal(sessionTaskReturn(link(`/p/${project}/documents`), project, key, "reader")?.label, "返回文档列表", "any page of the project, named by its place");
  assert.equal(sessionTaskReturn(link(`/p/${project}/sessions?session=${encodeURIComponent(key)}`), project, key, "reader"), null, "never back to itself");
  assert.equal(sessionTaskReturn(`/p/${project}/sessions?session=${encodeURIComponent(key)}`, project, key, "reader"), null);
  assert.deepEqual(sourceParams(link(taskPath)).map(([name]) => name), ["return", "actor", "returnTitle"]);
});

const stamp = "2026-11-10T08:00:00.000Z";
const internal = /Session|Turn|Run\b|Thread|Agent|Plan|Command|Read file|Changed|Context|writer|PG|queue|operation/;
function tool(id: string, overrides: Partial<WorkspaceTool> = {}): WorkspaceTool {
  return { id, kind: "tool", name: "Command", summary: "Command", state: "completed", durationMs: null, exitCode: null, detailAvailable: false,
    detailReason: null, turnId: "turn-1", nativeItemId: id, nativeKind: "commandExecution", author: { kind: "native", id: null, label: "原生工具" },
    origin: null, occurredAt: stamp, observedAt: stamp, freshness: "persisted", truncated: false, ...overrides };
}

test("tool lines say in Chinese what the native source says in English, keeping paths and tool names", () => {
  assert.equal(toolStepText(tool("a", { name: "Read file", summary: "Read file src/app.ts" })), "读取 src/app.ts");
  assert.equal(toolStepText(tool("b", { name: "Command", summary: "Read file a.ts, Search in src" })), "读取 a.ts，搜索 src");
  assert.equal(toolStepText(tool("c", { name: "File change", summary: "Changed a.ts, b.ts", nativeKind: "fileChange" })), "修改 a.ts, b.ts");
  assert.equal(toolStepText(tool("d")), "执行命令");
  assert.equal(toolStepText(tool("e", { name: "github/create_issue", summary: "github/create_issue", nativeKind: "mcpToolCall" })), "github/create_issue");
  assert.equal(toolStepText(tool("f", { name: "images/check", summary: "图片暂不可读", nativeKind: "dynamicToolCall" })), "images/check：图片暂不可读", "a tool of no known kind keeps its name in front");
  assert.equal(toolStepText(tool("g", { name: "commandExecution", summary: "后续事件" })), "后续事件", "a command reports what it did");
  assert.equal(toolLabel("Agent collaboration"), "智能体协作");
  assert.equal(recordLabel("Plan"), "执行计划");
  assert.equal(recordLabel("Context compacted"), "上下文已压缩");
  assert.equal(toolDetailReason("Native source did not provide original tool evidence."), "来源没有提供原始工具详情。");
  assert.equal(toolDetailReason("something new"), "来源没有提供原始工具详情。");
});

test("a folded tool group is one line counted by kind, with what is running and what failed", () => {
  const entries = [tool("a"), tool("b"), tool("c", { name: "Read file" }), tool("d", { name: "File change", nativeKind: "fileChange" }),
    tool("e", { state: "failed" }), tool("f", { state: "running", freshness: "live" })];
  assert.equal(toolGroupSummary(entries), "执行了 4 个指令、读了 1 个文件、改了 1 处文件");
  assert.equal(toolGroupStatus(entries), "，正在进行，1 项失败或中断");
  assert.equal(toolGroupStatus([tool("x", { state: "running", freshness: "stale" })]), "，上次进行中的一项当前待核对", "an older read is not presented as running");
  assert.equal(toolStepState(tool("y", { state: "running", freshness: "stale" })), "上次进行中，当前待核对");
  assert.equal(toolStepState(tool("z", { durationMs: 1530 })), "已完成 · 1.53 秒");
  for (const text of [toolGroupSummary(entries), toolGroupStatus(entries)]) assert.doesNotMatch(text, internal);
});

test("the plan written as numbered steps becomes the checklist; other text stays the explanation", () => {
  const body = "先核对再改\n1. [completed] 读取任务\n2. [inProgress] 修改页面\n3. [pending] 跑测试";
  assert.deepEqual(planSteps(body), [{ text: "读取任务", status: "done" }, { text: "修改页面", status: "active" }, { text: "跑测试", status: "todo" }]);
  assert.equal(planExplanation(body), "先核对再改");
  assert.equal(planSteps("只是一段说明"), null);
  const plan = (id: string, turnId: string): WorkspaceEntry => ({ id, kind: "plan", label: "Plan", body, state: "running", turnId, nativeItemId: null, nativeKind: "turnPlanUpdated",
    author: { kind: "session", id: null, label: "x" }, origin: null, occurredAt: null, observedAt: stamp, freshness: "live", truncated: false });
  assert.equal(latestPlan([plan("p1", "turn-1"), plan("p2", "turn-1"), plan("p3", "turn-2")], "turn-1")?.id, "p2");
  assert.equal(latestPlan([plan("p3", "turn-2")], "turn-1"), null);
});

test("the live status line names what runs now and how long, never a negative or unknown time", () => {
  assert.equal(liveStatusText(tool("a", { name: "Read file", summary: "Read file a.ts" }), true), "正在读取 a.ts");
  assert.equal(liveStatusText(tool("b"), false), "正在执行命令");
  assert.equal(liveStatusText(tool("c", { name: "github/create_issue", summary: "github/create_issue", nativeKind: "mcpToolCall" }), false), "正在使用 github/create_issue");
  assert.equal(liveStatusText(null, true), "正在回复");
  assert.equal(liveStatusText(null, false), "正在处理");
  const now = Date.parse(stamp);
  assert.equal(elapsedText(new Date(now - 64_000).toISOString(), now), "1 分 04 秒");
  assert.equal(elapsedText(new Date(now - 9_000).toISOString(), now), "9 秒");
  assert.equal(elapsedText(new Date(now - 7_380_000).toISOString(), now), "2 小时 3 分");
  assert.equal(elapsedText(null, now), null);
  assert.equal(elapsedText(new Date(now + 5_000).toISOString(), now), null);
});

test("a finished turn closes with what it produced; a delivery and who moves next only when the records say so", () => {
  const turn = (id: string, state: WorkspaceTurn["state"], taskId: string | null = null, completedAt: string | null = "2026-11-10T09:30:00.000Z"): WorkspaceTurn =>
    ({ id, state, startedAt: stamp, completedAt, origin: taskId ? { kind: "run", id: `run-${id}`, taskId, taskRevisionId: taskId, initiatingActorId: null } : null });
  const entries = [tool("a", { turnId: "t1" }), tool("b", { turnId: "t1", state: "failed" }), tool("c", { turnId: "t2" }), tool("d", { turnId: "t3" }), tool("e", { turnId: "t4" })];
  const result = { taskId: "task-1", taskTitle: "新版任务页", submittedAt: "2026-11-10T09:00:00.000Z" } as SessionResult;
  const lines = turnSummaries(entries, [turn("t1", "failed"), turn("t2", "completed", "task-1"), turn("t3", "running"), turn("t4", "completed")], [result], new Set(["t4"]));
  assert.deepEqual(lines.get("b"), { produced: "执行了 2 个指令，1 项失败或中断", next: "这一轮失败，等你核对" });
  assert.deepEqual(lines.get("c"), { produced: "执行了 1 个指令", delivered: "交付了「新版任务页」", next: "下一步等验收者核对交付与使用" });
  assert.equal(lines.has("d"), false, "a running turn has no summary yet");
  assert.deepEqual(lines.get("e"), { produced: "执行了 1 个指令", next: "下一步等你回答" });
  const earlier = { ...result, submittedAt: "2026-11-09T00:00:00.000Z" };
  assert.equal(turnSummaries(entries, [turn("t2", "completed", "task-1")], [earlier]).get("c")?.delivered, undefined, "a delivery from before the turn is not its output");
  const later = { ...result, submittedAt: "2026-11-10T11:00:00.000Z" };
  assert.equal(turnSummaries(entries, [turn("t2", "completed", "task-1")], [later]).get("c")?.delivered, undefined, "a later turn's delivery is not this turn's output");
  assert.equal(turnSummaries(entries, [turn("t2", "completed", "task-1", null)], [result]).get("c")?.delivered, undefined, "without an end time nothing is claimed");
});

const facts = (overrides: Partial<ComposerFacts> = {}): ComposerFacts => ({ kind: "owned", canSave: true, saveReason: null, direct: undefined,
  directPending: false, running: false, canWrite: true, blocked: false, ...overrides });
const capability = (mode: "steer" | "start" | null) => ({ available: mode !== null, mode, expectedTurnId: mode === "steer" ? "turn-1" : null, reasonCode: "ok", observedAt: stamp });

test("Enter adds to the running turn only where the runtime declares it can; otherwise it queues and says why", () => {
  const steer = composerPlan(facts({ running: true, direct: capability("steer") }));
  assert.deepEqual([steer.enter, steer.modEnter, steer.sendMode, steer.disabledReason], ["steer", "post", "steer", null]);
  assert.match(steer.hint, /Enter 补充到这一轮 · ⌘\/Ctrl\+Enter 排到下一轮/);
  const unsupported = composerPlan(facts({ running: true, direct: capability(null) }));
  assert.deepEqual([unsupported.enter, unsupported.modEnter, unsupported.sendMode], ["post", "post", "queue"]);
  assert.equal(unsupported.steerNote, "这个智能体现在不能补充到这一轮", "an unexplained refusal is not called unsupported");
  assert.match(unsupported.hint, /不能补充到这一轮；Enter 排到下一轮/);
  const because = (reasonCode: string) => composerPlan(facts({ running: true, direct: { ...capability(null), reasonCode } })).steerNote;
  assert.equal(because("DIRECT_STEER_DISABLED"), "这个智能体的运行时或授权不支持补充到这一轮");
  assert.equal(because("NATIVE_STEER_UNAVAILABLE"), "当前运行时版本不支持补充到这一轮");
  assert.equal(because("SESSION_INPUT_BUSY"), "这个智能体正在开始另一轮或接收另一条输入，稍后再试");
  assert.equal(because("SESSION_BUSY"), "这一轮正在做的工作不接受补充");
  assert.equal(because("NATIVE_UNAVAILABLE"), "运行时连接暂不可用，不能补充到这一轮");
  assert.equal(because("DIRECT_GRANT_MISSING"), "这个智能体没有即时输入的授权，不能补充到这一轮");
  assert.equal(because("NATIVE_TURN_UNKNOWN"), "运行时里这一轮的状态无法判断，暂不补充");
  assert.equal(composerPlan(facts({ running: true, direct: undefined })).steerNote, "正在核对能否补充到这一轮", "a capability still being read is not a no");
  assert.equal(composerPlan(facts({ running: true, direct: null })).steerNote, "能否补充到这一轮暂无法判断");
  assert.equal(composerPlan(facts({ running: true, direct: capability("steer"), directPending: true })).enter, "post", "an unchecked earlier input blocks another addition");
  assert.equal(composerPlan(facts({ running: false, direct: capability("steer") })).running, true, "a steer capability means a turn runs");
});

test("idle: Enter starts a turn where the runtime allows it, Cmd/Ctrl+Enter saves an ordinary message", () => {
  const start = composerPlan(facts({ direct: capability("start") }));
  assert.deepEqual([start.enter, start.modEnter, start.sendMode], ["start", "post", "send"]);
  const ordinary = composerPlan(facts({ direct: capability(null) }));
  assert.deepEqual([ordinary.enter, ordinary.modEnter, ordinary.hint], ["post", "post", "Enter 保存并按顺序处理"]);
  const external = composerPlan(facts({ kind: "external", direct: null }));
  assert.deepEqual([external.enter, external.placeholder], ["post", "写给外部智能体，保存后需人工转交…"]);
});

test("nothing is sent without the right to write, during an unconfirmed operation or when saving is closed", () => {
  assert.equal(composerPlan(facts({ canWrite: false })).disabledReason, "当前身份只有读取权限，不能发消息。");
  assert.match(composerPlan(facts({ blocked: true })).disabledReason ?? "", /结果未确认的操作/);
  assert.equal(composerPlan(facts({ canSave: false, saveReason: "当前身份只有读取权限。" })).disabledReason, "当前身份只有读取权限。");
  assert.equal(composerPlan(facts({ canSave: false, direct: capability("start") })).enter, "start", "the runtime may still start a turn when saving is closed");
  assert.equal(composerPlan(facts({ canSave: false, direct: capability("start") })).modEnter, null);
  assert.equal(composerPlan(facts({ canSave: false, saveReason: "保存已关闭。", running: true, direct: capability("steer") })).queueNote, "现在不能排到下一轮：保存已关闭。",
    "Cmd/Ctrl+Enter says why it cannot queue instead of doing what Enter does");
  assert.equal(composerPlan(facts({ direct: capability("start") })).queueNote, null);
  for (const plan of [composerPlan(facts()), composerPlan(facts({ running: true })), composerPlan(facts({ kind: "external" }))])
    assert.doesNotMatch(`${plan.hint}${plan.placeholder}${plan.disabledReason ?? ""}`, internal);
});

test("a chosen skill is named in the message; @ copies go only to agents still named in the text", () => {
  assert.equal(messageWithSkill("改一下", { name: "需求整理", slug: "项目" }), "使用技能：需求整理（项目）\n改一下");
  assert.equal(messageWithSkill("改一下", null), "改一下");
  const picked = [{ name: "架构" }, { name: "独立验收" }, { name: "架构" }];
  assert.deepEqual(mentionedAgents("请 @架构 看一下", picked), [{ name: "架构" }]);
  assert.deepEqual(mentionedAgents("@独立验收 和 @架构", picked).map(agent => agent.name), ["架构", "独立验收"]);
  assert.deepEqual(mentionedAgents("mail@架构x", picked), []);
  assert.equal(contextUseText({ last: { totalTokens: 42_000 }, modelContextWindow: 100_000 }), "上下文 42%");
  assert.equal(contextUseText({ last: { totalTokens: null }, modelContextWindow: 100_000 }), null, "unknown use is not 0%");
  assert.equal(contextUseText(null), null);
});
