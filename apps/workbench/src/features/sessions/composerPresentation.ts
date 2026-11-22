// What the agent page's composer does with a message, decided from what the records say about the agent: Enter
// starts or sends, adds to the running turn only where the runtime declares it can (its 即时输入 capability says
// `steer`), and otherwise queues for the next turn; Cmd/Ctrl+Enter queues as an ordinary message, and does nothing (with a
// note) when no ordinary message can be saved. Pure, tested in session-conversation-presentation.test.ts.
import type { DirectInputCapability } from "@evoloop/contracts/direct-input";
import type { ComposerSendMode } from "@evoloop/ui";
import { agentDisplayName, agentNameCollisions, type AgentNameSource } from "../../shared/agentNamePresentation";

/** `start` and `steer` go through the runtime's 即时输入; `post` saves an ordinary message that is handled in order. */
export type ComposerAction = "start" | "steer" | "post";

export interface ComposerFacts {
  kind: "owned" | "external";
  /** The snapshot's send capability: an ordinary message can be saved. */
  canSave: boolean;
  saveReason: string | null;
  /** The runtime's 即时输入 capability: undefined while it is read, null when it could not be read. */
  direct: DirectInputCapability | null | undefined;
  /** An earlier 即时输入 has an unknown outcome: no new one is sent until it is checked. */
  directPending: boolean;
  /** A turn is running now (live), or the project record says the agent is busy. */
  running: boolean;
  canWrite: boolean;
  /** The project has an operation of unknown outcome. */
  blocked: boolean;
  /** The Leader's page: while it works, "插入当前这一轮" and "排队" are two named buttons. Other agents keep Enter and ⌘/Ctrl+Enter. */
  leader?: boolean;
}

export interface ComposerPlan {
  enter: ComposerAction | null;
  modEnter: "post" | "steer" | null;
  sendMode: ComposerSendMode;
  /** Both ways are open at once and shown as two named buttons (the Leader's page, running, insert and queue both possible). */
  split: { sendLabel: string; queueLabel: string; sendWay?: "insert" | "queue"; queueWay?: "insert" | "queue" } | null;
  running: boolean;
  /** Set when nothing can be sent; the composer is disabled and says why. */
  disabledReason: string | null;
  /** Keys and what they do, for the line under the composer. */
  hint: string;
  /** Why Enter cannot add to the running turn, when it cannot. */
  steerNote: string | null;
  /** Why Cmd/Ctrl+Enter cannot queue for the next turn, when Enter can still send. */
  queueNote: string | null;
  placeholder: string;
}

/** The one reason shown while the agent works and nothing can be added to its turn: stable, whatever the runtime said. */
export const queueOnlyHint = "它正在工作，这条消息只能排在这一轮之后 · Enter 排队";
const defaultPlaceholder = "发消息，/ 调用技能，@ 转给其他智能体";

/** Why the running turn cannot take an addition now, from the reason the runtime's capability gives. */
const steerReasons: Record<string, string> = {
  FORBIDDEN: "当前身份不能即时输入，不能补充到这一轮",
  NATIVE_UNAVAILABLE: "运行时连接暂不可用，不能补充到这一轮",
  DIRECT_GRANT_MISSING: "这个智能体没有即时输入的授权，不能补充到这一轮",
  SESSION_BUSY: "这一轮正在做的工作不接受补充",
  SESSION_INPUT_BUSY: "这个智能体正在开始另一轮或接收另一条输入，稍后再试",
  DIRECT_STEER_DISABLED: "这个智能体的即时输入授权不包含补入这一轮，需要在私有配置里为它开启补入",
  NATIVE_STEER_UNAVAILABLE: "当前运行时不支持补入正在进行的一轮，消息可以排到下一轮",
  NATIVE_IDLE_START_UNAVAILABLE: "当前运行时版本不支持空闲时直接开始一轮",
  NATIVE_CAPABILITY_UNKNOWN: "运行时版本能力暂无法核对，暂不发送",
  NATIVE_TURN_NOT_ACTIVE: "运行时里这一轮已经不在进行，不能补充",
  NATIVE_TURN_UNKNOWN: "运行时里这一轮的状态无法判断，暂不补充",
  PROVIDER_HELD: "模型服务因额度或鉴权问题已暂停新的一轮，消息会照常保存排队，处理后一次放行",
};
export function steerNote(direct: DirectInputCapability | null | undefined, pending: boolean): string {
  if (pending) return "上一条即时输入的结果还没核对，这一轮暂不接受补充";
  if (direct === undefined) return "正在核对能否补充到这一轮";
  if (direct === null) return "能否补充到这一轮暂无法判断";
  return steerReasons[direct.reasonCode] ?? "这个智能体现在不能补充到这一轮";
}

