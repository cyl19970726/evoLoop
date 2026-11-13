import type { Pool, PoolClient } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { LeaderEventRecord, LeaderEventRecordKind, LeaderEventRecordPage } from "@evoloop/contracts/leader-notices";

type Queryable = Pick<Pool | PoolClient, "query">;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const cursorOf = (row: { occurred_at: unknown; source_event_id: unknown }) => Buffer.from(`${iso(row.occurred_at)}|${row.source_event_id}`).toString("base64url");
function readCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw new DomainError("INVALID_CURSOR", "The cursor is not one this list gave");
  return { at, id };
}

/**
 * The events that are only recorded (DEC-045 W5 level "record only"): a Run stopped on request, a resolved attention item, a withdrawn notice. They
 * come from the `leader_event_record` view, oldest first, so a reader (the Q2 board, the daily evaluation) pages forward without missing any.
 */
export async function listLeaderEventRecords(db: Queryable, projectId: string,
  options: { taskId?: string; kind?: LeaderEventRecordKind; limit: number; cursor?: string }): Promise<LeaderEventRecordPage> {
  const limit = Math.min(200, Math.max(1, options.limit));
  const after = options.cursor ? readCursor(options.cursor) : null;
  const result = await db.query(`SELECT kind, source_event_id, task_id, source_ref, occurred_at FROM leader_event_record
    WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3::text IS NULL OR kind=$3)
      AND ($4::timestamptz IS NULL OR (occurred_at, source_event_id::text) > ($4::timestamptz, $5::text))
    ORDER BY occurred_at, source_event_id LIMIT $6`, [projectId, options.taskId ?? null, options.kind ?? null, after?.at ?? null, after?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  return { items: rows.map(row => ({ kind: row.kind as LeaderEventRecordKind, sourceEventId: String(row.source_event_id), taskId: String(row.task_id),
    sourceRef: String(row.source_ref), occurredAt: iso(row.occurred_at) })), nextCursor: result.rows.length > limit ? cursorOf(rows.at(-1)!) : null };
}
