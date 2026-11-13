// A queued message as one short line: the Leader notices the coordinator saves are English text with long IDs, so the
// list says what happened in Chinese (kind, task, time) and keeps the original behind “原文与标识”.
import { grantRefusalText } from "../../shared/errorPresentation";
const kinds: Array<[prefix: string, label: string]> = [
  ["A Task was created for Leader triage", "新 Task 待安排"],
  ["A fixed Delivery was recorded", "交付已提交"],
  ["An independent use observation was recorded", "独立使用观察已记录"],
  ["A Task recipient asked a question", "承接者提了问题"],
  ["A Task recipient reported a blocker", "承接者报告了阻塞"],
  ["A terminal Run has no signed submission", "Run 已结束但没有签名提交"],
  ["A signed Run submission cannot be sealed", "签名提交无法封存"],
  ["A current Task attention item needs a Leader follow-up", "Task 关注项待跟进"],
  ["An acceptance handoff is blocked and needs a Leader decision", "验收交接受阻，待决定"],
];

export interface QueuedMessageSummary {
  /** The Chinese kind, or null for a message that is not one of these notices. */
  label: string | null;
  /** When the source event happened, read from the notice; null when it does not say. */
  occurredAt: string | null;
  /** The Task the notice is about, from its “Source Task revision” line. */
  taskId: string | null;
  /** The first line, shortened, for a message that is not a notice. */
  preview: string;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const previewLimit = 80;

export function queuedMessageSummary(body: string, originTaskId?: string | null): QueuedMessageSummary {
  const first = body.split("\n")[0]?.trim() ?? "";
  const kind = kinds.find(([prefix]) => first.startsWith(prefix));
  const at = /^Source event: \S+ at (\S+)/m.exec(body)?.[1] ?? null;
  const task = new RegExp(`^Source Task revision: (${uuid})@`, "im").exec(body)?.[1] ?? originTaskId ?? null;
  const preview = first.length > previewLimit ? `${first.slice(0, previewLimit)}…` : first;
  return { label: kind?.[1] ?? null, occurredAt: kind && at && !Number.isNaN(Date.parse(at)) ? at : null, taskId: kind ? task : null, preview: preview || "（没有可公开的正文）" };
}

const grantBlockPrefix = "MESSAGE_GRANT_MISSING:";
/** The message's own words for what is missing, without the code the queue uses to skip it. */
export function grantBlockText(blockedReason: string | null | undefined): string | null {
  return blockedReason?.startsWith(grantBlockPrefix) ? grantRefusalText(blockedReason.slice(grantBlockPrefix.length).trim()) : null;
}

export interface GrantBlockedNotice {
  count: number;
  /** The senders whose messages wait for a grant, in order of first appearance. */
  senders: string[];
  /** What the first blocked message says is missing. */
  reason: string;
}
/**
 * Saved messages that wait only because their sender has no message grant. They do not hold the queue, so the page says
 * so: they are not delivered until the grant exists, and the messages behind them are handled as usual.
 */
export function grantBlockedNotice(entries: ReadonlyArray<{ kind: string; role?: string; state?: string; blockedReason?: string | null; author?: { id: string | null; label: string } }>): GrantBlockedNotice | null {
  const blocked = entries.filter(entry => entry.kind === "message" && entry.role === "input" && entry.state === "pending" && grantBlockText(entry.blockedReason) !== null);
  if (!blocked.length) return null;
  const senders = [...new Set(blocked.map(entry => entry.author?.label ?? entry.author?.id ?? "未知发送者"))];
  return { count: blocked.length, senders, reason: grantBlockText(blocked[0]!.blockedReason)! };
}
