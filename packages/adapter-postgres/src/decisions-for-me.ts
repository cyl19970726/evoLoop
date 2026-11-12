import type { Pool } from "pg";
import type { DecisionItem, DecisionsForMe } from "@evoloop/contracts/decision-requests";

const iso = (v: Date | string): string => v instanceof Date ? v.toISOString() : v;

/**
 * 待我决定: what waits for this identity to decide, read from the records themselves (never from conversation text):
 * Role proposals and stage proposals (only for an identity that can decide them, i.e. with review), questions in a Task discussion that name
 * the identity and are not yet answered or resolved, and open decision requests addressed to it.
 */
export async function readDecisionsForMe(pool: Pool, projectId: string, actorId: string, canDecide: boolean): Promise<DecisionsForMe> {
  const items: DecisionItem[] = [];
  if (canDecide) {
    const roles = await pool.query(`SELECT d.role_id,d.version,d.proposed_by,d.created_at_utc,r.proposal->>'title' AS title,r.proposal->>'goal' AS goal
      FROM role_definition d JOIN role_revision r ON r.project_id=d.project_id AND r.role_id=d.role_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.state='candidate' ORDER BY d.created_at_utc,d.role_id`, [projectId]);
    for (const r of roles.rows) items.push({ kind: "role_proposal", id: r.role_id, title: r.title ?? "职责提案", detail: `职责提案，等你决定是否试行：${String(r.goal ?? "").slice(0, 160)}`,
      proposedBy: r.proposed_by, at: iso(r.created_at_utc), roleId: r.role_id, version: r.version });
    const stages = await pool.query(`SELECT stage_id,version,deliverable,learning_question,actor_id,created_at FROM project_stage WHERE project_id=$1 AND state='proposed' ORDER BY created_at,stage_id`, [projectId]);
    for (const s of stages.rows) items.push({ kind: "stage_proposal", id: s.stage_id, title: String(s.deliverable).slice(0, 120), detail: `阶段提案，等你决定是否开始：${String(s.learning_question).slice(0, 160)}`,
      proposedBy: s.actor_id, at: iso(s.created_at), stageId: s.stage_id, version: s.version });
  }
  // A question names me when its message is for me; it stays until I answer (a reply to it) or mark it resolved/adopted.
  const questions = await pool.query(`SELECT e.event_id,e.discussion_id,e.actor_id,e.created_at,d.task_id,d.document_id,p.title
    FROM discussion_event e JOIN discussion d ON d.project_id=e.project_id AND d.discussion_id=e.discussion_id AND d.kind='task_collaboration'
    JOIN process_document p ON p.project_id=d.project_id AND p.document_id=d.document_id
    WHERE e.project_id=$1 AND e.kind='message' AND e.collaboration_payload->>'kind'='question' AND e.collaboration_payload->>'recipientActorId'=$2
      AND NOT EXISTS(SELECT 1 FROM discussion_event a WHERE a.project_id=e.project_id AND a.discussion_id=e.discussion_id AND a.actor_id=$2 AND (
        (a.kind='message' AND a.collaboration_payload->>'replyToEventId'=e.event_id::text)
        OR (a.kind='receipt' AND a.collaboration_payload->>'messageEventId'=e.event_id::text AND a.collaboration_payload->>'stage' IN ('adopted','resolved'))))
    ORDER BY e.created_at,e.event_id`, [projectId, actorId]);
  for (const q of questions.rows) items.push({ kind: "task_question", id: q.event_id, title: q.title, detail: "Task 讨论里有一个问题指名问你，还没有回答", proposedBy: q.actor_id,
    at: iso(q.created_at), taskId: q.task_id, discussionId: q.discussion_id, eventId: q.event_id });
  const requests = await pool.query(`SELECT * FROM decision_request WHERE project_id=$1 AND requested_from=$2 AND state='open' ORDER BY created_at,request_id`, [projectId, actorId]);
  for (const r of requests.rows) items.push({ kind: "decision_request", id: r.request_id, title: r.subject, detail: r.question, proposedBy: r.requested_by, at: iso(r.created_at),
    taskId: r.task_id, options: r.options, version: r.version });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { items, observedAt: new Date().toISOString() };
}
