import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

/** One SQL snapshot binds the current todo revision, historical Stage scope and linked adoption. */
export async function readPlanningSources(pool: Pool, principal: Principal, projectId: string,
  taskId: string, taskRevisionId: string, loopId?: string) {
  if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
    throw new DomainError("FORBIDDEN", "Project read permission is required");
  const result = await pool.query(`WITH selected AS (
      SELECT t.task_id,t.current_revision_id,t.content_document_id
      FROM task t JOIN task_revision current ON current.project_id=t.project_id
        AND current.task_id=t.task_id AND current.revision_id=t.current_revision_id
      JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal
        JOIN task_revision proposal_revision ON proposal_revision.project_id=proposal.project_id
          AND proposal_revision.task_id=proposal.task_id
          AND proposal_revision.revision_id=proposal.task_revision_id
        WHERE proposal.project_id=t.project_id AND proposal.task_id=t.task_id
          AND proposal_revision.version<=current.version
        ORDER BY proposal_revision.version DESC LIMIT 1) fixed_scope ON true
      JOIN project_stage stage ON stage.project_id=t.project_id AND stage.stage_id=fixed_scope.stage_id
      LEFT JOIN orchestration_loop loop ON loop.project_id=t.project_id AND loop.loop_id=$4::uuid
      WHERE t.project_id=$1 AND t.task_id=$2 AND t.current_revision_id=$3
        AND t.state='todo' AND current.basis_set_id IS NULL AND stage.state='active'
        AND ($4::uuid IS NULL OR (loop.loop_id IS NOT NULL AND stage.goal_id=(loop.data->>'goalId')::uuid
          AND (loop.data->>'stageId' IS NULL OR stage.stage_id=(loop.data->>'stageId')::uuid)))
    ) SELECT selected.task_id,selected.current_revision_id,link.document_id,
      document.status,document.adopted_revision_id,revision.content_hash,
      statement_timestamp() AS observed_at_utc
    FROM selected LEFT JOIN task_document_link link ON link.project_id=$1
      AND link.task_id=selected.task_id AND link.document_id<>selected.content_document_id
    LEFT JOIN process_document document ON document.project_id=$1 AND document.document_id=link.document_id
    LEFT JOIN document_revision revision ON revision.project_id=$1 AND revision.document_id=link.document_id
      AND revision.revision_id=document.adopted_revision_id
    ORDER BY link.document_id LIMIT 20`, [projectId, taskId, taskRevisionId, loopId ?? null]);
  if (!result.rows.length) throw new DomainError("PLANNING_SOURCE_UNAVAILABLE", "Current todo Task revision is unavailable in the authorized Stage");
  const links = result.rows.filter(row => row.document_id !== null);
  if (links.length > 19) throw new DomainError("PLANNING_SOURCE_LIMIT", "Task has more than 19 linked planning sources");
  const observedAtUtc = new Date(result.rows[0].observed_at_utc as string | Date).toISOString();
  return {
    projectId, taskId, observedTaskRevisionId: taskRevisionId, observedAtUtc, sealed: false as const,
    observedPlanningCandidates: links.filter(row => row.status === "published" && row.adopted_revision_id && row.content_hash)
      .map(row => ({ sourceTaskId: taskId, sourceTaskRevisionId: taskRevisionId,
        documentId: row.document_id as string, adoptedRevisionId: row.adopted_revision_id as string,
        contentHash: row.content_hash as string, status: "published" as const,
        originalPath: `/api/projects/${projectId}/documents/${row.document_id}/revisions/${row.adopted_revision_id}/original` })),
    unavailableLinks: links.filter(row => row.status !== "published" || !row.adopted_revision_id || !row.content_hash)
      .map(row => ({ documentId: row.document_id as string,
        reason: row.status === "archived" ? "archived" : "not_published" as "archived" | "not_published" })),
  };
}
