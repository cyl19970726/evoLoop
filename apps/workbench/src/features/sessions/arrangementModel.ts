// The 统筹安排 board: who works on what, who is free, and the conflicts the records themselves prove.
// Pure functions so the rules can be tested without a browser. Nothing here guesses: a Session whose
// occupation is unknown stays unknown, a read that is missing or incomplete never turns into "free",
// and only open Leader-index Tasks are counted.
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { ResidentQueue, QueueHoldCode } from "@evoloop/contracts/queues";

export type AgentLoad = "overloaded" | "busy" | "idle" | "unknown";

/** What the page managed to read. Free capacity needs every open Task and the queues. */
export interface ArrangementEvidence {
  /** Every open Task was read: all pages, none partial. */
  tasksComplete: boolean;
  /** The resident queues were read. */
  queuesRead: boolean;
  /** The whole current agent directory was read (no page left). */
  directoryComplete: boolean;
}

export interface QueuedWork {
  taskId: string;
  title: string;
  position: number;
  held: boolean;
  holdCode: QueueHoldCode | null;
}

export interface ArrangementRow {
  session: ObservedSession;
  /** Assigned Tasks the Leader index reports as running. */
  running: LeaderWorkTask[];
  /** Other open Tasks assigned to this Session (waiting to start, delivery, acceptance …). */
  assigned: LeaderWorkTask[];
  /** Entries of adopted resident queues not yet claimed, excluding Tasks already listed above. */
  queued: QueuedWork[];
  load: AgentLoad;
}

/** Tasks assigned to a target that is not among the agents read (closed, historical, external or beyond the pages read). */
export interface ElsewhereGroup {
  target: string;
  label: string;
  tasks: LeaderWorkTask[];
}

export type RiskKind = "parallel" | "dependency" | "overdue" | "no_acceptor";

export interface ArrangementRisk {
  kind: RiskKind;
  title: string;
  detail: string;
  taskIds: string[];
  sessionKey: string | null;
  /** The due time for overdue risks, formatted by the page. */
  at?: string;
}

export interface Arrangement {
  rows: ArrangementRow[];
  elsewhere: ElsewhereGroup[];
  unassigned: LeaderWorkTask[];
  risks: ArrangementRisk[];
  /** Open Tasks due within `dueSoonMs`, earliest first; overdue ones are risks instead. */
  dueSoon: LeaderWorkTask[];
  leader: ObservedSession | null;
  /** Tasks placed under an agent because a resident-queue entry claimed them, not through an assignment. */
  claimed: ReadonlySet<string>;
  evidence: ArrangementEvidence;
}

export const dueSoonMs = 3 * 24 * 60 * 60 * 1000;
const startedPhases = new Set<LeaderWorkTask["phase"]>(["running", "awaiting_delivery", "awaiting_acceptance", "rework"]);

export function targetKeyOf(target: ObservedSession["target"]): string {
  return target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
}

function assignmentKey(task: LeaderWorkTask): string | null {
  const assignment = task.assignment;
  if (!assignment || assignment.state === "released") return null;
  return `${assignment.targetKind}:${assignment.targetId}`;
}

function isOpen(task: LeaderWorkTask): boolean {
  return task.taskState !== "done" && task.taskState !== "cancelled" && task.phase !== "closed" && task.phase !== "cancelled";
}

/** Same rule as the queue panel and the overview: only the adopted current version dispatches. */
export function queueAdopted(queue: Pick<ResidentQueue, "adoptedVersion" | "version">): boolean {
  return queue.adoptedVersion !== null && queue.adoptedVersion === queue.version;
}

function quoted(title: string): string {
  return `「${title}」`;
}

export function isLeaderSession(session: Pick<ObservedSession, "roles">): boolean {
  return session.roles.some(role => role.templateKey === "lead");
}

export function agentLoad(session: ObservedSession, running: number,
  evidence: Pick<ArrangementEvidence, "tasksComplete" | "queuesRead">): AgentLoad {
  if (running > 1) return "overloaded";
  if (running === 1 || session.busy === true) return "busy";
  // Without every open Task and the queues, "nothing found" is not "nothing there".
  if (!evidence.tasksComplete || !evidence.queuesRead) return "unknown";
  // Closing, reserved or a lifecycle still to be checked is not spare capacity.
  if (session.kind === "owned" && session.runtimeState !== "ready") return "unknown";
  if (session.busy === false) return "idle";
  return "unknown";
}

