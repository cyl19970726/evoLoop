import type { Pool } from "pg";
import { buildAlert, type AlertDetails, type PendingWork } from "./message.js";
import { sendAlert, type AlertOutletConfig, type AlertMessage, type OutletResult } from "./outlet.js";

export interface AlertSettings { enabled: boolean; pollIntervalMs: number; stallMinutes: number; outlet: AlertOutletConfig }

/** A message that cannot be delivered is retried with a growing wait (30 s, 1 min, 2 min … at most 30 min) and given up after this many tries; the row keeps the last error. */
export const MAX_DELIVERY_ATTEMPTS = 12;
const backoffMs = (attempts: number) => Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

const iso = (value: unknown): string | null => value ? new Date(value as string | Date).toISOString() : null;

/**
 * Tells someone outside the workbench when the whole organisation may be standing still (Task 5da8b6d9): a provider pause opened or lifted, and a stall
 * (no new Run for a while while work waits). It only READS the state of the system and writes its own `ops_alert` rows; nothing it does, or fails to do,
 * changes a pause, a release, a Run or a Task. An unreachable outlet costs retries and a recorded error, nothing else.
 */
export class OpsAlertPump {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = true;
  constructor(private readonly deps: { pool: Pool; settings: () => Promise<AlertSettings | null>; projects: () => Promise<string[]>; canWrite: () => boolean;
    now?: () => Date; send?: (outlet: AlertOutletConfig, message: AlertMessage) => Promise<OutletResult>; onError?: (error: unknown) => void; onGiveUp?: (line: string) => void }) {}
  start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(1000); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().finally(async () => this.schedule((await this.deps.settings().catch(() => null))?.pollIntervalMs ?? 15000)); }, ms);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.cycle().catch(error => this.deps.onError?.(error)).finally(() => { this.busy = null; });
    return this.busy;
  }
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  private async cycle(): Promise<void> {
    const settings = await this.deps.settings();
    if (!settings?.enabled || !this.deps.canWrite()) return;
    for (const projectId of new Set(await this.deps.projects())) {
      if (!this.deps.canWrite()) return;
      // Each step is separate: a fault in one never keeps the others, or delivery, from running.
      for (const step of [() => this.reconcileHolds(projectId), () => this.reconcileStall(projectId, settings), () => this.deliver(projectId, settings)])
        try { await step(); } catch (error) { this.deps.onError?.(error); }
    }
  }

  /**
   * Who is affected and how much waits, read now. A delivery waits for acceptance only while nobody has observed it: one with a `notUsed` (or `failed`) observation was
   * sent back to its author, and one with a `used` observation is accepted, so neither is work waiting on the organisation to run.
   */
  private async pending(projectId: string): Promise<PendingWork> {
    const r = (await this.deps.pool.query(`SELECT
      (SELECT count(*)::int FROM task t WHERE t.project_id=$1 AND t.state='todo'
        AND NOT EXISTS(SELECT 1 FROM resident_queue_entry e WHERE e.project_id=t.project_id AND e.task_id=t.task_id AND e.state IN ('queued','held','claimed'))
        AND NOT EXISTS(SELECT 1 FROM session_line_entry l WHERE l.project_id=t.project_id AND l.task_id=t.task_id AND l.state IN ('queued','suspended','starting'))
        AND NOT EXISTS(SELECT 1 FROM task_session_assignment a WHERE a.project_id=t.project_id AND a.task_id=t.task_id AND a.state IN ('assigned','accepted'))) AS ready,
      (SELECT count(*)::int FROM session_line_entry l WHERE l.project_id=$1 AND l.state IN ('queued','suspended','starting'))
        + (SELECT count(*)::int FROM resident_queue_entry e WHERE e.project_id=$1 AND e.state IN ('queued','held','claimed')) AS queued,
      (SELECT count(DISTINCT d.task_id)::int FROM delivery d JOIN task t ON t.project_id=d.project_id AND t.task_id=d.task_id
        WHERE d.project_id=$1 AND t.state='in_progress' AND d.task_revision_id=t.current_revision_id AND d.technical_result='passed'
          AND NOT EXISTS(SELECT 1 FROM consumer_observation o WHERE o.project_id=d.project_id AND o.delivery_id=d.delivery_id)) AS awaiting`, [projectId])).rows[0];
    return { ready: r.ready, queued: r.queued, awaitingAcceptance: r.awaiting };
  }

  private async holdDetails(projectId: string, hold: { provider: string; category: string; reason: string; opened_at: unknown }): Promise<AlertDetails> {
    const sessions = (await this.deps.pool.query(`SELECT s.session_id,
        (SELECT rr.proposal->>'title' FROM role_definition d JOIN role_revision rr ON rr.project_id=d.project_id AND rr.role_id=d.role_id AND rr.revision_id=d.current_revision_id
          WHERE d.project_id=s.project_id AND d.role_id::text=s.role_id::text) AS role,
        count(*) OVER () AS total
      FROM runtime_session s WHERE s.project_id=$1 AND s.runtime_provider=$2 AND s.state<>'closed' ORDER BY s.created_at,s.session_id LIMIT 8`, [projectId, hold.provider])).rows;
    return { provider: hold.provider, category: hold.category, reason: hold.reason, heldAt: iso(hold.opened_at)!,
      sessions: sessions.map(s => ({ sessionId: s.session_id, role: s.role ?? null })), sessionTotal: sessions[0] ? Number(sessions[0].total) : 0, pending: await this.pending(projectId) };
  }

  /** One alert per provider pause (key `hold:<hold id>`), opened while it is held and resolved when it is released; the facts are read when it opens. */
  private async reconcileHolds(projectId: string): Promise<void> {
    const { pool } = this.deps;
    const held = (await pool.query("SELECT hold_id,provider,category,reason,opened_at FROM runtime_provider_hold WHERE project_id=$1 AND state='held'", [projectId])).rows;
    for (const hold of held) {
      const key = `hold:${hold.hold_id}`;
      if ((await pool.query("SELECT 1 FROM ops_alert WHERE project_id=$1 AND alert_key=$2", [projectId, key])).rows[0]) continue;
      await pool.query(`INSERT INTO ops_alert(project_id,alert_key,kind,subject,state,opened_at,details) VALUES($1,$2,'provider_hold',$3,'open',$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [projectId, key, hold.provider, iso(hold.opened_at), JSON.stringify(await this.holdDetails(projectId, hold))]);
    }
    for (const alert of (await pool.query("SELECT alert_key,details FROM ops_alert WHERE project_id=$1 AND kind='provider_hold' AND state='open'", [projectId])).rows) {
      const holdId = String(alert.alert_key).slice("hold:".length);
      const hold = (await pool.query("SELECT state,released_at,released_by,release_reason FROM runtime_provider_hold WHERE project_id=$1 AND hold_id=$2", [projectId, holdId])).rows[0];
      if (hold && hold.state === "held") continue;
      const details = { ...alert.details, ...(hold?.released_by ? { releasedBy: hold.released_by } : {}), ...(hold?.release_reason ? { releaseReason: hold.release_reason } : {}) };
      await pool.query("UPDATE ops_alert SET state='resolved',resolved_at=$3,details=$4::jsonb,updated_at=now() WHERE project_id=$1 AND alert_key=$2 AND state='open'",
        [projectId, alert.alert_key, iso(hold?.released_at) ?? this.now().toISOString(), JSON.stringify(details)]);
    }
  }

  /**
   * Stall: no new Run for `stallMinutes`, no Run running now, no provider pause that explains it, and work waits. The clock starts at the last Run, or at the last
   * release of a provider pause (work only resumes after it), or at the project's creation. Ordinary message Turns are not Runs and count for nothing here, in either
   * direction: they neither keep a stall from being announced (a periodic request shorter than the time would otherwise silence it for ever) nor end one that was
   * announced (it would send a recovery and then a second alert for the same stillness). A stall ends only when a Run is created after it began, or when nothing waits any more.
   */
  private async reconcileStall(projectId: string, settings: AlertSettings): Promise<void> {
    const { pool } = this.deps;
    const facts = (await pool.query(`SELECT
        GREATEST((SELECT created_at FROM project WHERE project_id=$1),
          COALESCE((SELECT max(created_at) FROM runtime_run WHERE project_id=$1),'-infinity'),
          COALESCE((SELECT max(released_at) FROM runtime_provider_hold WHERE project_id=$1),'-infinity')) AS quiet_since,
        (SELECT max(created_at) FROM runtime_run WHERE project_id=$1) AS last_run,
        EXISTS(SELECT 1 FROM runtime_run WHERE project_id=$1 AND state IN ('requested','dispatching','running','unknown')) AS active,
        EXISTS(SELECT 1 FROM runtime_provider_hold WHERE project_id=$1 AND state='held') AS held`, [projectId])).rows[0];
    const open = (await pool.query("SELECT alert_key,opened_at FROM ops_alert WHERE project_id=$1 AND kind='stall' AND state='open'", [projectId])).rows[0];
    if (!open) {
      const quietMs = this.now().getTime() - new Date(facts.quiet_since).getTime();
      if (quietMs < settings.stallMinutes * 60_000 || facts.active || facts.held) return;
      const pending = await this.pending(projectId);
      if (pending.ready + pending.queued + pending.awaitingAcceptance === 0) return;
      const details: AlertDetails = { pending, lastRunAt: iso(facts.last_run), stallMinutes: settings.stallMinutes };
      await pool.query(`INSERT INTO ops_alert(project_id,alert_key,kind,state,opened_at,details) VALUES($1,$2,'stall','open',$3,$4::jsonb) ON CONFLICT DO NOTHING`,
        [projectId, `stall:${this.now().toISOString()}`, this.now().toISOString(), JSON.stringify(details)]);
      return;
    }
    // Over when a Run was created after the stall began, or when nothing waits any more. A pause that opens meanwhile does not end it.
    const newRun = facts.last_run && new Date(facts.last_run).getTime() > new Date(open.opened_at).getTime();
    if (!newRun) {
      const pending = await this.pending(projectId);
      if (pending.ready + pending.queued + pending.awaitingAcceptance > 0) return;
    }
    await pool.query("UPDATE ops_alert SET state='resolved',resolved_at=$3,updated_at=now() WHERE project_id=$1 AND alert_key=$2 AND state='open'", [projectId, open.alert_key, this.now().toISOString()]);
  }

  /** Sends what has not got through yet, the opening message first. A failure is recorded and retried later; it changes nothing else. */
  private async deliver(projectId: string, settings: AlertSettings): Promise<void> {
    const { pool } = this.deps;
    const send = this.deps.send ?? ((outlet, message) => sendAlert(outlet, message));
    const rows = (await pool.query(`SELECT * FROM ops_alert WHERE project_id=$1 AND (open_delivered_at IS NULL OR (state='resolved' AND resolved_delivered_at IS NULL)) ORDER BY opened_at,alert_key LIMIT 20`, [projectId])).rows;
    for (const row of rows) {
      if (!this.deps.canWrite()) return;
      for (const event of ["opened", "resolved"] as const) {
        const done = event === "opened" ? row.open_delivered_at : row.resolved_delivered_at;
        if (done || (event === "resolved" && row.state !== "resolved")) continue;
        const attempts: number = event === "opened" ? row.open_attempts : row.resolved_attempts;
        if (attempts >= MAX_DELIVERY_ATTEMPTS) break;
        if (row.last_attempt_at && attempts > 0 && this.now().getTime() - new Date(row.last_attempt_at).getTime() < backoffMs(attempts)) break;
        const message = buildAlert({ projectId, key: row.alert_key, kind: row.kind, event, openedAt: iso(row.opened_at)!, resolvedAt: iso(row.resolved_at), details: row.details });
        const result = await send(settings.outlet, message).catch((error): OutletResult => ({ ok: false, error: `send failed: ${(error as { name?: string })?.name ?? "Error"}` }));
        const column = event === "opened" ? "open" : "resolved";
        const at = this.now().toISOString();
        await pool.query(`UPDATE ops_alert SET ${column}_attempts=${column}_attempts+1, ${column}_delivered_at=CASE WHEN $3 THEN $5::timestamptz ELSE ${column}_delivered_at END,
          last_attempt_at=$5::timestamptz, last_error=$4, updated_at=$5::timestamptz WHERE project_id=$1 AND alert_key=$2`, [projectId, row.alert_key, result.ok, result.ok ? null : (result.error ?? "failed").slice(0, 200), at]);
        if (!result.ok) {
          if (attempts + 1 >= MAX_DELIVERY_ATTEMPTS) this.deps.onGiveUp?.(`Alert ${row.alert_key} (${event}) was not delivered after ${MAX_DELIVERY_ATTEMPTS} tries: ${result.error ?? "failed"}`);
          break; // keep order: the recovery never overtakes an opening message that has not got through
        }
      }
    }
  }
}
