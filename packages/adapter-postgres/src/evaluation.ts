import type { PoolClient, QueryResultRow } from "pg";
import type { Page } from "@evoloop/contracts";
import type { EvaluationAssessment, EvaluationAttempt, EvaluationConclusion, EvaluationRevision } from "@evoloop/contracts/evaluation";
import { DomainError } from "@evoloop/contracts/ports";

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const detailLimit = 10_000;
const bounded = <T>(items: T[], label: string): T[] => {
  if (items.length > detailLimit) throw new DomainError("RESULT_TOO_LARGE", `${label} exceeds ${detailLimit}`);
  return items;
};
const revision = (r: QueryResultRow): EvaluationRevision => ({
  projectId: r.project_id, evaluationId: r.evaluation_id, id: r.revision_id, version: r.version,
  definition: r.definition, actorId: r.actor_id, reason: r.reason, createdAt: iso(r.created_at),
});
const attempt = (r: QueryResultRow): EvaluationAttempt => ({
  projectId: r.project_id, id: r.attempt_id, evaluationId: r.evaluation_id, revisionId: r.revision_id,
  caseId: r.case_id, conditionId: r.condition_id, ordinal: r.ordinal, runId: r.run_id,
  sourceTaskRevisionId: r.source_task_revision_id, actualTaskRevisionId: r.actual_task_revision_id,
  sessionId: r.session_id, actorId: r.actor_id, createdAt: iso(r.created_at),
});
const assessment = (r: QueryResultRow): EvaluationAssessment => ({
  projectId: r.project_id, id: r.assessment_id, evaluationId: r.evaluation_id, revisionId: r.revision_id,
  attemptId: r.attempt_id, deliveryId: r.delivery_id, observationId: r.observation_id,
  supersedesId: r.supersedes_id, values: r.values, costs: r.costs, evidence: r.evidence,
  assessorKind: r.assessor_kind, actorId: r.actor_id, reason: r.reason, createdAt: iso(r.created_at),
});
const conclusion = (r: QueryResultRow): EvaluationConclusion => ({
  projectId: r.project_id, id: r.conclusion_id, evaluationId: r.evaluation_id, revisionId: r.revision_id,
  assessmentIds: r.assessment_ids, supersedesId: r.supersedes_id, finding: r.finding, limits: r.limits,
  comparability: r.comparability, comparabilityReason: r.comparability_reason,
  nextChoice: r.next_choice, affectedRefs: r.affected_refs, nextActionRef: r.next_action_ref,
  actorId: r.actor_id, createdAt: iso(r.created_at),
});

