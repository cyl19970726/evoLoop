import type { PoolClient } from "pg";
import type { StaffingFacts, StaffingFactsReader, StaffingLayer } from "@evoloop/contracts/staffing";

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const maxRows = 2000;

/**
 * 分工检查 facts in two queries: every Role with its current class and review date, and every Session that is not closed with its Runs and the
 * deliveries of those Runs that a consumer used. Closed Sessions are left out: nothing the check derives depends on them. Read-only; no table of its own.
 */
export class PgStaffing implements StaffingFactsReader {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async staffingFacts(): Promise<StaffingFacts> {
    const roles = await this.client.query(`SELECT rd.role_id,rd.state,rd.review_at_utc,rd.trial_started_at_utc,
        COALESCE(rr.proposal->>'title','') AS title,rr.proposal->>'roleClass' AS role_class
      FROM role_definition rd
      LEFT JOIN role_revision rr ON rr.project_id=rd.project_id AND rr.revision_id=rd.current_revision_id
      WHERE rd.project_id=$1 ORDER BY rd.created_at_utc,rd.role_id LIMIT $2`, [this.projectId, maxRows + 1]);
    if (roles.rows.length > maxRows) throw new Error(`staffing check exceeds ${maxRows} roles`);
    const sessions = await this.client.query(`SELECT s.session_id,s.role_id,s.state,s.created_at,sp.display_name,sp.tenure,
        COALESCE(r.runs,0) AS runs,COALESCE(r.open_runs,0) AS open_runs,r.last_run_at,
        COALESCE(d.deliveries,0) AS deliveries,COALESCE(d.accepted,0) AS accepted
      FROM runtime_session s
      LEFT JOIN session_profile sp ON sp.project_id=s.project_id AND sp.target_kind='owned' AND sp.target_id=s.session_id
      LEFT JOIN LATERAL (SELECT count(*) AS runs,
          count(*) FILTER (WHERE rn.state IN ('requested','dispatching','running','unknown')) AS open_runs,max(rn.updated_at) AS last_run_at
        FROM runtime_run rn WHERE rn.project_id=s.project_id AND rn.session_id=s.session_id) r ON true
      LEFT JOIN LATERAL (SELECT count(*) AS deliveries,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM consumer_observation o
            WHERE o.project_id=dl.project_id AND o.delivery_id=dl.delivery_id AND o.result='used')) AS accepted
        FROM delivery dl JOIN runtime_run dr ON dr.project_id=dl.project_id AND dr.run_id=dl.run_id
        WHERE dl.project_id=s.project_id AND dr.session_id=s.session_id) d ON true
      WHERE s.project_id=$1 AND s.state<>'closed' ORDER BY s.created_at,s.session_id LIMIT $2`, [this.projectId, maxRows + 1]);
    if (sessions.rows.length > maxRows) throw new Error(`staffing check exceeds ${maxRows} open sessions`);
    return {
      roles: roles.rows.map(row => ({ roleId: row.role_id, title: row.title, state: row.state,
        roleClass: row.role_class === "system" || row.role_class === "business" ? row.role_class as StaffingLayer : null,
        reviewAtUtc: iso(row.review_at_utc), trialStartedAtUtc: row.trial_started_at_utc ? iso(row.trial_started_at_utc) : null })),
      sessions: sessions.rows.map(row => ({ sessionId: row.session_id, roleId: row.role_id, displayName: row.display_name ?? null, tenure: row.tenure ?? null,
        state: row.state, createdAt: iso(row.created_at), runs: Number(row.runs), openRuns: Number(row.open_runs),
        lastRunAt: row.last_run_at ? iso(row.last_run_at) : null, deliveries: Number(row.deliveries), acceptedDeliveries: Number(row.accepted) })),
    };
  }
}
