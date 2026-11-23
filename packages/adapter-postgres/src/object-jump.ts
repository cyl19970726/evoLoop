// “跳到” lookup (Task 5eb93990): find the objects of one project that a pasted id, id prefix or PR number names.
// Read only, no migration. An id prefix is turned into a range over the uuid primary key (`project_id, <id>`), so each
// kind costs one index range scan that stops after `limit + 1` rows, however large the table is. A PR number is matched
// against the delivery artifact address inside the project's delivery rows (a per-project scan; the table is small
// next to documents and the regular expression is only built from digits).
import type { Pool } from "pg";
import { jumpBatchLimit, jumpPrefixRange, jumpResultLimit, parseJumpInput, type JumpBatchResult, type JumpMatch, type JumpObjectKind, type JumpResult } from "@evoloop/contracts/object-jump";

type Row = { id: string; title: string | null; task_id?: string };
const kindOrder: JumpObjectKind[] = ["task", "document", "session", "stage", "schedule", "delivery"];

const sql = {
  task: `SELECT task_id AS id, title FROM task WHERE project_id=$1 AND task_id BETWEEN $2::uuid AND $3::uuid ORDER BY task_id LIMIT $4`,
  document: `SELECT document_id AS id, title FROM process_document WHERE project_id=$1 AND document_id BETWEEN $2::uuid AND $3::uuid ORDER BY document_id LIMIT $4`,
  session: `SELECT s.session_id AS id, COALESCE(p.display_name, s.role_id) AS title FROM runtime_session s
    LEFT JOIN session_profile p ON p.project_id=s.project_id AND p.target_kind='owned' AND p.target_id=s.session_id
    WHERE s.project_id=$1 AND s.session_id BETWEEN $2::uuid AND $3::uuid ORDER BY s.session_id LIMIT $4`,
  stage: `SELECT stage_id AS id, deliverable AS title FROM project_stage WHERE project_id=$1 AND stage_id BETWEEN $2::uuid AND $3::uuid ORDER BY stage_id LIMIT $4`,
  schedule: `SELECT d.schedule_id AS id, r.task_template->>'title' AS title FROM schedule_definition d
    JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
    WHERE d.project_id=$1 AND d.schedule_id BETWEEN $2::uuid AND $3::uuid ORDER BY d.schedule_id LIMIT $4`,
  delivery: `SELECT d.delivery_id AS id, t.title AS title, d.task_id AS task_id FROM delivery d
    JOIN task t ON t.project_id=d.project_id AND t.task_id=d.task_id
    WHERE d.project_id=$1 AND d.delivery_id BETWEEN $2::uuid AND $3::uuid ORDER BY d.delivery_id LIMIT $4`,
};
const prSql = `SELECT t.task_id AS id, t.title AS title FROM task t WHERE t.project_id=$1 AND t.task_id IN (
    SELECT d.task_id FROM delivery d WHERE d.project_id=$1 AND d.artifact_ref ~ ('/pull/' || $2::text || '([/?#].*)?$')) ORDER BY t.task_id LIMIT $3`;

const base = (projectId: string) => `/p/${projectId}`;
function match(projectId: string, kind: JumpObjectKind, row: Row): JumpMatch {
  const title = (row.title ?? "").trim() || "（无标题）";
  const href = {
    task: `${base(projectId)}/tasks/${row.id}`,
    document: `${base(projectId)}/documents/${row.id}`,
    session: `${base(projectId)}/sessions?session=${encodeURIComponent(`owned:${row.id}`)}`,
    stage: `${base(projectId)}/journey?stage=${row.id}`,
    schedule: `${base(projectId)}/schedules?schedule=${row.id}`,
    delivery: `${base(projectId)}/tasks/${row.task_id}?tab=delivery`,
  }[kind];
  return { kind, id: row.id, title, href, ...(kind === "delivery" ? { taskId: row.task_id! } : {}) };
}

/** The matches for `input` in `projectId` only: another project's objects are never read. At most `jumpResultLimit`. */
export async function findJumpObjects(pool: Pick<Pool, "query">, projectId: string, input: string, limit = jumpResultLimit): Promise<JumpResult> {
  const parsed = parseJumpInput(input);
  const query = input.trim();
  if (parsed.kind === "short" || parsed.kind === "invalid") return { query, matches: [], truncated: false };
  const fetchLimit = limit + 1;
  let found: JumpMatch[];
  if (parsed.kind === "pr") {
    const rows = (await pool.query<Row>(prSql, [projectId, String(parsed.number), fetchLimit])).rows;
    // A PR number opens the task's 交付与使用 tab, the same place a delivery id does.
    found = rows.map(row => ({ ...match(projectId, "task", row), href: `${base(projectId)}/tasks/${row.id}?tab=delivery` }));
  } else {
    const { low, high } = jumpPrefixRange(parsed.prefix);
    const lists = await Promise.all(kindOrder.map(async kind =>
      (await pool.query<Row>(sql[kind], [projectId, low, high, fetchLimit])).rows.map(row => match(projectId, kind, row))));
    found = lists.flat();
  }
  return { query, matches: found.slice(0, limit), truncated: found.length > limit };
}

/**
 * Body links (Task a910ee96): the same lookup for up to `jumpBatchLimit` candidates in one read, each answered on its own and
 * inside `projectId` only. A candidate that is not usable (too short, not an id or PR number) is answered with no match.
 * Lookups run a few at a time so one page never holds the pool.
 */
export async function findJumpObjectsBatch(pool: Pick<Pool, "query">, projectId: string, candidates: readonly string[]): Promise<JumpBatchResult> {
  const unique = [...new Set(candidates)].slice(0, jumpBatchLimit);
  const results: JumpBatchResult["results"] = {};
  for (let index = 0; index < unique.length; index += 5) {
    await Promise.all(unique.slice(index, index + 5).map(async candidate => {
      const { matches, truncated } = await findJumpObjects(pool, projectId, candidate, 2);
      results[candidate] = { matches, truncated };
    }));
  }
  return { results };
}