export function composerPlan(facts: ComposerFacts): ComposerPlan {
  const direct = facts.direct && facts.direct.available && !facts.directPending ? facts.direct : null;
  const running = facts.running || facts.direct?.mode === "steer";
  const base = { running, split: null, steerNote: null, queueNote: null, placeholder: defaultPlaceholder };
  const queueNote = facts.canSave ? null : `现在不能排到下一轮：${facts.saveReason || "这个智能体不能保存普通消息"}`;
  const off = (reason: string): ComposerPlan => ({ ...base, enter: null, modEnter: null, sendMode: running ? "queue" : "send", disabledReason: reason, hint: "" });
  if (!facts.canWrite) return off("当前身份只有读取权限，不能发消息。");
  if (facts.blocked) return off("本项目还有结果未确认的操作，请先按原操作核对，再发消息。");
  if (facts.kind === "external") {
    if (!facts.canSave) return off(facts.saveReason || "当前不能保存消息。");
    return { ...base, enter: "post", modEnter: "post", sendMode: "send", disabledReason: null,
      hint: "Enter 保存，保存后需人工转交", placeholder: "写给外部智能体，保存后需人工转交…" };
  }
  const post = facts.canSave ? "post" as const : null;
  if (running) {
    // 默认排队、不打断；插入当前这一轮要人明确选（第二个按钮或 ⌘/Ctrl+Enter）。
    if (direct?.mode === "steer") return post
      ? { ...base, enter: "post", modEnter: "steer", sendMode: "queue", disabledReason: null, queueNote,
        split: { sendLabel: "排到这一轮之后", queueLabel: "插入当前这一轮", sendWay: "queue", queueWay: "insert" },
        hint: "Enter 排到这一轮之后 · ⌘/Ctrl+Enter 插入当前这一轮", placeholder: "发消息，默认排在这一轮之后…" }
      : { ...base, enter: "steer", modEnter: null, sendMode: "steer", disabledReason: null, queueNote,
        hint: "Enter 补充到这一轮", placeholder: "补充到这一轮…" };
    // Only queueing is possible while it works: one stable reason, however the runtime words its refusal (the detail stays in steerNote).
    const note = steerNote(facts.direct, facts.directPending);
    if (!post) return { ...off(facts.saveReason || "当前不能保存消息。"), steerNote: note };
    return { ...base, enter: "post", modEnter: "post", sendMode: "queue", disabledReason: null, steerNote: note,
      hint: queueOnlyHint };
  }
  if (direct?.mode === "start") return { ...base, enter: "start", modEnter: post, sendMode: "send", disabledReason: null, queueNote,
    hint: post ? "Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息" : "Enter 立即开始一轮" };
  if (!post) return off(facts.saveReason || "当前不能保存消息。");
  return { ...base, enter: "post", modEnter: "post", sendMode: "send", disabledReason: null, hint: "Enter 保存并按顺序处理" };
}

/**
 * What the person is told after a message went out, in the words of the two ways: 已插入当前这一轮, 已转排队 (with the
 * reason the Turn could not take it), 已排队, or 已开始新的一轮. Never says the agent has read it.
 */
export type SentResult = { kind: "inserted" | "started" | "queued" | "converted"; reason?: string | null };
export function sentResultText(result: SentResult): string {
  switch (result.kind) {
    case "inserted": return "已插入当前这一轮：运行时已接收，不代表智能体已阅读或采用。";
    case "started": return "已开始新的一轮：运行时已接收，不代表智能体已阅读或采用。";
    case "queued": return "已发出，已排队：开始处理时这里会更新，输入框上方可撤回。";
    case "converted": return `没有插入，已转排队：${convertedReason(result.reason)}这条消息已按排队保存，只有一条，输入框上方可撤回。`;
  }
}
function convertedReason(reason: string | null | undefined): string {
  if (!reason) return "";
  if (/^TURN_CHANGED/.test(reason)) return "你看到的那一轮已经换了或已结束；";
  if (/^NOT_BOUND/.test(reason)) return "这一轮刚开始、还没准备好接收补充；";
  if (/Native Turn kind/.test(reason)) return "这一轮的类型不接受补充（评审、压缩等）；";
  return "运行时说明见完整标识；";
}

