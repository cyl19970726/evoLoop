// Pure wording for the 微信连接 page: route states, delivery records and save notices in product language.
// Raw values from the server (states, providers, IDs) never reach the page text directly; IDs stay in the
// 完整标识 layer of the route card.
import type { ConnectorRouteRecord } from "@evoloop/contracts/message-connectors";
import type { StatusTone } from "@evoloop/ui";

type RouteState = ConnectorRouteRecord["state"];

export const routeStateLabel: Record<RouteState, string> = { active: "启用", paused: "暂停", disabled: "停用" };
/** 启用 is a standing setting, not work in progress: a check, not a spinner. */
export const routeStateTone: Record<RouteState, StatusTone> = { active: "done", paused: "waiting", disabled: "idle" };

/** 标准模式 · 第 3 版 */
export function routeModeLine(route: Pick<ConnectorRouteRecord, "mode" | "version">): string {
  return `${route.mode === "standard" ? "标准模式" : "受限模式"} · 第 ${route.version} 版`;
}

const providers: Record<string, string> = { wechat: "微信" };
export function providerLabel(provider: string): string {
  return providers[provider] ?? "其他消息平台";
}

export function conversationKindLabel(kind: ConnectorRouteRecord["conversationKind"]): string {
  return kind === "group" ? "群聊" : "私聊";
}

/** The link text for the receiving agent. Its full ID stays in the 完整标识 layer. */
export function agentLinkText(read: { name?: string | null | undefined; loading: boolean }): string {
  const name = read.name?.trim();
  if (name) return name;
  return read.loading ? "智能体（正在读取名称）" : "智能体（名称待读取）";
}

/** Notice after a new route was saved and read back. The button says 保存为停用路由. */
export function createdNotice(label: string): string {
  return `已保存为停用路由「${label}」，并已读回。启用前请先核对接收的智能体与网关授权。`;
}

/** Notice after a state change was saved and read back. */
export function stateChangedNotice(label: string, state: RouteState, version: number): string {
  return `路由「${label}」已${routeStateLabel[state]}，读回为第 ${version} 版。`;
}

/** Notice after an unconfirmed operation was found again. */
export function reconciledNotice(label: string, version: number): string {
  return `原操作已确认：路由「${label}」读回为第 ${version} 版。`;
}

// ── Deliveries: what the gateway handed over and what became of it ──

const messageStates: Record<string, string> = {
  queued: "待处理", processing: "处理中", replied: "已回复", completed_without_reply: "已处理、未回复",
  failed: "处理失败", unknown: "结果未知", cancelled: "已取消", manual_pending: "待人工转交",
};
const unhandledReasons: Record<string, string> = {
  unsupported_content: "内容类型不支持", empty_text: "空消息", text_too_large: "消息过长", sender_not_allowed: "发送者不在名单内",
};
/** Only a delivery without any source event ends on a gateway step; message states win otherwise. */
const gatewaySteps: Record<string, string> = {
  completed: "网关已结束", interrupted: "网关中断", attempted: "已尝试领取", observed: "已领取",
};

export function messageStateLabel(state: string): string {
  return messageStates[state] ?? "状态待核对";
}

export function unhandledReasonLabel(reason: string): string {
  return unhandledReasons[reason] ?? "原因待核对";
}

/** The latest state of a delivery: a message state, `unhandled:<reason>`, or a gateway step. */
export function latestDeliveryStateLabel(value: string): string {
  if (value.startsWith("unhandled:")) return `未转给智能体（${unhandledReasonLabel(value.slice("unhandled:".length))}）`;
  return messageStates[value] ?? gatewaySteps[value] ?? "状态待核对";
}

const processingStates: Record<string, string> = {
  dispatching: "正在启动一轮", running: "这一轮运行中", unknown: "这一轮结果未知", completed: "这一轮已结束", failed: "这一轮失败",
};
export function processingStateLabel(state: string | null): string {
  return state === null ? "尚未开始一轮" : processingStates[state] ?? "运行状态待核对";
}

const decisionKinds: Record<string, string> = { reply: "发送回复", draft: "存为草稿", skip: "不回复", defer: "留给人工处理" };
const decisionStates: Record<string, string> = {
  prepared: "已准备", attempted: "已尝试发送", observed: "本机可见、对方未确认",
  complete_attempted: "正在结束这批投递", complete_unknown: "结束结果未知", completed: "这批投递已结束",
};
/** The outbound decision of a delivery, or 尚无 when none was saved. */
export function decisionLabel(decision: { decision: string; state: string } | null): string {
  if (!decision) return "尚无";
  return `${decisionKinds[decision.decision] ?? "决定待核对"} · ${decisionStates[decision.state] ?? "进度待核对"}`;
}

/** 2 条来源消息 · 1 条需人工处理 · 最新：已回复 · 出站：发送回复 · 已准备 */
export function deliverySummary(item: { eventCount: number; unhandledCount: number; latestMessageState: string;
  decision: { decision: string; state: string } | null }): string {
  return [`${item.eventCount} 条来源消息`, item.unhandledCount ? `${item.unhandledCount} 条需人工处理` : "",
    `最新：${latestDeliveryStateLabel(item.latestMessageState)}`, item.decision ? `出站：${decisionLabel(item.decision)}` : ""]
    .filter(Boolean).join(" · ");
}

export function unhandledEventLabel(event: { eventKind: string; direction: string }): string {
  if (event.eventKind === "message_observed") return event.direction === "incoming" ? "收到的消息" : event.direction === "outgoing" ? "发出的消息" : "消息";
  return "其他平台事件";
}

// ── The route list: loading, failure and empty are different facts ──

export type RouteListView = "loading" | "error" | "empty" | "list";

/**
 * What the route section shows. Without anything read yet, a failed read is only a failure: it never
 * becomes 还没有路由. After a failed reread the previous routes stay, marked as last read.
 */
export function routeListView(read: { routes: readonly unknown[] | null; error: string; reading: boolean }): {
  view: RouteListView; stale: boolean; checking: boolean;
} {
  if (read.routes === null) return { view: read.error && !read.reading ? "error" : "loading", stale: false, checking: false };
  return { view: read.routes.length ? "list" : "empty", stale: !!read.error, checking: read.reading };
}
