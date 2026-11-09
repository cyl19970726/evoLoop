import assert from "node:assert/strict";
import test from "node:test";
import {
  agentLinkText, createdNotice, decisionLabel, deliverySummary, latestDeliveryStateLabel, messageStateLabel, processingStateLabel,
  providerLabel, reconciledNotice, routeListView, routeModeLine, routeStateLabel, routeStateTone, stateChangedNotice,
  unhandledEventLabel, unhandledReasonLabel,
} from "../src/features/connectors/connectorPresentation.ts";

const english = /[A-Za-z_]{3,}/;
const anUuid = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

test("route states, mode and version read as Chinese", () => {
  assert.deepEqual([routeStateLabel.active, routeStateLabel.paused, routeStateLabel.disabled], ["启用", "暂停", "停用"]);
  assert.deepEqual([routeStateTone.active, routeStateTone.paused, routeStateTone.disabled], ["done", "waiting", "idle"]);
  assert.equal(routeModeLine({ mode: "standard", version: 3 }), "标准模式 · 第 3 版");
  assert.equal(routeModeLine({ mode: "restricted", version: 1 }), "受限模式 · 第 1 版");
  assert.equal(providerLabel("wechat"), "微信");
  assert.equal(providerLabel("slack"), "其他消息平台", "an unknown provider is not echoed raw");
});

test("save notices name the route, not its ID, and match the 保存为停用路由 button", () => {
  const created = createdNotice("前端改版群");
  assert.match(created, /^已保存为停用路由「前端改版群」/);
  assert.equal(stateChangedNotice("前端改版群", "paused", 4), "路由「前端改版群」已暂停，读回为第 4 版。");
  assert.equal(stateChangedNotice("前端改版群", "disabled", 5), "路由「前端改版群」已停用，读回为第 5 版。");
  assert.equal(reconciledNotice("前端改版群", 2), "原操作已确认：路由「前端改版群」读回为第 2 版。");
  for (const text of [created, stateChangedNotice("群", "active", 2), reconciledNotice("群", 2)]) {
    assert.doesNotMatch(text, english); assert.doesNotMatch(text, anUuid);
  }
});

test("the agent link shows a name, or says the name is not read yet", () => {
  assert.equal(agentLinkText({ name: " 前端实现助手 ", loading: false }), "前端实现助手");
  assert.equal(agentLinkText({ name: undefined, loading: true }), "智能体（正在读取名称）");
  assert.equal(agentLinkText({ name: null, loading: false }), "智能体（名称待读取）");
  assert.equal(agentLinkText({ name: "  ", loading: false }), "智能体（名称待读取）");
});

test("delivery states, decisions and events never show raw server values", () => {
  assert.equal(latestDeliveryStateLabel("replied"), "已回复");
  assert.equal(latestDeliveryStateLabel("manual_pending"), "待人工转交");
  assert.equal(latestDeliveryStateLabel("unhandled:sender_not_allowed"), "未转给智能体（发送者不在名单内）");
  assert.equal(latestDeliveryStateLabel("unhandled:something_new"), "未转给智能体（原因待核对）");
  assert.equal(latestDeliveryStateLabel("interrupted"), "网关中断");
  assert.equal(latestDeliveryStateLabel("transport:transport"), "状态待核对");
  assert.equal(messageStateLabel("delivered"), "状态待核对");
  assert.equal(processingStateLabel(null), "尚未开始一轮");
  assert.equal(processingStateLabel("running"), "这一轮运行中");
  assert.equal(decisionLabel(null), "尚无");
  assert.equal(decisionLabel({ decision: "reply", state: "observed" }), "发送回复 · 本机可见、对方未确认");
  assert.equal(decisionLabel({ decision: "defer", state: "complete_unknown" }), "留给人工处理 · 结束结果未知");
  assert.equal(unhandledReasonLabel("text_too_large"), "消息过长");
  assert.equal(unhandledEventLabel({ eventKind: "message_observed", direction: "incoming" }), "收到的消息");
  assert.equal(unhandledEventLabel({ eventKind: "member_joined", direction: "incoming" }), "其他平台事件");
  const summary = deliverySummary({ eventCount: 2, unhandledCount: 1, latestMessageState: "replied", decision: { decision: "skip", state: "completed" } });
  assert.equal(summary, "2 条来源消息 · 1 条需人工处理 · 最新：已回复 · 出站：不回复 · 这批投递已结束");
  assert.equal(deliverySummary({ eventCount: 1, unhandledCount: 0, latestMessageState: "queued", decision: null }), "1 条来源消息 · 最新：待处理");
  for (const value of ["queued", "processing", "replied", "completed_without_reply", "failed", "unknown", "cancelled", "manual_pending",
    "completed", "attempted", "observed", "unhandled:empty_text", "something_else"])
    assert.doesNotMatch(latestDeliveryStateLabel(value), english, value);
});

test("a failed first read is a failure, never 还没有路由; a failed reread keeps the old routes as stale", () => {
  assert.deepEqual(routeListView({ routes: null, error: "", reading: true }), { view: "loading", stale: false, checking: false });
  assert.deepEqual(routeListView({ routes: null, error: "请求失败（503）", reading: false }), { view: "error", stale: false, checking: false });
  assert.deepEqual(routeListView({ routes: null, error: "请求失败（503）", reading: true }), { view: "loading", stale: false, checking: false });
  assert.deepEqual(routeListView({ routes: [], error: "", reading: false }), { view: "empty", stale: false, checking: false });
  assert.deepEqual(routeListView({ routes: [{}], error: "", reading: true }), { view: "list", stale: false, checking: true });
  assert.deepEqual(routeListView({ routes: [{}], error: "请求失败（503）", reading: false }), { view: "list", stale: true, checking: false });
});
