import type { PoolClient } from "pg";
import type { UsageBucketRow, UsageContextRow, UsageDelta } from "@evoloop/contracts";
import type { UsageReader, UsageTransaction } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const count = (value: unknown): number => Number(value);

export class PgUsage implements UsageReader, UsageTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async addUsage(projectId: string, sessionId: string, day: string, delta: UsageDelta): Promise<void> {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "Usage belongs to another project");
    if (!dayPattern.test(day)) throw new DomainError("INVALID_USAGE_DAY", "Usage day must be YYYY-MM-DD");
    if (![delta.inputTokens, delta.outputTokens, delta.cachedInputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(delta.costUsd) || delta.costUsd < 0)
      throw new DomainError("INVALID_USAGE_DELTA", "Usage deltas must be non-negative integers and a non-negative cost");
    await this.client.query(`INSERT INTO session_usage_daily
      (project_id,session_id,day,input_tokens,output_tokens,cached_input_tokens,cost_usd,cost_reported)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(project_id,session_id,day) DO UPDATE SET
        input_tokens=session_usage_daily.input_tokens+EXCLUDED.input_tokens,
        output_tokens=session_usage_daily.output_tokens+EXCLUDED.output_tokens,
        cached_input_tokens=session_usage_daily.cached_input_tokens+EXCLUDED.cached_input_tokens,
        cost_usd=session_usage_daily.cost_usd+EXCLUDED.cost_usd,
        cost_reported=CASE WHEN session_usage_daily.input_tokens+session_usage_daily.output_tokens
            +EXCLUDED.input_tokens+EXCLUDED.output_tokens=0 THEN true
          ELSE session_usage_daily.cost_reported AND EXCLUDED.cost_reported END,
        updated_at=now()`,
      [projectId, sessionId, day, delta.inputTokens, delta.outputTokens, delta.cachedInputTokens,
        delta.costUsd, delta.costReported]);
  }

  async listUsage(projectId: string, from: string, to: string, sessionId?: string): Promise<UsageBucketRow[]> {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "Usage belongs to another project");
    if (!dayPattern.test(from) || !dayPattern.test(to) || from > to)
      throw new DomainError("INVALID_USAGE_RANGE", "Usage range must be an ordered pair of YYYY-MM-DD days");
    const result = await this.client.query(`SELECT u.session_id,s.role_id,s.native_thread_id,u.day::text,
        u.input_tokens,u.output_tokens,u.cached_input_tokens,u.cost_usd,u.cost_reported
      FROM session_usage_daily u
      JOIN runtime_session s ON s.project_id=u.project_id AND s.session_id=u.session_id
      WHERE u.project_id=$1 AND u.day BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR u.session_id=$4::uuid)
      ORDER BY u.day,u.session_id`, [projectId, from, to, sessionId ?? null]);
    return result.rows.map(row => ({
      sessionId: row.session_id as string, roleId: row.role_id as string,
      nativeThreadId: row.native_thread_id as string | null, day: row.day as string,
      inputTokens: count(row.input_tokens), outputTokens: count(row.output_tokens),
      cachedInputTokens: count(row.cached_input_tokens), costUsd: count(row.cost_usd),
      costReported: row.cost_reported as boolean,
    }));
  }

  async listUsageContext(projectId: string): Promise<UsageContextRow[]> {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "Usage belongs to another project");
    const result = await this.client.query(`SELECT s.session_id,s.role_id,s.native_thread_id,
        CASE WHEN jsonb_typeof(o.projection->'usage'->'last'->'inputTokens')='number'
          THEN (o.projection->'usage'->'last'->>'inputTokens')::bigint END AS context_input_tokens,
        o.observed_at
      FROM runtime_session s
      LEFT JOIN session_native_observation o ON o.project_id=s.project_id AND o.session_id=s.session_id
      WHERE s.project_id=$1 AND s.state='ready'
      ORDER BY s.session_id`, [projectId]);
    return result.rows.map(row => ({
      sessionId: row.session_id as string,
      roleId: row.role_id as string,
      nativeThreadId: row.native_thread_id as string | null,
      contextInputTokens: row.context_input_tokens == null ? null : count(row.context_input_tokens),
      observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString()
        : typeof row.observed_at === "string" ? row.observed_at : null,
    }));
  }
}