export function buildArrangement(sessions: readonly ObservedSession[], tasks: readonly LeaderWorkTask[],
  queues: readonly ResidentQueue[], now: number, evidence: ArrangementEvidence): Arrangement {
  const open = tasks.filter(isOpen);
  // A claimed queue entry occupies its agent even without an assignment record.
  const claimedBy = new Map<string, string>();
  for (const queue of queues) for (const entry of queue.entries)
    if (entry.state === "claimed") claimedBy.set(entry.taskId, `owned:${entry.sessionId}`);
  const byTarget = new Map<string, LeaderWorkTask[]>();
  const unassigned: LeaderWorkTask[] = [];
  const claimed = new Set<string>();
  for (const task of open) {
    let key = assignmentKey(task);
    if (!key && claimedBy.has(task.taskId)) { key = claimedBy.get(task.taskId)!; claimed.add(task.taskId); }
    if (!key) { unassigned.push(task); continue; }
    byTarget.set(key, [...byTarget.get(key) ?? [], task]);
  }
  const titles = new Map(tasks.map(task => [task.taskId, task.title]));
  const queuedBySession = new Map<string, QueuedWork[]>();
  for (const queue of queues) {
    if (!queueAdopted(queue)) continue;
    for (const entry of queue.entries) {
      if (entry.state !== "queued" && entry.state !== "held") continue;
      const key = `owned:${entry.sessionId}`;
      queuedBySession.set(key, [...queuedBySession.get(key) ?? [], {
        taskId: entry.taskId, title: titles.get(entry.taskId) ?? "任务名称待核对", position: entry.position,
        held: entry.state === "held", holdCode: entry.holdCode,
      }]);
    }
  }
  const known = new Set<string>();
  const rows = sessions.map(session => {
    // Work may be recorded against any attachment of the same agent.
    const keys = [...new Set([session.target, ...session.aliases].map(targetKeyOf))];
    for (const key of keys) known.add(key);
    const mine = [...new Map(keys.flatMap(key => byTarget.get(key) ?? []).map(task => [task.taskId, task])).values()];
    const running = mine.filter(task => task.phase === "running");
    const assigned = mine.filter(task => task.phase !== "running");
    const listed = new Set(mine.map(task => task.taskId));
    const queued = [...new Map(keys.flatMap(key => queuedBySession.get(key) ?? []).map(item => [item.taskId, item])).values()]
      .filter(item => !listed.has(item.taskId)).sort((a, b) => a.position - b.position);
    return { session, running, assigned, queued, load: agentLoad(session, running.length, evidence) };
  });
  const where = evidence.directoryComplete ? "不在当前目录" : "未读到";
  const elsewhere = [...byTarget].filter(([key]) => !known.has(key)).map(([target, items]) => ({
    target, tasks: items,
    label: target.startsWith("external:") ? `外部接入 · ${where}` : `受管智能体 · ${where}`,
  }));
  const risks: ArrangementRisk[] = [];
  for (const row of rows) if (row.running.length > 1) risks.push({
    kind: "parallel", sessionKey: row.session.key, taskIds: row.running.map(task => task.taskId),
    title: `${row.session.title} 同时有 ${row.running.length} 项进行中的任务`,
    detail: row.running.map(task => quoted(task.title)).join("、"),
  });
  for (const group of elsewhere) {
    const running = group.tasks.filter(task => task.phase === "running");
    if (running.length > 1) risks.push({
      kind: "parallel", sessionKey: null, taskIds: running.map(task => task.taskId),
      title: `${group.label}的承接者同时有 ${running.length} 项进行中的任务`,
      detail: running.map(task => quoted(task.title)).join("、"),
    });
  }
  for (const task of open) {
    // The server's own gate: a dependency counts once its current revision is accepted, not when its state says done.
    const pending = task.dependencies.filter(dependency => !dependency.acceptanceSatisfied);
    if (pending.length && (startedPhases.has(task.phase) || task.dates.startedAt)) risks.push({
      kind: "dependency", sessionKey: null, taskIds: [task.taskId, ...pending.map(dependency => dependency.taskId)],
      title: `${quoted(task.title)}已开始，但依赖还没通过验收`,
      detail: pending.length === 1 ? `依赖${quoted(pending[0]!.title)}` : `依赖${quoted(pending[0]!.title)}等 ${pending.length} 项`,
    });
    const due = task.plan?.dueAt ? Date.parse(task.plan.dueAt) : NaN;
    if (Number.isFinite(due) && due < now) risks.push({
      kind: "overdue", sessionKey: null, taskIds: [task.taskId],
      title: `${quoted(task.title)}已过截止时间`, detail: "", at: task.plan!.dueAt!,
    });
    if (task.phase === "awaiting_acceptance" && (task.responsible.kind === "unknown" || !task.responsible.id)) risks.push({
      kind: "no_acceptor", sessionKey: null, taskIds: [task.taskId],
      title: `${quoted(task.title)}待验收，但下一责任未登记`, detail: "",
    });
  }
  const dueSoon = open.filter(task => {
    const due = task.plan?.dueAt ? Date.parse(task.plan.dueAt) : NaN;
    return Number.isFinite(due) && due >= now && due - now <= dueSoonMs;
  }).sort((a, b) => Date.parse(a.plan!.dueAt!) - Date.parse(b.plan!.dueAt!));
  // Agents with work first (busiest first), then the free ones; ties keep the directory order.
  const rank: Record<AgentLoad, number> = { overloaded: 0, busy: 1, unknown: 2, idle: 3 };
  const withWork = (row: ArrangementRow) => row.running.length + row.assigned.length + row.queued.length > 0 ? 0 : 1;
  const ordered = rows.map((row, index) => ({ row, index }))
    .sort((a, b) => withWork(a.row) - withWork(b.row) || rank[a.row.load] - rank[b.row.load] || a.index - b.index)
    .map(item => item.row);
  return { rows: ordered, elsewhere, unassigned, risks, dueSoon, leader: sessions.find(isLeaderSession) ?? null, claimed, evidence };
}

/** Free capacity: no work in flight and nothing assigned or queued. Unknown occupation is never free. */
export function freeAgents(arrangement: Arrangement): ArrangementRow[] {
  return arrangement.rows.filter(row => row.load === "idle" && !row.assigned.length && !row.queued.length && !isLeaderSession(row.session));
}

export interface FreeCapacity {
  /** False while Tasks or queues are missing or incomplete; then nobody is called free. */
  judged: boolean;
  free: ArrangementRow[];
  /** Agents other than the Leader. */
  others: number;
  /** Agents other than the Leader whose occupation stays unknown. */
  unknown: number;
}

export function freeCapacity(arrangement: Arrangement): FreeCapacity {
  const { tasksComplete, queuesRead } = arrangement.evidence;
  const others = arrangement.rows.filter(row => !isLeaderSession(row.session));
  return {
    judged: tasksComplete && queuesRead, free: freeAgents(arrangement), others: others.length,
    unknown: others.filter(row => row.load === "unknown").length,
  };
}
