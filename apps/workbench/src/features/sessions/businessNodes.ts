// Business nodes on the conversation timeline (Task 13518ac6): the steps the records show for the Tasks this agent accepted
// (接手, 交付, 验收结论, 关闭), one line each, placed between the rounds by the time they happened. Nothing here reads the network.
import type { BusinessNode, SessionActivity } from "@evoloop/contracts/session-observation";
import type { StatusTone } from "@evoloop/ui";
import { actorText } from "../../shared/actorPresentation";
import type { TimelineRow } from "./timelineRounds";

export type NodeActivity = SessionActivity & { node: BusinessNode };
export const isNodeActivity = (item: SessionActivity): item is NodeActivity => item.node !== undefined;

const resultText = { used: "已使用", failed: "使用失败", notUsed: "未使用" } as const;

/** The status mark of a node: its kind and, for an acceptance conclusion, its result. Never the line's background. */
export function nodeMark(node: BusinessNode): { tone: StatusTone; label: string } {
  switch (node.kind) {
    case "accepted": return { tone: "progress", label: "接手" };
    case "delivered": return node.technicalResult === "failed" ? { tone: "blocked", label: "交付" } : { tone: "waiting", label: "交付" };
    case "observed": return { tone: node.result === "used" ? "done" : node.result === "failed" ? "blocked" : "idle", label: "验收" };
    case "closed": return node.cancelled ? { tone: "history", label: "已取消" } : { tone: "done", label: "已关闭" };
  }
}

/** The words of a node, in the order the Task asks for; the Task's title is said by `title`. `me` is the reader's actor id. */
export function nodeText(node: BusinessNode, me?: string): string {
  switch (node.kind) {
    case "accepted": return `接手了「${node.title}」${node.by ? ` · ${actorText(node.by, me)}分派` : ""}`;
    case "delivered": return `提交了第 ${node.number} 份交付 · ${node.artifact.label}${node.technicalResult === "failed" ? " · 技术检查未通过" : ""}`;
    case "observed": return `验收：${resultText[node.result]}${node.deliveryNumber ? `（第 ${node.deliveryNumber} 份）` : ""} · ${actorText(node.observer, me)}${node.reason ? ` · ${node.reason}` : ""}`;
    case "closed": return `${node.cancelled ? "任务已取消" : "任务已关闭"} · ${actorText(node.by, me)}`;
  }
}

/** Where a node leads: the Task, and for a delivery or its acceptance the 交付与使用 tab on that delivery. */
export function nodeHref(node: BusinessNode, taskHref: (taskId: string) => string): string {
  const base = taskHref(node.taskId);
  if (node.kind !== "delivered" && node.kind !== "observed") return base;
  const [path, query = ""] = base.split("?");
  const params = new URLSearchParams(query);
  params.set("tab", "delivery");
  params.set("delivery", node.deliveryId);
  return `${path}?${params.toString()}`;
}

export type RowWithNodes = TimelineRow | { kind: "node"; id: string; item: NodeActivity };

const ms = (value: string | null | undefined): number | null => { const time = value ? Date.parse(value) : NaN; return Number.isNaN(time) ? null : time; };
const rowTime = (row: TimelineRow): number | null => ms(row.kind === "round" ? row.round.at ?? row.round.sentAt : row.rounds[0]?.at ?? row.rounds[0]?.sentAt);

/**
 * Nodes among the rows, each after the last row that began no later than the node did (a row with no time takes its neighbour's),
 * so a conclusion recorded long after its round stands at its own time. A coordination group is one row, so nodes never split it.
 * Nodes older than every row come first; the order of the rows themselves is never changed.
 */
export function rowsWithNodes(rows: readonly TimelineRow[], nodes: readonly NodeActivity[]): RowWithNodes[] {
  if (!nodes.length) return [...rows];
  const times: number[] = []; let floor = -Infinity;
  for (const row of rows) { const time = rowTime(row); if (time !== null && time > floor) floor = time; times.push(floor); }
  const sorted = [...nodes].sort((a, b) => (ms(a.occurredAt) ?? 0) - (ms(b.occurredAt) ?? 0) || a.id.localeCompare(b.id));
  const result: RowWithNodes[] = [];
  let next = 0;
  const flushBefore = (limit: number) => {
    while (next < sorted.length && (ms(sorted[next]!.occurredAt) ?? 0) < limit) { const item = sorted[next++]!; result.push({ kind: "node", id: `node:${item.id}`, item }); }
  };
  flushBefore(times[0] ?? Infinity);
  rows.forEach((row, index) => {
    result.push(row);
    // Nodes up to where the next row begins go after this one.
    flushBefore(index + 1 < rows.length ? times[index + 1]! : Infinity);
  });
  return result;
}
