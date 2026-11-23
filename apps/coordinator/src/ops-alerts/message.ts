import type { AlertMessage } from "./outlet.js";
import { redact } from "../session-messages/error-line.js";

export interface PendingWork { ready: number; queued: number; awaitingAcceptance: number }
export interface AffectedSession { sessionId: string; role: string | null }
export interface AlertDetails {
  provider?: string; category?: string; reason?: string; heldAt?: string;
  releasedBy?: string; releaseReason?: string;
  sessions?: AffectedSession[]; sessionTotal?: number; pending?: PendingWork;
  lastRunAt?: string | null; stallMinutes?: number;
  /** Sessions a provider pause explains (their work is not counted), by provider; set only when a pause is open. */
  pausedSessions?: { provider: string; sessions: number }[];
  /** Scheduling stall: the scheduler's state, the start of its last error, its last tick, the silence limit in minutes. */
  schedulingState?: string; lastError?: string | null; lastTickAt?: string | null; thresholdMinutes?: number;
}

const providerName = (provider: string | undefined) => provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider ?? "未知提供方";
const categoryText = (category: string | undefined) => category === "quota_exhausted" ? "额度用完" : category === "authentication_failed" ? "认证失败" : category ?? "原因未记录";
const total = (pending: PendingWork | undefined) => pending ? pending.ready + pending.queued + pending.awaitingAcceptance : 0;
const pendingText = (pending: PendingWork | undefined) => pending
  ? `压着 ${total(pending)} 件活（就绪未派 ${pending.ready}，在队伍里排队 ${pending.queued}，等验收 ${pending.awaitingAcceptance}）` : "压着的活数未读到";
const sessionsText = (details: AlertDetails) => {
  const list = details.sessions ?? [];
  if (!list.length) return "没有受影响的 Session";
  const shown = list.slice(0, 6).map(s => `${s.role ?? "未命名职责"}（${s.sessionId.slice(0, 8)}）`).join("、");
  const extra = (details.sessionTotal ?? list.length) - Math.min(list.length, 6);
  return `${details.sessionTotal ?? list.length} 个 Session 受影响：${shown}${extra > 0 ? ` 等另外 ${extra} 个` : ""}`;
};
const duration = (from: string, to: string) => {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
};

/** The alert as it is sent. Times are UTC ISO strings, so a reader in any zone can place them. Free text from a provider is redacted and cut short. */
export function buildAlert(input: { projectId: string; key: string; kind: "provider_hold" | "stall" | "scheduling_stall"; event: "opened" | "resolved"; openedAt: string; resolvedAt: string | null; details: AlertDetails }): AlertMessage {
  const { projectId, key, kind, event, openedAt, resolvedAt, details } = input;
  const reason = details.reason ? redact(details.reason).replace(/\s+/g, " ").slice(0, 200) : "";
  let text: string;
  if (kind === "provider_hold" && event === "opened") {
    text = `【evoLoop 告警】${providerName(details.provider)} 提供方已暂停（${categoryText(details.category)}）。从 ${openedAt} 起不再开始新的 Turn；${sessionsText(details)}；当时${pendingText(details.pending)}。${reason ? `原因：${reason}。` : ""}放行后会再发一条恢复消息。`;
  } else if (kind === "provider_hold") {
    text = `【evoLoop 恢复】${providerName(details.provider)} 提供方已放行，共暂停 ${duration(openedAt, resolvedAt ?? openedAt)}（${openedAt} 至 ${resolvedAt}）。${details.releasedBy ? `放行人 ${details.releasedBy}。` : ""}${details.releaseReason ? `理由：${redact(details.releaseReason).replace(/\s+/g, " ").slice(0, 200)}。` : ""}`;
  } else if (kind === "scheduling_stall" && event === "opened") {
    const error = details.lastError ? redact(details.lastError).replace(/\s+/g, " ").slice(0, 120) : "";
    text = `【evoLoop 告警】排程停摆：项目 ${projectId} 的排程状态为 ${details.schedulingState ?? "未知"}${error ? `，最近错误：${error}` : ""}；最近一次轮询在 ${details.lastTickAt ?? "（还没有）"}，超过 ${details.thresholdMinutes ?? 5} 分钟没有推进或仍在报错。从 ${openedAt} 起记为停摆，日程在此期间不会开 Run；恢复后会再发一条恢复消息。`;
  } else if (kind === "scheduling_stall") {
    text = `【evoLoop 恢复】排程已恢复，停摆共持续 ${duration(openedAt, resolvedAt ?? openedAt)}（${openedAt} 至 ${resolvedAt}）。`;
  } else if (event === "opened") {
    const paused = (details.pausedSessions ?? []).filter(p => p.sessions > 0);
    const pausedText = paused.length ? `另有 ${paused.reduce((n, p) => n + p.sessions, 0)} 个 Session 因 ${paused.map(p => providerName(p.provider)).join("、")} 暂停，它们名下的活没有计入。` : "";
    text = `【evoLoop 告警】已超过 ${details.stallMinutes ?? 30} 分钟没有新的 Run，但还有活在等：${pendingText(details.pending)}。${details.lastRunAt ? `最近一次 Run 在 ${details.lastRunAt}。` : "项目里还没有 Run。"}从 ${openedAt} 起记为停摆。${pausedText}有新 Run 或没有活在等时会再发一条恢复消息。`;
  } else {
    text = `【evoLoop 恢复】停摆已解除，共持续 ${duration(openedAt, resolvedAt ?? openedAt)}（${openedAt} 至 ${resolvedAt}）。`;
  }
  return { schema: "evoloop.alert.v1", projectId, key, kind, event, text, facts: { openedAt, resolvedAt, ...details, ...(reason ? { reason } : {}) } };
}
