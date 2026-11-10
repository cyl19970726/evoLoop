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
}

export interface ComposerPlan {
  enter: ComposerAction | null;
  modEnter: "post" | null;
  sendMode: ComposerSendMode;
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

const defaultPlaceholder = "发消息，/ 调用技能，@ 转给其他智能体";

/** Why the running turn cannot take an addition now, from the reason the runtime's capability gives. */
const steerReasons: Record<string, string> = {
  FORBIDDEN: "当前身份不能即时输入，不能补充到这一轮",
  NATIVE_UNAVAILABLE: "运行时连接暂不可用，不能补充到这一轮",
  DIRECT_GRANT_MISSING: "这个智能体没有即时输入的授权，不能补充到这一轮",
  SESSION_BUSY: "这一轮正在做的工作不接受补充",
  DIRECT_STEER_DISABLED: "这个智能体的运行时或授权不支持补充到这一轮",
  NATIVE_TURN_NOT_ACTIVE: "运行时里这一轮已经不在进行，不能补充",
  NATIVE_TURN_UNKNOWN: "运行时里这一轮的状态无法判断，暂不补充",
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
  const base = { running, steerNote: null, queueNote: null, placeholder: defaultPlaceholder };
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
    if (direct?.mode === "steer") return { ...base, enter: "steer", modEnter: post, sendMode: "steer", disabledReason: null, queueNote,
      hint: post ? "Enter 补充到这一轮 · ⌘/Ctrl+Enter 排到下一轮" : "Enter 补充到这一轮", placeholder: "补充到这一轮…" };
    const note = steerNote(facts.direct, facts.directPending);
    if (!post) return { ...off(facts.saveReason || "当前不能保存消息。"), steerNote: note };
    return { ...base, enter: "post", modEnter: "post", sendMode: "queue", disabledReason: null, steerNote: note,
      hint: `${note}；Enter 排到下一轮` };
  }
  if (direct?.mode === "start") return { ...base, enter: "start", modEnter: post, sendMode: "send", disabledReason: null, queueNote,
    hint: post ? "Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息" : "Enter 立即开始一轮" };
  if (!post) return off(facts.saveReason || "当前不能保存消息。");
  return { ...base, enter: "post", modEnter: "post", sendMode: "send", disabledReason: null, hint: "Enter 保存并按顺序处理" };
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
