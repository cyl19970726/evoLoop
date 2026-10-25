import type { PoolClient, QueryResultRow } from "pg";
import type { DiscussionRecord, DiscussionEvent, DiscussionTarget, Page } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const maxEvents = 10_000;
function rowRecord(r: QueryResultRow): DiscussionRecord {
  return { projectId: r.project_id, id: r.discussion_id, version: r.version, kind: r.kind,
    status: r.status, documentId: r.document_id, preparedDocumentRevisionId: r.prepared_document_revision_id,
    currentDocumentRevisionId: r.current_document_revision_id, latestDecisionEventId: r.latest_decision_event_id,
    goal: r.goal_id ? { id: r.goal_id, version: r.goal_version } : null,
    stage: r.stage_id ? { id: r.stage_id, version: r.stage_version } : null,
    task: r.task_id ? { id: r.task_id, revisionId: r.task_revision_id } : null,
    adoptedDocuments: r.adopted_documents, question: r.question, options: r.options,
    authorizationBoundary: r.authorization_boundary, targetSessionLabel: r.target_session_label,
    targetSessionRef: r.target_session_ref, actorId: r.actor_id,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    collaboration: r.collaboration_run_id ? { runId: r.collaboration_run_id, sessionId: r.collaboration_session_id,
      issuerActorId: r.collaboration_issuer_actor_id, recipientActorId: r.collaboration_recipient_actor_id } : null };
}
function rowEvent(r: QueryResultRow): DiscussionEvent {
  const target: DiscussionTarget | null = r.target_kind === "stage"
    ? { kind: "stage", id: r.target_id, version: r.target_version }
    : r.target_kind ? { kind: r.target_kind, id: r.target_id, revisionId: r.target_revision_id } : null;
  return { projectId: r.project_id, id: r.event_id, discussionId: r.discussion_id,
    version: r.version, kind: r.kind, documentRevisionId: r.document_revision_id,
    actorId: r.actor_id, createdAt: iso(r.created_at), evidence: r.evidence, reason: r.reason,
    choice: r.choice, unresolved: r.unresolved, relookCondition: r.relook_condition,
    supersedesDecisionEventId: r.supersedes_decision_event_id, decisionEventId: r.decision_event_id,
    target, collaborationPayload: r.collaboration_payload ?? null };
}
export class PgDiscussionQueries {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  private assertProject(value: string): void {
    if (value !== this.projectId) throw new DomainError("PROJECT_SCOPE", "Discussion belongs to another project");
  }
  async getDiscussion(id: string): Promise<DiscussionRecord | null> {
    const result = await this.client.query("SELECT * FROM discussion WHERE project_id=$1 AND discussion_id=$2", [this.projectId, id]);
    return result.rows[0] ? rowRecord(result.rows[0]) : null;
  }
  async listDiscussions(limit: number, cursor?: string): Promise<Page<DiscussionRecord>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE", "Limit must be 1..100");
    const result = await this.client.query("SELECT * FROM discussion WHERE project_id=$1 AND ($2::uuid IS NULL OR discussion_id>$2::uuid) ORDER BY discussion_id LIMIT $3", [this.projectId, cursor ?? null, limit + 1]);
    return { items: result.rows.slice(0, limit).map(rowRecord), nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.discussion_id : null };
  }
  async listDiscussionEvents(id: string): Promise<DiscussionEvent[]> {
    const result = await this.client.query("SELECT * FROM discussion_event WHERE project_id=$1 AND discussion_id=$2 ORDER BY version LIMIT $3", [this.projectId, id, maxEvents + 1]);
    if (result.rows.length > maxEvents) throw new DomainError("RESULT_TOO_LARGE", "Discussion event history exceeds bounded read");
    return result.rows.map(rowEvent);
  }
  private async appendEvent(record: DiscussionRecord, event: DiscussionEvent): Promise<void> {
    this.assertProject(event.projectId);
    if (event.discussionId !== record.id || event.version !== record.version) throw new DomainError("EVENT_MISMATCH", "Discussion event does not match the record version");
    await this.client.query(`INSERT INTO discussion_event(
      project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,
      evidence,reason,choice,unresolved,relook_condition,supersedes_decision_event_id,decision_event_id,
      target_kind,target_id,target_version,target_revision_id,collaboration_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)`,
    [event.projectId,event.discussionId,event.id,event.version,event.kind,record.documentId,event.documentRevisionId,
      event.actorId,event.createdAt,event.evidence,event.reason,event.choice,event.unresolved,event.relookCondition,
      event.supersedesDecisionEventId,event.decisionEventId,event.target?.kind ?? null,event.target?.id ?? null,
      event.target?.kind === "stage" ? event.target.version : null,
      event.target && event.target.kind !== "stage" ? event.target.revisionId : null,
      event.collaborationPayload ? JSON.stringify(event.collaborationPayload) : null]);
  }
  async insertDiscussion(value: DiscussionRecord, event: DiscussionEvent): Promise<void> {
    this.assertProject(value.projectId);
    await this.client.query(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,
      prepared_document_revision_id,current_document_revision_id,latest_decision_event_id,
      goal_id,goal_version,stage_id,stage_version,task_id,task_revision_id,adopted_documents,
      question,options,authorization_boundary,target_session_label,target_session_ref,actor_id,created_at,updated_at,
      collaboration_run_id,collaboration_session_id,collaboration_issuer_actor_id,collaboration_recipient_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
    [value.projectId,value.id,value.version,value.kind,value.status,value.documentId,value.preparedDocumentRevisionId,
      value.currentDocumentRevisionId,value.latestDecisionEventId,value.goal?.id ?? null,value.goal?.version ?? null,
      value.stage?.id ?? null,value.stage?.version ?? null,value.task?.id ?? null,value.task?.revisionId ?? null,
      JSON.stringify(value.adoptedDocuments),value.question,JSON.stringify(value.options),value.authorizationBoundary,
      value.targetSessionLabel,value.targetSessionRef,value.actorId,value.createdAt,value.updatedAt,
      value.collaboration?.runId ?? null,value.collaboration?.sessionId ?? null,
      value.collaboration?.issuerActorId ?? null,value.collaboration?.recipientActorId ?? null]);
    await this.appendEvent(value, event);
  }
  async updateDiscussion(value: DiscussionRecord, expectedVersion: number, event: DiscussionEvent): Promise<void> {
    this.assertProject(value.projectId);
    const updated = await this.client.query(`UPDATE discussion SET version=$3,status=$4,current_document_revision_id=$5,
      latest_decision_event_id=$6,updated_at=$7 WHERE project_id=$1 AND discussion_id=$2 AND version=$8`,
    [value.projectId,value.id,value.version,value.status,value.currentDocumentRevisionId,
      value.latestDecisionEventId,value.updatedAt,expectedVersion]);
    if (!updated.rowCount) throw new DomainError("VERSION_CONFLICT", "Discussion version changed", (await this.getDiscussion(value.id))?.version);
    await this.appendEvent(value, event);
  }
}
