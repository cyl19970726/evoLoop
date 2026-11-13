/** The scheduling event stream and the work board (DEC-045 Q2). Metadata only: no message text, no Task or Run bodies. */
export type SchedEventCategory = "notice" | "task" | "message" | "acceptance";
export type SchedSubjectKind = "notice" | "packet" | "task" | "queue_entry" | "run" | "delivery" | "message" | "input" | "relay" | "observation" | "closure" | "review" | "mark";

export interface SchedEvent {
  /** Increasing; the cursor of the stream. Gaps between two events of one project are normal. */
  seq: number;
  at: string;
  category: SchedEventCategory;
  /** e.g. task.queued, task.turn, notice.sent, message.inserted, acceptance.observed. */
  kind: string;
  /** From whom to whom: an actor ID, `leader`, or `system` (a platform part). */
  from: string | null;
  to: string | null;
  sessionId: string | null;
  subject: { kind: SchedSubjectKind; id: string; /** The Task's current title when the event is about a Task. */ title: string | null; /** API path that opens the subject (or its Task). */ link: string | null };
  taskId: string | null;
  /** The state before and after the change (a queue position for task.reordered; the method for notice.sent). */
  prior: string | null;
  next: string | null;
}

export interface SchedEventsPage {
  items: SchedEvent[];
  /** Pass as `after` to continue; the last seq returned, or the head when nothing is new. */
  cursor: number;
  /** The newest seq of the project (0 when none). */
  head: number;
  /** The cursor is at or below what retention purged, or ahead of the head: read the snapshot again, then continue from its `eventSeq`. */
  resetRequired: boolean;
  /** More events wait behind this page. */
  more: boolean;
}

export const schedEventRetentionDays = 30;

export interface WorkBoardWork { kind: "run" | "message" | "input"; id: string; taskId: string | null; taskTitle: string | null; startedAt: string | null; elapsedSeconds: number | null }
export interface WorkBoardQueueItem { entryId: string; taskId: string; taskTitle: string | null; position: number; state: string; holdCode: string | null; source: string | null; addedAt: string; waitedSeconds: number }
export interface WorkBoardSession {
  sessionId: string; roleId: string; roleTitle: string | null; state: string; provider: string | null;
  /** Running now: the Run, or the message / direct input whose Turn is running; null when idle. */
  current: WorkBoardWork | null;
  queue: WorkBoardQueueItem[];
  /** Queued ordinary messages waiting for this Session. */
  queuedMessages: number;
  health: { recoveryGate: string; gateCause: string | null; providerHeld: boolean };
}
export interface WorkBoardWaitingTask { taskId: string; title: string | null; state: string; since: string }
/**
 * A recovery gate that has been closed for GATE_ATTENTION_MINUTES with messages queued behind it (defect d6dd0a1e: a gate stayed closed for 20 hours
 * with nothing to say so). The item is computed on every read from the gate and the queue, so it is there exactly while the gate is closed and
 * something waits, and it disappears when the gate reopens. `id` is the Session; `waitingOn` is who last decided for this gate (who can resume
 * it), or null when nobody has decided yet: then any reviewer can run runtime.session.recovery.resume.
 */
export const GATE_ATTENTION_MINUTES = 30;
export interface WorkBoardLeaderItem {
  kind: "notice" | "decision" | "blocked_packet" | "recovery_gate"; id: string; taskId: string | null; title: string | null; state: string; since: string;
  waitingOn?: { kind: "actor" | "reviewer"; id: string | null } | null;
}
export interface WorkBoardNode { id: string; kind: "session" | "leader" | "packets"; label: string }
export interface WorkBoardInFlight { kind: "queue_entry" | "run" | "message" | "packet" | "acceptance"; id: string; title: string | null; state: string; sessionId: string | null }
export interface WorkBoardSnapshot {
  projectId: string; observedAt: string;
  /** The newest event seq when the snapshot was read: continue the stream `after` it. */
  eventSeq: number;
  sessions: WorkBoardSession[];
  /** Ready (todo) Tasks that are in no Session's line and have no assignment. */
  readyNotQueued: WorkBoardWaitingTask[];
  /** What waits for the Leader's decision. */
  awaitingLeader: WorkBoardLeaderItem[];
  /** For the page: the nodes, what is in flight and how many there are per step. */
  graph: { nodes: WorkBoardNode[]; inFlight: WorkBoardInFlight[]; counts: Record<string, number> };
}

/** Three measures worked out from the events alone. Durations in seconds; null when there is nothing to measure. */
export interface WorkBoardMetrics {
  from: string; to: string; events: number;
  /** From a Task joining a line (task.queued) to its turn (task.turn), by who added it. */
  queueWait: Array<{ source: string; count: number; medianSeconds: number | null; p95Seconds: number | null }>;
  /** Per Session: seconds with nothing running while something was queued (an entry waiting or a message queued) against the whole window. */
  sessionIdle: Array<{ sessionId: string; idleWithWorkSeconds: number; windowSeconds: number }>;
  /** From a notice being created to its packet being sent (opening a Turn or going into one) or the notice itself being sent. */
  noticeIntake: { count: number; medianSeconds: number | null; p95Seconds: number | null };
}