/** The message text with the chosen skill named on its first line; the runtime reads it as part of the message. */
export function messageWithSkill(content: string, skill: { name: string; slug: string } | null): string {
  return skill ? `使用技能：${skill.name}（${skill.slug}）\n${content}` : content;
}

/**
 * The agents @ offers, without the page's own agent, each with the name the text will carry. Agents whose names
 * collide (two unregistered external agents of one role) carry their short identifier, so the menu, the text and the
 * copies sent from it never confuse one with the other.
 */
export function mentionCandidates<T extends AgentNameSource & { key: string }>(items: readonly T[], currentKey: string): Array<{ item: T; name: string }> {
  const others = items.filter(item => item.key !== currentKey);
  const collisions = agentNameCollisions(others);
  return others.map(item => {
    const short = collisions.get(item.key);
    return { item, name: short ? `${agentDisplayName(item)}（标识 ${short}）` : agentDisplayName(item) };
  });
}

/** The agents named with @ that are still in the text when it is sent. */
export function mentionedAgents<T extends { name: string }>(content: string, picked: readonly T[]): T[] {
  const seen = new Set<string>();
  return picked.filter(agent => {
    if (seen.has(agent.name) || !new RegExp(`(^|\\s)@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(content)) return false;
    seen.add(agent.name); return true;
  });
}

/** The usage line under the composer: the share of the context window the last turn used, when both are known. */
export function contextUseText(usage: { last: { totalTokens: number | null }; modelContextWindow: number | null } | null | undefined): string | null {
  const used = usage?.last.totalTokens, window = usage?.modelContextWindow;
  if (used == null || !window) return null;
  return `上下文 ${Math.min(100, Math.round(used / window * 100))}%`;
}

/** What the agent's state means for the message about to be sent (said before sending, in the words of its state right now). */
export interface DestinationFacts {
  kind: "owned" | "external";
  /** A turn is running now. */
  running: boolean;
  /** The Task being worked on, when the turn is a Task's run and its title is read. */
  taskTitle: string | null;
  /** The running turn answers a message (no Task). */
  replying: boolean;
  /** The provider is paused: its cause in words, "" when the cause is not read, null when not paused. */
  held: string | null;
  /** Enter would start a turn at once (the runtime declared it can). */
  startsAtOnce: boolean;
  /** Insertion into the running turn is available as an explicit choice. */
  canInsert: boolean;
}
export function destinationNote(f: DestinationFacts): string {
  if (f.kind === "external") return "这是外部智能体：消息只保存，需要人工转交，不会自动处理。";
  if (f.held !== null) return `${f.held ? `已暂停（${f.held}）` : "已暂停"}。现在发的消息会保存排队，恢复前不会处理。`;
  if (f.running) {
    const doing = f.taskTitle ? `它正在做任务「${f.taskTitle}」` : f.replying ? "它正在回复一条消息" : "它正在工作";
    return `${doing}。这条消息默认排在这一轮之后，不打断它。${f.canInsert ? `要现在就插入${f.taskTitle ? `这项任务「${f.taskTitle}」` : "这一轮"}，点“插入当前这一轮”。` : ""}`;
  }
  return f.startsAtOnce ? "它现在空闲：这条消息会马上开始处理并回复。" : "它现在空闲：这条消息保存后按顺序处理。";
}

/** The single receipt of a sent message: it changes in place from 已发出 to 处理中 to 已回复, or says why it failed. */
export type ReceiptPhase = "sent" | "working" | "replied" | "failed";
export function receiptPhase(state: string | null): ReceiptPhase {
  switch (state) {
    case null: case "pending": case "unknown": return "sent";
    case "running": return "working";
    case "completed": return "replied";
    default: return "failed";
  }
}
export const receiptText: Record<Exclude<ReceiptPhase, "sent">, string> = {
  working: "处理中：它已开始处理这条消息。",
  replied: "已回复：回复在上方对话里。",
  failed: "没有处理成功：处理失败或被中断，详情见这条消息的“消息详情”。",
};
