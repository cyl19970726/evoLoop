import type { Pool } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import { GATE_ATTENTION_MINUTES, type SchedEvent, SchedEventsPage, WorkBoardInFlight, WorkBoardLeaderItem, WorkBoardQueueItem, WorkBoardSession, WorkBoardSnapshot, WorkBoardWaitingTask, WorkBoardWork } from "@evoloop/contracts/work-board";

type Db = Pick<Pool, "query">;
const iso = (v: Date | string | null): string | null => v === null ? null : v instanceof Date ? v.toISOString() : v;
const num = (v: unknown): number => Number(v);

/** Where an event's subject can be opened (API paths that exist today); null when the subject has no read of its own. */
function linkOf(projectId: string, kind: string, id: string, taskId: string | null): string | null {
  const base = `/api/projects/${projectId}`;
  switch (kind) {
    case "task": return `${base}/tasks/${id}`;
    case "message": return `${base}/session-messages/${id}`;
    case "run": return `${base}/runtime/runs/${id}`;
    case "packet": return `${base}/leader-notice-packets/${id}`;
    default: return taskId ? `${base}/tasks/${taskId}` : null;
  }
}

export interface SchedEventQuery {
  /** Continue after this seq (exclusive). Absent: from the oldest retained event. */
  after?: number;
  limit: number;
  /** Replay by time: events with from <= at < to, in seq order. Used instead of `after`. */
  from?: string; to?: string;
  category?: string;
}

export async function headSeq(db: Db, projectId: string): Promise<number> {
  // After retention removed every event the head is the purge floor, not 0: a cursor at the head is then current, and a reader that
  // re-reads the snapshot and continues from its eventSeq is not told resetRequired again forever.
  const r = await db.query(`SELECT GREATEST(COALESCE((SELECT seq FROM sched_event WHERE project_id=$1 ORDER BY seq DESC LIMIT 1),0),
    COALESCE((SELECT floor_seq FROM sched_event_floor WHERE project_id=$1),0)) AS head`, [projectId]);
  return num(r.rows[0].head);
}

/** Tail and replay reads. A cursor read uses (project_id, seq); a time read uses (project_id, at, seq). */
export async function readSchedEvents(db: Db, projectId: string, query: SchedEventQuery): Promise<SchedEventsPage> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) throw new DomainError("INVALID_LIMIT", "Limit must be 1..500");
  const head = await headSeq(db, projectId);
  const timed = query.from !== undefined || query.to !== undefined;
  let resetRequired = false;
  if (!timed && query.after !== undefined) {
    const floor = (await db.query("SELECT floor_seq FROM sched_event_floor WHERE project_id=$1", [projectId])).rows[0]?.floor_seq;
    // Retention removed events the cursor has not seen, or the cursor is ahead of anything this project has (a restored database).
    resetRequired = (floor !== undefined && query.after < num(floor)) || query.after > head;
  }
  if (resetRequired) return { items: [], cursor: head, head, resetRequired: true, more: false };
  const params: unknown[] = [projectId, query.limit + 1];
  let where = "project_id=$1";
  if (timed) {
    if (query.from) { params.push(query.from); where += ` AND at>=$${params.length}`; }
    if (query.to) { params.push(query.to); where += ` AND at<$${params.length}`; }
    // Paging inside a time window continues behind the last seq returned.
    if (query.after !== undefined) { params.push(query.after); where += ` AND seq>$${params.length}`; }
  } else { params.push(query.after ?? 0); where += ` AND seq>$${params.length}`; }
  if (query.category) { params.push(query.category); where += ` AND category=$${params.length}`; }
  const rows = (await db.query(`SELECT seq,at,category,kind,session_id,task_id,from_ref,to_ref,subject_kind,subject_id,prior_state,new_state
    FROM sched_event WHERE ${where} ORDER BY seq LIMIT $2`, params)).rows;
  const page = rows.slice(0, query.limit);
  const taskIds = [...new Set(page.map(r => r.task_id).filter(Boolean))] as string[];
  const titles = new Map<string, string>();
  if (taskIds.length) {
    for (const r of (await db.query("SELECT task_id,title FROM task WHERE project_id=$1 AND task_id=ANY($2::uuid[])", [projectId, taskIds])).rows) titles.set(r.task_id, r.title);
  }
  const items: SchedEvent[] = page.map(r => ({
    seq: num(r.seq), at: iso(r.at)!, category: r.category, kind: r.kind, from: r.from_ref, to: r.to_ref, sessionId: r.session_id, taskId: r.task_id,
    subject: { kind: r.subject_kind, id: r.subject_id, title: r.task_id ? titles.get(r.task_id) ?? null : null, link: linkOf(projectId, r.subject_kind, r.subject_id, r.task_id) },
    prior: r.prior_state, next: r.new_state,
  }));
  return { items, cursor: items.at(-1)?.seq ?? (timed ? head : query.after ?? head), head, resetRequired: false, more: rows.length > query.limit };
}

