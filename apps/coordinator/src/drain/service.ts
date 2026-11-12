// Drain mode (see docs/architecture/deployment.md §2). `holdNewStarts()` is the one question every starter asks: while it
// is true no new Run and no new message Turn is begun, but nothing is dropped — messages and Runs are still saved and
// wait in their queues, and work already begun runs to its end. The state is kept in the database so a restart during a
// release does not start work again; "drained" is derived, never stored: draining and nothing begun is still running.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

import type { DrainInFlight, DrainState, DrainStatus } from "@evoloop/contracts/instance-drain";
export type { DrainInFlight, DrainState, DrainStatus };

const listLimit = 50;
const iso = (value: Date | string) => new Date(value).toISOString();

export class DrainControl {
  private cached: { holding: boolean; at: number } | null = null;
  constructor(private readonly pool: Pool, private readonly options: { cacheMs?: number } = {}) {}

  /** What every starter asks. A read failure holds: never start work when it cannot be told whether to. */
  async holdNewStarts(): Promise<boolean> {
    const ttl = this.options.cacheMs ?? 1000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.holding;
    try {
      const row = (await this.pool.query("SELECT state FROM instance_drain WHERE singleton")).rows[0];
      this.cached = { holding: row?.state === "draining", at: Date.now() };
    } catch { return true; }
    return this.cached.holding;
  }

  async status(): Promise<DrainStatus> {
    const row = (await this.pool.query("SELECT state,version,actor_id,reason,changed_at FROM instance_drain WHERE singleton")).rows[0];
    if (!row) throw new DomainError("DRAIN_UNAVAILABLE", "Drain state is not initialised (migration 097)");
    const runs = await this.pool.query(`SELECT project_id,run_id,task_id,session_id,state,updated_at,count(*) OVER () AS total FROM runtime_run
      WHERE state IN ('dispatching','running','unknown') ORDER BY updated_at,run_id LIMIT ${listLimit}`);
    const turns = await this.pool.query(`SELECT p.project_id,p.message_id,p.session_id,p.state,p.updated_at,count(*) OVER () AS total FROM session_message_processing p
      WHERE p.state IN ('dispatching','running','unknown') ORDER BY p.updated_at,p.message_id LIMIT ${listLimit}`);
    // `total` is only on returned rows; an empty list has none.
    const runCount = runs.rows[0] ? Number(runs.rows[0].total) : 0, turnCount = turns.rows[0] ? Number(turns.rows[0].total) : 0;
    const queuedRuns = Number((await this.pool.query("SELECT count(*) AS n FROM runtime_run WHERE state='requested'")).rows[0].n);
    const queuedMessages = Number((await this.pool.query("SELECT count(*) AS n FROM session_message WHERE state='queued' AND target_kind='owned'")).rows[0].n);
    const draining = row.state === "draining";
    const total = runCount + turnCount;
    const state: DrainState = !draining ? "active" : total === 0 ? "drained" : "draining";
    return {
      state, holding: draining, version: Number(row.version), actorId: row.actor_id ?? null, reason: row.reason ?? null, changedAt: iso(row.changed_at),
      queued: { runs: queuedRuns, messages: queuedMessages },
      inFlight: { counts: { runs: runCount, messageTurns: turnCount, total },
        runs: runs.rows.map(r => ({ projectId: r.project_id, runId: r.run_id, taskId: r.task_id, sessionId: r.session_id, state: r.state, updatedAt: iso(r.updated_at) })),
        messageTurns: turns.rows.map(r => ({ projectId: r.project_id, messageId: r.message_id, sessionId: r.session_id, state: r.state, updatedAt: iso(r.updated_at) })) },
      safeToStop: state === "drained", observedAt: new Date().toISOString(),
    };
  }

  /** Start or release. Repeating the state already in force changes nothing and records nothing. */
  async set(principal: Principal, action: "start" | "release", reason: string): Promise<{ changed: boolean; status: DrainStatus }> {
    const text = reason.trim();
    if (!text) throw new DomainError("REASON_REQUIRED", "A reason is required");
    const client = await this.pool.connect();
    let changed = false;
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT state,version FROM instance_drain WHERE singleton FOR UPDATE")).rows[0];
      if (!row) throw new DomainError("DRAIN_UNAVAILABLE", "Drain state is not initialised (migration 097)");
      const target = action === "start" ? "draining" : "active";
      if (row.state !== target) {
        const version = Number(row.version) + 1;
        await client.query("UPDATE instance_drain SET state=$1,version=$2,actor_id=$3,reason=$4,changed_at=now() WHERE singleton", [target, version, principal.actorId, text]);
        await client.query("INSERT INTO instance_drain_event(event_id,action,version,actor_id,reason,at) VALUES($1,$2,$3,$4,$5,now())", [randomUUID(), action, version, principal.actorId, text]);
        changed = true;
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    this.cached = null;
    return { changed, status: await this.status() };
  }

  async history(limit = 20): Promise<Array<{ action: string; version: number; actorId: string; reason: string; at: string }>> {
    const rows = (await this.pool.query("SELECT action,version,actor_id,reason,at FROM instance_drain_event ORDER BY at DESC,version DESC LIMIT $1", [Math.min(Math.max(limit, 1), 100)])).rows;
    return rows.map(r => ({ action: r.action, version: Number(r.version), actorId: r.actor_id, reason: r.reason, at: iso(r.at) }));
  }
}

/**
 * Who may start or release a drain: a credential that holds read, write and review in every project of this instance.
 * Ordinary business Sessions hold review in some projects at most, never all of them, so none can drain the instance.
 */
export async function isInstanceMaintainer(pool: Pool, principal: Principal): Promise<boolean> {
  if (!["read", "write", "review"].every(permission => principal.permissions.includes(permission as "read"))) return false;
  const projects = (await pool.query("SELECT project_id FROM project")).rows.map(row => row.project_id as string);
  return projects.every(id => principal.projectIds.includes(id));
}