export class PgEvaluationStore {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  private scope(projectId: string): void {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "evaluation record belongs to another project");
  }
  async getEvaluation(id: string, revisionId?: string): Promise<EvaluationRevision | null> {
    const r = await this.client.query(`SELECT r.* FROM evaluation_revision r JOIN evaluation_head h
      ON h.project_id=r.project_id AND h.evaluation_id=r.evaluation_id
      WHERE r.project_id=$1 AND r.evaluation_id=$2 AND r.revision_id=COALESCE($3::uuid,h.current_revision_id)`,
      [this.projectId,id,revisionId ?? null]);
    return r.rows[0] ? revision(r.rows[0]) : null;
  }
  async listEvaluations(limit: number, cursor?: string, taskId?: string, knowledgePageId?: string): Promise<Page<EvaluationRevision>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("page limit must be 1..100");
    const r = await this.client.query(`SELECT v.* FROM evaluation_head h JOIN LATERAL (
      SELECT frozen.* FROM evaluation_revision frozen
      WHERE frozen.project_id=h.project_id AND frozen.evaluation_id=h.evaluation_id
        AND ($3::uuid IS NULL OR frozen.owner_task_id=$3::uuid OR frozen.case_task_id=$3::uuid)
        AND (($4::text IS NULL AND frozen.revision_id=h.current_revision_id)
          OR ($4::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(frozen.definition->'conditions') c,
              jsonb_array_elements(CASE WHEN jsonb_typeof(c->'wikiRefs')='array' THEN c->'wikiRefs' ELSE '[]'::jsonb END) ref
            WHERE ref->>'kind'='wiki' AND ref->>'id'=$4::text)))
      ORDER BY frozen.version DESC LIMIT 1
    ) v ON true
      WHERE h.project_id=$1 AND ($2::uuid IS NULL OR h.evaluation_id>$2::uuid)
      ORDER BY h.evaluation_id LIMIT $5`, [this.projectId,cursor ?? null,taskId ?? null,knowledgePageId ?? null,limit+1]);
    const rows = r.rows.slice(0,limit);
    return { items: rows.map(revision), nextCursor: r.rows.length > limit ? rows[rows.length-1]!.evaluation_id : null };
  }
  async listEvaluationRevisions(id: string): Promise<EvaluationRevision[]> {
    const r = await this.client.query("SELECT * FROM evaluation_revision WHERE project_id=$1 AND evaluation_id=$2 ORDER BY version LIMIT $3", [this.projectId,id,detailLimit+1]);
    return bounded(r.rows.map(revision),"evaluation revisions");
  }
  async listEvaluationAttempts(id: string, revisionId: string): Promise<EvaluationAttempt[]> {
    const r = await this.client.query("SELECT * FROM evaluation_attempt WHERE project_id=$1 AND evaluation_id=$2 AND revision_id=$3 ORDER BY created_at,attempt_id LIMIT $4", [this.projectId,id,revisionId,detailLimit+1]);
    return bounded(r.rows.map(attempt),"evaluation attempts");
  }
  async listEvaluationAssessments(id: string, revisionId: string): Promise<EvaluationAssessment[]> {
    const r = await this.client.query("SELECT * FROM evaluation_assessment WHERE project_id=$1 AND evaluation_id=$2 AND revision_id=$3 ORDER BY created_at,assessment_id LIMIT $4", [this.projectId,id,revisionId,detailLimit+1]);
    return bounded(r.rows.map(assessment),"evaluation assessments");
  }
  async listEvaluationConclusions(id: string, revisionId: string): Promise<EvaluationConclusion[]> {
    const r = await this.client.query("SELECT * FROM evaluation_conclusion WHERE project_id=$1 AND evaluation_id=$2 AND revision_id=$3 ORDER BY created_at,conclusion_id LIMIT $4", [this.projectId,id,revisionId,detailLimit+1]);
    return bounded(r.rows.map(conclusion),"evaluation conclusions");
  }
  async insertEvaluationRevision(value: EvaluationRevision): Promise<void> {
    this.scope(value.projectId);
    if (value.version === 1) {
      await this.client.query("INSERT INTO evaluation_head(project_id,evaluation_id,version,current_revision_id) VALUES($1,$2,1,$3)",
        [this.projectId,value.evaluationId,value.id]);
    } else {
      const advanced = await this.client.query(`UPDATE evaluation_head SET version=$3,current_revision_id=$4
        WHERE project_id=$1 AND evaluation_id=$2 AND version=$5`,
        [this.projectId,value.evaluationId,value.version,value.id,value.version-1]);
      if (!advanced.rowCount) throw new DomainError("VERSION_CONFLICT","evaluation version changed",
        (await this.getEvaluation(value.evaluationId))?.version);
    }
    await this.client.query(`INSERT INTO evaluation_revision(project_id,evaluation_id,revision_id,version,definition,
      owner_task_id,case_task_id,source_task_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
      [this.projectId,value.evaluationId,value.id,value.version,JSON.stringify(value.definition),
        value.definition.ownerTaskId,value.definition.case.taskId,value.definition.case.sourceTaskRevisionId,
        value.actorId,value.reason,value.createdAt]);
  }
  async insertEvaluationAttempt(value: EvaluationAttempt): Promise<void> {
    this.scope(value.projectId);
    await this.client.query(`INSERT INTO evaluation_attempt(project_id,attempt_id,evaluation_id,revision_id,case_id,condition_id,
      ordinal,run_id,source_task_revision_id,actual_task_revision_id,session_id,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [this.projectId,value.id,value.evaluationId,value.revisionId,value.caseId,value.conditionId,value.ordinal,
        value.runId,value.sourceTaskRevisionId,value.actualTaskRevisionId,value.sessionId,value.actorId,value.createdAt]);
  }
  async insertEvaluationAssessment(value: EvaluationAssessment): Promise<void> {
    this.scope(value.projectId);
    await this.client.query(`INSERT INTO evaluation_assessment(project_id,assessment_id,evaluation_id,revision_id,attempt_id,
      delivery_id,observation_id,supersedes_id,values,costs,evidence,assessor_kind,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`,
      [this.projectId,value.id,value.evaluationId,value.revisionId,value.attemptId,value.deliveryId,value.observationId,
        value.supersedesId,JSON.stringify(value.values),JSON.stringify(value.costs),JSON.stringify(value.evidence),
        value.assessorKind,value.actorId,value.reason,value.createdAt]);
  }
  async insertEvaluationConclusion(value: EvaluationConclusion): Promise<void> {
    this.scope(value.projectId);
    await this.client.query(`INSERT INTO evaluation_conclusion(project_id,conclusion_id,evaluation_id,revision_id,assessment_ids,
      supersedes_id,finding,limits,comparability,comparability_reason,next_choice,affected_refs,next_action_ref,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)`,
      [this.projectId,value.id,value.evaluationId,value.revisionId,value.assessmentIds,value.supersedesId,
        value.finding,value.limits,value.comparability,value.comparabilityReason,value.nextChoice,
        JSON.stringify(value.affectedRefs),value.nextActionRef ? JSON.stringify(value.nextActionRef) : null,
        value.actorId,value.createdAt]);
  }
}