const LIMITS = { sessions: 200, queue: 600, ready: 100, leader: 100, flight: 300 };

/** One read of the board, all in one consistent snapshot. Bounded; every query is project-scoped and index-led. */
export async function readWorkBoard(pool: Pool, projectId: string): Promise<WorkBoardSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const q = (text: string, params: unknown[] = [projectId]) => client.query(text, params).then(r => r.rows);
    const eventSeq = await headSeq(client, projectId);
    const sessionsRows = await q(`SELECT s.session_id,s.role_id,s.state,s.runtime_provider,
        (SELECT rr.proposal->>'title' FROM role_definition d JOIN role_revision rr ON rr.project_id=d.project_id AND rr.role_id=d.role_id AND rr.revision_id=d.current_revision_id
          WHERE d.project_id=s.project_id AND d.role_id::text=s.role_id::text) AS role_title,
        COALESCE(g.phase,'open') AS gate_phase, g.cause_kind,
        EXISTS(SELECT 1 FROM runtime_provider_hold h WHERE h.project_id=s.project_id AND h.provider=s.runtime_provider AND h.state='held') AS held,
        (SELECT count(*)::int FROM session_message m WHERE m.project_id=s.project_id AND m.session_id=s.session_id AND m.state='queued') AS queued_messages
      FROM runtime_session s LEFT JOIN session_recovery_gate g ON g.project_id=s.project_id AND g.session_id=s.session_id
      WHERE s.project_id=$1 AND s.state<>'closed' ORDER BY s.created_at, s.session_id LIMIT ${LIMITS.sessions}`);
    const runs = await q(`SELECT run_id,session_id,task_id,state,created_at,EXTRACT(EPOCH FROM (now()-created_at))::float AS elapsed,
        (SELECT title FROM task t WHERE t.project_id=r.project_id AND t.task_id=r.task_id) AS title
      FROM runtime_run r WHERE project_id=$1 AND state IN ('requested','dispatching','running','unknown')`);
    const turns = await q(`SELECT p.message_id,p.session_id,p.state,p.started_at,EXTRACT(EPOCH FROM (now()-p.started_at))::float AS elapsed,
        (SELECT 1 FROM session_direct_input d WHERE d.project_id=p.project_id AND d.input_id=p.message_id AND d.mode='start') AS from_input,
        m.context_task_id AS task_id,(SELECT title FROM task t WHERE t.project_id=p.project_id AND t.task_id=m.context_task_id) AS title
      FROM session_message_processing p JOIN session_message m ON m.project_id=p.project_id AND m.message_id=p.message_id
      WHERE p.project_id=$1 AND p.state IN ('dispatching','running','unknown')`);
    // The line Leaders and schedules append to (session_line_entry, Q1) and the older batch queue (resident_queue_entry); one list per Session.
    // A line entry's state is shown as it is: queued, suspended (held), starting (its turn has come, the start steps are running).
    const entries = await q(`SELECT * FROM (
        SELECT e.entry_id,e.session_id,e.task_id,e.position::bigint AS position,CASE e.state WHEN 'suspended' THEN 'held' WHEN 'starting' THEN 'claimed' ELSE e.state END AS state,
          e.suspend_reason AS hold_code,e.appended_at AS created_at,EXTRACT(EPOCH FROM (now()-e.appended_at))::float AS waited,e.source_actor_id AS source,
          (SELECT title FROM task t WHERE t.project_id=e.project_id AND t.task_id=e.task_id) AS title,'line' AS origin
        FROM session_line_entry e WHERE e.project_id=$1 AND e.state IN ('queued','suspended','starting')
        UNION ALL
        SELECT e.entry_id,e.session_id,e.task_id,e.position::bigint,e.state,e.hold_code,e.created_at,EXTRACT(EPOCH FROM (now()-e.created_at))::float,
          (SELECT q.actor_id FROM resident_queue q WHERE q.project_id=e.project_id AND q.queue_id=e.queue_id),
          (SELECT title FROM task t WHERE t.project_id=e.project_id AND t.task_id=e.task_id),'batch'
        FROM resident_queue_entry e WHERE e.project_id=$1 AND e.state IN ('queued','held','claimed')) u
      ORDER BY session_id,position,created_at LIMIT ${LIMITS.queue}`);
    const sessions: WorkBoardSession[] = sessionsRows.map(s => {
      const run = runs.find(r => r.session_id === s.session_id), turn = turns.find(t => t.session_id === s.session_id);
      const current: WorkBoardWork | null = run
        ? { kind: "run", id: run.run_id, taskId: run.task_id, taskTitle: run.title ?? null, startedAt: iso(run.created_at), elapsedSeconds: Math.round(run.elapsed) }
        : turn ? { kind: turn.from_input ? "input" : "message", id: turn.message_id, taskId: turn.task_id ?? null, taskTitle: turn.title ?? null, startedAt: iso(turn.started_at), elapsedSeconds: Math.round(turn.elapsed) } : null;
      const queue: WorkBoardQueueItem[] = entries.filter(e => e.session_id === s.session_id).map(e => ({ entryId: e.entry_id, taskId: e.task_id, taskTitle: e.title ?? null,
        position: e.position, state: e.state, holdCode: e.hold_code, source: e.source ?? null, addedAt: iso(e.created_at)!, waitedSeconds: Math.round(e.waited) }));
      return { sessionId: s.session_id, roleId: s.role_id, roleTitle: s.role_title ?? null, state: s.state, provider: s.runtime_provider ?? null, current, queue, queuedMessages: s.queued_messages,
        health: { recoveryGate: s.gate_phase, gateCause: s.cause_kind ?? null, providerHeld: s.held } };
    });
    const ready = await q(`SELECT t.task_id,t.title,t.state,COALESCE((SELECT max(r.created_at) FROM task_revision r WHERE r.project_id=t.project_id AND r.task_id=t.task_id),now()) AS since
      FROM task t WHERE t.project_id=$1 AND t.state='todo'
        AND NOT EXISTS(SELECT 1 FROM resident_queue_entry e WHERE e.project_id=t.project_id AND e.task_id=t.task_id AND e.state IN ('queued','held','claimed'))
        AND NOT EXISTS(SELECT 1 FROM session_line_entry l WHERE l.project_id=t.project_id AND l.task_id=t.task_id AND l.state IN ('queued','suspended','starting'))
        AND NOT EXISTS(SELECT 1 FROM task_session_assignment a WHERE a.project_id=t.project_id AND a.task_id=t.task_id AND a.state IN ('assigned','accepted'))
      ORDER BY since LIMIT ${LIMITS.ready}`);
    const readyNotQueued: WorkBoardWaitingTask[] = ready.map(r => ({ taskId: r.task_id, title: r.title, state: r.state, since: iso(r.since)! }));
    const awaiting: WorkBoardLeaderItem[] = [];
    for (const r of await q(`SELECT i.notice_id,i.state,i.created_at,n.task_id,(SELECT title FROM task t WHERE t.project_id=n.project_id AND t.task_id=n.task_id) AS title
        FROM leader_notice_packet_item i JOIN leader_result_notice n ON n.project_id=i.project_id AND n.notice_id=i.notice_id
        WHERE i.project_id=$1 AND i.state IN ('delivered','seen') ORDER BY i.created_at LIMIT ${LIMITS.leader}`))
      awaiting.push({ kind: "notice", id: r.notice_id, taskId: r.task_id, title: r.title ?? null, state: r.state, since: iso(r.created_at)! });
    for (const r of await q(`SELECT packet_id,created_at FROM leader_notice_packet WHERE project_id=$1 AND state='blocked' ORDER BY created_at LIMIT 20`))
      awaiting.push({ kind: "blocked_packet", id: r.packet_id, taskId: null, title: null, state: "blocked", since: iso(r.created_at)! });
    for (const r of await q(`SELECT request_id,task_id,question,created_at FROM decision_request WHERE project_id=$1 AND state='open' ORDER BY created_at LIMIT 20`))
      awaiting.push({ kind: "decision", id: r.request_id, taskId: r.task_id ?? null, title: String(r.question).slice(0, 80), state: "open", since: iso(r.created_at)! });
    // A recovery gate closed for the threshold with messages queued behind it waits for someone to resume it.
    for (const r of await q(`SELECT g.session_id,g.phase,g.updated_at,
        (SELECT count(*)::int FROM session_message m WHERE m.project_id=g.project_id AND m.session_id=g.session_id AND m.target_kind='owned' AND m.state='queued') AS queued,
        (SELECT rr.proposal->>'title' FROM runtime_session s JOIN role_definition d ON d.project_id=s.project_id AND d.role_id::text=s.role_id::text
           JOIN role_revision rr ON rr.project_id=d.project_id AND rr.role_id=d.role_id AND rr.revision_id=d.current_revision_id
          WHERE s.project_id=g.project_id AND s.session_id=g.session_id) AS role_title,
        (SELECT x.actor_id FROM session_recovery_decision x WHERE x.project_id=g.project_id AND x.session_id=g.session_id ORDER BY x.created_at DESC LIMIT 1) AS controller
      FROM session_recovery_gate g WHERE g.project_id=$1 AND g.phase='blocked' AND g.updated_at < now() - make_interval(mins => ${GATE_ATTENTION_MINUTES})
        AND EXISTS(SELECT 1 FROM session_message m WHERE m.project_id=g.project_id AND m.session_id=g.session_id AND m.target_kind='owned' AND m.state='queued')
      ORDER BY g.updated_at LIMIT 20`))
      awaiting.push({ kind: "recovery_gate", id: r.session_id, taskId: null, state: r.phase, since: iso(r.updated_at)!,
        title: `${r.role_title ?? r.session_id}：恢复门 ${r.phase} 超过 ${GATE_ATTENTION_MINUTES} 分钟，${r.queued} 条消息排在后面`,
        waitingOn: r.controller ? { kind: "actor", id: r.controller } : { kind: "reviewer", id: null } });
    // Closed recovery gates first, in the full snapshot as in the brief.
    awaiting.sort((a, b) => Number(b.kind === "recovery_gate") - Number(a.kind === "recovery_gate"));
    const packets = await q(`SELECT packet_id,session_id,state FROM leader_notice_packet WHERE project_id=$1 AND state IN ('building','sent','delivered','unknown','blocked')`);
    const relays = await q(`SELECT relay_id,session_id,state,(SELECT title FROM task t WHERE t.project_id=r.project_id AND t.task_id=r.task_id) AS title
      FROM task_acceptance_relay r WHERE project_id=$1 AND state IN ('pending','linked') ORDER BY created_at DESC LIMIT 100`);
    const inFlight: WorkBoardInFlight[] = [
      ...entries.map(e => ({ kind: "queue_entry" as const, id: e.entry_id, title: e.title ?? null, state: e.state, sessionId: e.session_id })),
      ...sessions.flatMap(s => s.current ? [{ kind: s.current.kind === "run" ? "run" as const : "message" as const, id: s.current.id, title: s.current.taskTitle, state: "running", sessionId: s.sessionId }] : []),
      ...packets.map(p => ({ kind: "packet" as const, id: p.packet_id, title: null, state: p.state, sessionId: p.session_id })),
      ...relays.map(r => ({ kind: "acceptance" as const, id: r.relay_id, title: r.title ?? null, state: r.state, sessionId: r.session_id })),
    ].slice(0, LIMITS.flight);
    const counts: Record<string, number> = {
      sessions: sessions.length, running: sessions.filter(s => s.current).length, queued: entries.filter(e => e.state === "queued").length,
      held: entries.filter(e => e.state === "held").length, claimed: entries.filter(e => e.state === "claimed").length,
      queuedMessages: sessions.reduce((n, s) => n + s.queuedMessages, 0), readyNotQueued: readyNotQueued.length, openPackets: packets.length,
      pendingAcceptance: relays.length, awaitingLeader: awaiting.length,
    };
    await client.query("COMMIT");
    return { projectId, observedAt: new Date().toISOString(), eventSeq, sessions, readyNotQueued, awaitingLeader: awaiting,
      graph: { nodes: [{ id: "leader", kind: "leader", label: "Leader" }, { id: "packets", kind: "packets", label: "通知包" },
        ...sessions.map(s => ({ id: s.sessionId, kind: "session" as const, label: s.roleTitle ?? s.roleId }))], inFlight, counts } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Retention: delete events older than `days`, batch by batch. Returns how many went. */
export async function purgeSchedEvents(db: Db, days: number, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const n = num((await db.query("SELECT purge_sched_event($1,$2) AS n", [days, batch])).rows[0].n);
    total += n;
    if (n < batch) return total;
  }
}
