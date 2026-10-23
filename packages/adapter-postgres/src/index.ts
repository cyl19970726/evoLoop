import { PgReferenceStore } from "./references.js";
import type { FormalSourceDecision, TaskExternalReferenceRecord, TaskExternalReferenceHead } from "@evoloop/contracts/references";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { PgRuntimeStore } from "./runtime.js";
import { PgRoleQueries } from "./roles.js";
import { PgSchedulingQueries } from "./scheduling-queries.js";
import { PgDocumentPayloadStore } from "./documents.js";
import { PgDiscussionQueries } from "./discussions.js";
import { PgEvaluationStore } from "./evaluation.js";
import type { RoleDecision, RoleHandoff, RoleHandoffEvent, RoleRecord, RoleRevision, RoleSessionBinding, RoleTrialReview } from "@evoloop/contracts/roles";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import type { DocumentPayloadRevision, RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { GitSourceRef } from "@evoloop/contracts/sources";
import type {
  BasisDecision, BasisRetention, BasisSet, Document, DocumentDecision, DocumentRevision, Impact,
  Operation, OutboxEvent, Page, Project, Task, TaskDocumentLink, TaskRevision,
} from "@evoloop/contracts";
import type { ConsumerObservation, Delivery, Goal, GoalRevision, Stage, StageReview, TaskJudgement, TaskProposal, StageRevision, TaskClosure } from "@evoloop/contracts";
import { DomainError, type CognitiveClosureFact, type WaitingHandoffFact, type Reader, type Transaction, type UnitOfWork } from "@evoloop/contracts/ports";

const { Pool } = pg;
const maxDetailRows = 10_000;
type Row = QueryResultRow;
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const rowProject = (r: Row): Project => ({ id: r.project_id, title: r.title, createdAt: iso(r.created_at) });
const rowDocument = (r: Row): Document => ({ projectId: r.project_id, id: r.document_id, title: r.title, version: r.version, currentRevisionId: r.current_revision_id, adoptedRevisionId: r.adopted_revision_id, kind: r.kind, status: r.status, primaryTaskId: r.primary_task_id ?? null,
  origin: r.origin_task_id ? { taskId: r.origin_task_id, taskRevisionId: r.origin_task_revision_id, runId: r.origin_run_id ?? null } : null });
const rowDocumentRevision = (r: Row): DocumentRevision => ({ projectId: r.project_id, documentId: r.document_id, id: r.revision_id,
  body: r.body, format: r.format, mediaType: r.media_type, originalName: r.original_name ?? `${r.document_id}.md`,
  payloadRef: r.payload_ref, entrypoint: r.entrypoint, assetsManifest: r.assets_manifest ?? [],
  contentHash: r.content_hash, author: r.author, createdAt: iso(r.created_at), previousRevisionId: r.previous_revision_id, reason: r.reason });
const legacyTaskStates = new Set(["proposed", "ready", "active", "review", "blocked", "deferred"]);
const rowTask = (r: Row): Task => ({ projectId: r.project_id, id: r.task_id, version: r.version,
  currentRevisionId: r.current_revision_id, title: r.title, content: r.content,
  contentDocumentId: r.content_document_id, contentRevisionId: r.content_revision_id, kind: r.kind,
  acceptance: r.acceptance, owner: r.owner, state: r.state,
  legacyDecision: legacyTaskStates.has(r.legacy_state)
    ? { state: r.legacy_state, decision: r.legacy_judgement_decision ?? null,
      reason: r.legacy_judgement_reason ?? r.legacy_revision_reason }
    : null });
const rowTaskRevision = (r: Row): TaskRevision => ({ projectId: r.project_id, taskId: r.task_id, id: r.revision_id, version: r.version, title: r.title, content: r.content, contentDocumentId: r.content_document_id, contentRevisionId: r.content_revision_id, kind: r.kind, acceptance: r.acceptance, owner: r.owner, state: r.state, basisSetId: r.basis_set_id, actorId: r.actor_id, reason: r.reason, createdAt: iso(r.created_at) });
const rowLink = (r: Row): TaskDocumentLink => ({ projectId: r.project_id, id: r.link_id, taskId: r.task_id, documentId: r.document_id, actorId: r.actor_id, createdAt: iso(r.created_at) });
const rowImpact = (r: Row): Impact => ({ projectId: r.project_id, id: r.impact_id, taskId: r.task_id, taskRevisionId: r.task_revision_id, documentId: r.document_id, fromRevisionId: r.from_revision_id, toRevisionId: r.to_revision_id, state: r.state, decisionId: r.decision_id, createdAt: iso(r.created_at) });
const rowBasisDecision = (r: Row): BasisDecision => ({ projectId: r.project_id, id: r.decision_id, impactId: r.impact_id, taskId: r.task_id, previousTaskRevisionId: r.previous_task_revision_id, nextTaskRevisionId: r.next_task_revision_id, decision: r.decision, reason: r.reason, actorId: r.actor_id, createdAt: iso(r.created_at) });
const rowOperation = (r: Row): Operation => ({ projectId: r.project_id, id: r.operation_id, actorId: r.actor_id, commandHash: r.command_hash, commandType: r.command_type, result: r.result, createdAt: iso(r.created_at) });
const rowGoal = (r: Row): Goal => ({ projectId:r.project_id,id:r.goal_id,version:r.version,outcome:r.outcome,constraints:r.constraints,consumer:r.consumer,authority:r.authority,scope:r.scope,owner:r.owner,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowGoalRevision = (r: Row): GoalRevision => ({...rowGoal(r),reason:r.reason});
const rowStage = (r: Row): Stage => ({ projectId:r.project_id,id:r.stage_id,goalId:r.goal_id,version:r.version,deliverable:r.deliverable,learningQuestion:r.learning_question,state:r.state,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowStageRevision = (r: Row): StageRevision => ({projectId:r.project_id,stageId:r.stage_id,id:r.revision_id,version:r.version,state:r.state,deliverable:r.deliverable,learningQuestion:r.learning_question,actorId:r.actor_id,reason:r.reason,createdAt:iso(r.created_at)});
const rowStageReview = (r: Row): StageReview => ({ projectId:r.project_id,id:r.review_id,stageId:r.stage_id,stageVersion:r.stage_version,supersedesReviewId:r.supersedes_review_id,adopted:r.adopted,rejected:r.rejected,gap:r.gap,nextChoice:r.next_choice,evidence:r.evidence,reason:r.reason,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowProposal = (r: Row): TaskProposal => ({ projectId:r.project_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,stageId:r.stage_id,consumer:r.consumer,useRequired:r.use_required,evidence:r.evidence,stopCondition:r.stop_condition,createdAt:iso(r.created_at) });
const rowJudgement = (r: Row): TaskJudgement => ({ projectId:r.project_id,id:r.judgement_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,decision:r.decision,reason:r.reason,evidence:r.evidence,relookCondition:r.relook_condition,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowDelivery = (r: Row): Delivery => ({ projectId:r.project_id,id:r.delivery_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,runId:r.run_id??null,artifactRef:r.artifact_ref,artifactRevision:r.artifact_revision,contentHash:r.content_hash,technicalResult:r.technical_result,technicalEvidence:r.technical_evidence,reason:r.reason,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowObservation = (r: Row): ConsumerObservation => ({ projectId:r.project_id,id:r.observation_id,taskId:r.task_id,deliveryId:r.delivery_id,observer:r.observer,observerKind:r.observer_kind,result:r.result,evidence:r.evidence,reason:r.reason,actorId:r.actor_id,createdAt:iso(r.created_at) });
const rowClosure = (r: Row): TaskClosure => ({ projectId:r.project_id,id:r.closure_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,deliveryId:r.delivery_id??null,decisionId:r.decision_id??null,sourceInboxId:r.source_inbox_id??null,sourceEventId:r.source_event_id??null,sourceTaskId:r.source_task_id??null,waitingInboxId:r.waiting_inbox_id??null,acceptanceResult:r.acceptance_result,acceptanceEvidence:r.acceptance_evidence,reason:r.reason,actorId:r.actor_id,createdAt:iso(r.created_at) });
const taskReadProjection = `FROM task t
  JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
  JOIN document_revision dr ON dr.project_id=t.project_id AND dr.document_id=t.content_document_id
    AND dr.revision_id=t.content_revision_id
  LEFT JOIN LATERAL (
    SELECT j.decision,j.reason FROM task_judgement j
    WHERE j.project_id=t.project_id AND j.task_id=t.task_id AND j.task_revision_id=tr.revision_id
      AND tr.state IN ('proposed','ready','active','review','blocked','deferred')
    ORDER BY j.created_at DESC,j.judgement_id DESC LIMIT 1
  ) legacy_judgement ON true`;
function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("page limit must be 1..100");
  return limit;
}
function bounded<T>(items: T[], label: string): T[] {
  if (items.length > maxDetailRows) throw new DomainError("RESULT_TOO_LARGE", `${label} exceeds ${maxDetailRows}; use a bounded query`);
  return items;
}
function page<T>(rows: Row[], limit: number, map: (row: Row) => T, id: (row: Row) => string): Page<T> {
  const hasMore = rows.length > limit;
  const chosen = rows.slice(0, limit);
  return { items: chosen.map(map), nextCursor: hasMore ? id(chosen[chosen.length - 1]!) : null };
}

class PgReader implements Reader {
  protected readonly runtime: PgRuntimeStore;
  protected readonly roles: PgRoleQueries;
  protected readonly scheduling: PgSchedulingQueries;
  protected readonly references: PgReferenceStore;
  protected readonly payloads: PgDocumentPayloadStore;
  protected readonly discussions: PgDiscussionQueries;
  protected readonly evaluations: PgEvaluationStore;
  constructor(protected readonly client: PoolClient, protected readonly projectId: string) {
    this.references = new PgReferenceStore(client, projectId);
    this.runtime = new PgRuntimeStore(client, projectId);
    this.roles = new PgRoleQueries(client, projectId);
    this.scheduling = new PgSchedulingQueries(client, projectId);
    this.payloads = new PgDocumentPayloadStore(client, projectId);
    this.discussions = new PgDiscussionQueries(client, projectId);
    this.evaluations = new PgEvaluationStore(client, projectId);
  }
  getEvaluation(id: string, revisionId?: string) { return this.evaluations.getEvaluation(id, revisionId); }
  listEvaluations(limit: number, cursor?: string, taskId?: string, knowledgePageId?: string) { return this.evaluations.listEvaluations(limit, cursor, taskId, knowledgePageId); }
  listEvaluationRevisions(id: string) { return this.evaluations.listEvaluationRevisions(id); }
  listEvaluationAttempts(id: string, revisionId: string) { return this.evaluations.listEvaluationAttempts(id, revisionId); }
  listEvaluationAssessments(id: string, revisionId: string) { return this.evaluations.listEvaluationAssessments(id, revisionId); }
  listEvaluationConclusions(id: string, revisionId: string) { return this.evaluations.listEvaluationConclusions(id, revisionId); }
  getDiscussion(id: string) { return this.discussions.getDiscussion(id); }
  listDiscussions(limit: number, cursor?: string) { return this.discussions.listDiscussions(limit, cursor); }
  listDiscussionEvents(id: string) { return this.discussions.listDiscussionEvents(id); }
  getTaskExternalHead(taskId:string,slotId:string){return this.references.getTaskExternalHead(taskId,slotId);}
  getTaskExternalSnapshot(taskId:string,revisionId:string,slotId:string){return this.references.getTaskExternalSnapshot(taskId,revisionId,slotId);}
  listTaskExternalSnapshot(taskId:string,revisionId:string){return this.references.listTaskExternalSnapshot(taskId,revisionId);}
  listTaskExternalReferences(taskId:string){return this.references.listTaskExternalReferences(taskId);}
  listFormalSourceDecisions(id:string){return this.references.listFormalSourceDecisions(id);}
  getRole(id: string) { return this.roles.getRole(id); }
  listRoles(limit?: number, cursor?: string) { return this.roles.listRoles(limit, cursor); }
  listRevisions(id: string) { return this.roles.listRevisions(id); }
  listReviews(id: string) { return this.roles.listReviews(id); }
  listHandoffs(id: string) { return this.roles.listHandoffs(id); }
  listSessionBindings(id: string) { return this.roles.listSessionBindings(id); }
  getSchedule(id: string) { return this.scheduling.getSchedule(id); }
  listSchedules() { return this.scheduling.listSchedules(); }
  listScheduleRevisions(id: string) { return this.scheduling.listScheduleRevisions(id); }
  listOccurrences(id: string) { return this.scheduling.listOccurrences(id); }
  getDocumentPayloadRevision(documentId: string, revisionId: string) { return this.payloads.getDocumentPayloadRevision(documentId, revisionId); }
  listDocumentAssets(documentId: string, revisionId: string) { return this.payloads.listDocumentAssets(documentId, revisionId); }
  getRegisteredBlob(id: string) { return this.payloads.getRegisteredBlob(id); }
  getGitSourceRef(id: string) { return this.payloads.getGitSourceRef(id); }
  getRuntimeSession(id: string) { return this.runtime.getRuntimeSession(id); }
  listRuntimeSessions() { return this.runtime.listRuntimeSessions(); }
  getRuntimeRun(id: string) { return this.runtime.getRuntimeRun(id); }
  listRuntimeRuns(taskId?: string) { return this.runtime.listRuntimeRuns(taskId); }
  listRuntimeEvents(runId: string) { return this.runtime.listRuntimeEvents(runId); }
  listRuntimeSessionEvents(sessionId: string) { return this.runtime.listRuntimeSessionEvents(sessionId); }
  async getGoal(id: string): Promise<Goal | null> {
    const r=await this.client.query("SELECT * FROM project_goal WHERE project_id=$1 AND goal_id=$2",[this.projectId,id]); return r.rows[0]?rowGoal(r.rows[0]):null;
  }
  async listGoals(limit:number,cursor?:string):Promise<Page<Goal>> {
    pageLimit(limit); const r=await this.client.query("SELECT * FROM project_goal WHERE project_id=$1 AND ($2::uuid IS NULL OR goal_id>$2::uuid) ORDER BY goal_id LIMIT $3",[this.projectId,cursor??null,limit+1]); return page(r.rows,limit,rowGoal,x=>x.goal_id);
  }
  async listGoalRevisions(goalId:string):Promise<GoalRevision[]> {const r=await this.client.query("SELECT * FROM goal_revision WHERE project_id=$1 AND goal_id=$2 ORDER BY version LIMIT $3",[this.projectId,goalId,maxDetailRows+1]);return bounded(r.rows.map(rowGoalRevision),"goal revisions");}
  async getStage(id:string):Promise<Stage|null> { const r=await this.client.query("SELECT * FROM project_stage WHERE project_id=$1 AND stage_id=$2",[this.projectId,id]);return r.rows[0]?rowStage(r.rows[0]):null; }
  async listStages(goalId?:string):Promise<Stage[]> { const r=await this.client.query("SELECT * FROM project_stage WHERE project_id=$1 AND ($2::uuid IS NULL OR goal_id=$2::uuid) ORDER BY created_at,stage_id LIMIT $3",[this.projectId,goalId??null,maxDetailRows+1]);return bounded(r.rows.map(rowStage),"stages"); }
  async listStageRevisions(stageId:string):Promise<StageRevision[]> {const r=await this.client.query("SELECT * FROM stage_revision WHERE project_id=$1 AND stage_id=$2 ORDER BY version LIMIT $3",[this.projectId,stageId,maxDetailRows+1]);return bounded(r.rows.map(rowStageRevision),"stage revisions");}
  async listStageReviews(stageId:string):Promise<StageReview[]> { const r=await this.client.query("SELECT * FROM stage_review WHERE project_id=$1 AND stage_id=$2 ORDER BY stage_version,review_id LIMIT $3",[this.projectId,stageId,maxDetailRows+1]);return bounded(r.rows.map(rowStageReview),"stage reviews"); }
  async getTaskProposal(taskId:string,taskRevisionId?:string):Promise<TaskProposal|null> { const r=await this.client.query("SELECT p.* FROM task_proposal p JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id WHERE p.project_id=$1 AND p.task_id=$2 AND ($3::uuid IS NULL OR p.task_revision_id=$3::uuid) ORDER BY r.version DESC LIMIT 1",[this.projectId,taskId,taskRevisionId??null]);return r.rows[0]?rowProposal(r.rows[0]):null; }
  async listTaskJudgements(taskId:string):Promise<TaskJudgement[]> {const r=await this.client.query("SELECT j.* FROM task_judgement j JOIN task_revision r ON r.project_id=j.project_id AND r.task_id=j.task_id AND r.revision_id=j.task_revision_id WHERE j.project_id=$1 AND j.task_id=$2 ORDER BY r.version,j.created_at,j.judgement_id LIMIT $3",[this.projectId,taskId,maxDetailRows+1]);return bounded(r.rows.map(rowJudgement),"task judgements");}
  async getDelivery(id:string):Promise<Delivery|null> {const r=await this.client.query("SELECT * FROM delivery WHERE project_id=$1 AND delivery_id=$2",[this.projectId,id]);return r.rows[0]?rowDelivery(r.rows[0]):null;}
  async listDeliveries(taskId:string):Promise<Delivery[]> {const r=await this.client.query("SELECT d.* FROM delivery d JOIN task_revision r ON r.project_id=d.project_id AND r.task_id=d.task_id AND r.revision_id=d.task_revision_id WHERE d.project_id=$1 AND d.task_id=$2 ORDER BY r.version LIMIT $3",[this.projectId,taskId,maxDetailRows+1]);return bounded(r.rows.map(rowDelivery),"deliveries");}
  async listObservations(taskId:string):Promise<ConsumerObservation[]> {const r=await this.client.query("SELECT * FROM consumer_observation WHERE project_id=$1 AND task_id=$2 ORDER BY sequence LIMIT $3",[this.projectId,taskId,maxDetailRows+1]);return bounded(r.rows.map(rowObservation),"observations");}
  async listTaskClosures(taskId:string):Promise<TaskClosure[]> {const r=await this.client.query("SELECT * FROM task_closure WHERE project_id=$1 AND task_id=$2 ORDER BY created_at,closure_id LIMIT $3",[this.projectId,taskId,maxDetailRows+1]);return bounded(r.rows.map(rowClosure),"task closures");}
  async getCognitiveClosureFact(decisionId:string):Promise<CognitiveClosureFact|null> {
    const r=await this.client.query(`SELECT d.decision_id,d.data->>'actorId' AS actor_id,d.data->>'kind' AS kind,
      dispatch.dispatch_id,dispatch.task_id,dispatch.loop_id,dispatch.inbox_id AS source_inbox_id,
      dispatch.data->>'purpose' AS purpose,dispatch.data->>'recipientRoleId' AS recipient_role_id,
      dispatch.data->>'outcome' AS outcome,loop.data->>'cognitiveRoleId' AS cognitive_role_id,loop.state AS loop_state,
      source_inbox.source_event_id,run.run_id,run.task_revision_id,run.state AS run_state,
      CASE WHEN source_out.kind='observation.record' THEN source_observation.task_id
           WHEN source_out.kind='document' AND source_doc.kind='issue' THEN source_doc.origin_task_id
           WHEN source_event.kind IN ('worker.outcome','dispatch.gap') THEN source_dispatch.task_id
           ELSE NULL END AS source_task_id
    FROM orchestration_decision d
    JOIN orchestration_dispatch dispatch ON dispatch.project_id=d.project_id AND dispatch.dispatch_id=d.dispatch_id
      AND dispatch.state='completed' AND dispatch.data->>'purpose'='cognition'
    JOIN orchestration_loop loop ON loop.project_id=dispatch.project_id AND loop.loop_id=dispatch.loop_id
      AND dispatch.data->>'recipientRoleId'=loop.data->>'cognitiveRoleId'
    JOIN orchestration_inbox source_inbox ON source_inbox.project_id=dispatch.project_id
      AND source_inbox.inbox_id=dispatch.inbox_id AND source_inbox.loop_id=dispatch.loop_id
      AND source_inbox.source_event_id=(dispatch.data->>'sourceEventId')::uuid
      AND source_inbox.purpose='cognitive_review' AND source_inbox.state='disposed'
      AND source_inbox.data->>'disposition'='dispatch'
    JOIN runtime_run run ON run.project_id=dispatch.project_id
      AND run.run_id=(dispatch.data->>'runtimeRunId')::uuid AND run.task_id=dispatch.task_id
      AND run.state IN ('completed','failed','interrupted')
      AND d.data->>'runId'=run.run_id::text AND d.data->>'taskId'=run.task_id::text
    JOIN orchestration_event signed ON signed.project_id=d.project_id AND signed.entity_id=d.decision_id
      AND signed.loop_id=dispatch.loop_id AND signed.kind='worker.decision'
      AND signed.actor_id=d.data->>'actorId' AND signed.detail->>'runId'=run.run_id::text
    JOIN orchestration_operation signed_op ON signed_op.project_id=signed.project_id
      AND signed_op.operation_id=signed.operation_id AND signed_op.actor_id=signed.actor_id
      AND signed_op.result->>'entityId'=d.decision_id::text
    JOIN orchestration_event settled ON settled.project_id=dispatch.project_id
      AND settled.loop_id=dispatch.loop_id AND settled.entity_id=dispatch.dispatch_id
      AND settled.kind='worker.outcome' AND settled.detail->>'decisionId'=d.decision_id::text
      AND settled.detail->>'outcome'=dispatch.data->>'outcome'
    JOIN orchestration_operation settled_op ON settled_op.project_id=settled.project_id
      AND settled_op.operation_id=settled.operation_id AND settled_op.actor_id=settled.actor_id
      AND settled_op.result->>'entityId'=dispatch.dispatch_id::text
    LEFT JOIN outbox_event source_out ON source_out.project_id=source_inbox.project_id AND source_out.event_id=source_inbox.source_event_id
    LEFT JOIN consumer_observation source_observation ON source_observation.project_id=source_out.project_id
      AND source_observation.observation_id=source_out.entity_id AND source_out.kind='observation.record'
    LEFT JOIN process_document source_doc ON source_doc.project_id=source_out.project_id AND source_doc.document_id=source_out.entity_id
    LEFT JOIN orchestration_event source_event ON source_event.project_id=source_inbox.project_id AND source_event.event_id=source_inbox.source_event_id
    LEFT JOIN orchestration_dispatch source_dispatch ON source_dispatch.project_id=source_event.project_id AND source_dispatch.dispatch_id=source_event.entity_id
    WHERE d.project_id=$1 AND d.decision_id=$2 LIMIT 1`,[this.projectId,decisionId]);
    const x=r.rows[0];return x?{projectId:this.projectId,decisionId:x.decision_id,actorId:x.actor_id,kind:x.kind,
      taskId:x.task_id,taskRevisionId:x.task_revision_id,runId:x.run_id,runState:x.run_state,dispatchId:x.dispatch_id,
      loopId:x.loop_id,sourceInboxId:x.source_inbox_id,sourceEventId:x.source_event_id,sourceTaskId:x.source_task_id??null,
      outcome:x.outcome,purpose:x.purpose,recipientRoleId:x.recipient_role_id,cognitiveRoleId:x.cognitive_role_id,loopState:x.loop_state} as CognitiveClosureFact:null;
  }
  async getWaitingHandoffFact(inboxId:string):Promise<WaitingHandoffFact|null> {
    const r=await this.client.query(`SELECT i.inbox_id,i.loop_id,i.source_event_id,i.recipient_role_id,e.actor_id
      FROM orchestration_inbox i JOIN orchestration_event e ON e.project_id=i.project_id AND e.loop_id=i.loop_id
        AND e.entity_id=i.inbox_id AND e.kind='inbox.disposed' AND e.detail->>'disposition'='waiting'
      JOIN orchestration_operation op ON op.project_id=e.project_id AND op.operation_id=e.operation_id
        AND op.actor_id=e.actor_id AND op.result->>'entityId'=i.inbox_id::text
      WHERE i.project_id=$1 AND i.inbox_id=$2 AND i.purpose='next_action' AND i.state='disposed'
        AND i.data->>'disposition'='waiting' LIMIT 1`,[this.projectId,inboxId]);
    const x=r.rows[0];return x?{projectId:this.projectId,inboxId:x.inbox_id,loopId:x.loop_id,
      sourceEventId:x.source_event_id,recipientRoleId:x.recipient_role_id,disposition:"waiting",actorId:x.actor_id}:null;
  }
  async getProject(): Promise<Project | null> {
    const r = await this.client.query("SELECT project_id, title, created_at FROM project WHERE project_id=$1", [this.projectId]);
    return r.rows[0] ? rowProject(r.rows[0]) : null;
  }
  async getDocument(id: string): Promise<Document | null> {
    const r = await this.client.query(`SELECT d.*, t.task_id AS primary_task_id FROM process_document d
      LEFT JOIN task t ON t.project_id=d.project_id AND t.content_document_id=d.document_id
      WHERE d.project_id=$1 AND d.document_id=$2`, [this.projectId, id]);
    return r.rows[0] ? rowDocument(r.rows[0]) : null;
  }
  async getDocumentRevision(documentId: string, revisionId: string): Promise<DocumentRevision | null> {
    const r = await this.client.query("SELECT * FROM document_revision WHERE project_id=$1 AND document_id=$2 AND revision_id=$3", [this.projectId, documentId, revisionId]);
    return r.rows[0] ? rowDocumentRevision(r.rows[0]) : null;
  }
  async hasDocumentAdoption(documentId: string, revisionId: string): Promise<boolean> {
    const r = await this.client.query("SELECT EXISTS(SELECT 1 FROM document_decision WHERE project_id=$1 AND document_id=$2 AND revision_id=$3) AS adopted",
      [this.projectId, documentId, revisionId]);
    return r.rows[0]?.adopted === true;
  }
  async listDocuments(limit: number, cursor?: string): Promise<Page<Document>> {
    pageLimit(limit);
    const r = await this.client.query(`SELECT d.*, t.task_id AS primary_task_id FROM process_document d
      LEFT JOIN task t ON t.project_id=d.project_id AND t.content_document_id=d.document_id
      WHERE d.project_id=$1 AND ($2::uuid IS NULL OR d.document_id>$2::uuid)
      ORDER BY d.document_id LIMIT $3`, [this.projectId, cursor ?? null, limit + 1]);
    return page(r.rows, limit, rowDocument, (x) => x.document_id);
  }
  async getTask(id: string): Promise<Task | null> {
    const r = await this.client.query(`SELECT t.*,dr.body AS content,tr.state AS legacy_state,
      tr.reason AS legacy_revision_reason,legacy_judgement.decision AS legacy_judgement_decision,
      legacy_judgement.reason AS legacy_judgement_reason ${taskReadProjection}
      WHERE t.project_id=$1 AND t.task_id=$2`, [this.projectId, id]);
    return r.rows[0] ? rowTask(r.rows[0]) : null;
  }
  async getTaskRevision(taskId: string, revisionId: string): Promise<TaskRevision | null> {
    const r = await this.client.query(`SELECT tr.*,dr.body AS content FROM task_revision tr JOIN document_revision dr
      ON dr.project_id=tr.project_id AND dr.document_id=tr.content_document_id AND dr.revision_id=tr.content_revision_id
      WHERE tr.project_id=$1 AND tr.task_id=$2 AND tr.revision_id=$3`, [this.projectId, taskId, revisionId]);
    return r.rows[0] ? rowTaskRevision(r.rows[0]) : null;
  }
  async listTaskRevisions(taskId: string): Promise<TaskRevision[]> {
    const r = await this.client.query(`SELECT tr.*,dr.body AS content FROM task_revision tr JOIN document_revision dr
      ON dr.project_id=tr.project_id AND dr.document_id=tr.content_document_id AND dr.revision_id=tr.content_revision_id
      WHERE tr.project_id=$1 AND tr.task_id=$2 ORDER BY tr.version LIMIT $3`, [this.projectId, taskId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowTaskRevision), "task revisions");
  }
  async getBasisSet(taskId: string, taskRevisionId: string, basisSetId: string): Promise<BasisSet | null> {
    const found = await this.client.query("SELECT * FROM basis_set WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4 AND sealed", [this.projectId, taskId, taskRevisionId, basisSetId]);
    if (!found.rows[0]) return null;
    const retentions: unknown = found.rows[0].retentions;
    if (!Array.isArray(retentions) || retentions.some(item => !item || typeof item !== "object" ||
      ["documentId", "revisionId", "observedAdoptedRevisionId", "reason", "actorId", "createdAt"]
        .some(key => typeof item[key] !== "string" || !item[key])))
      throw new DomainError("INVALID_BASIS", "Sealed basis has malformed retention evidence");
    const members = await this.client.query("SELECT document_id, document_revision_id FROM basis_member WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4 ORDER BY document_id", [this.projectId, taskId, taskRevisionId, basisSetId]);
    return { projectId: this.projectId, taskId, taskRevisionId, id: basisSetId, sealed: true,
      members: members.rows.map((m) => ({ documentId: m.document_id, revisionId: m.document_revision_id })),
      ...(retentions.length ? { retentions: retentions as BasisRetention[] } : {}) };
  }
  async listTasks(limit: number, cursor?: string): Promise<Page<Task>> {
    pageLimit(limit);
    const r = await this.client.query(`SELECT t.*,dr.body AS content,tr.state AS legacy_state,
      tr.reason AS legacy_revision_reason,legacy_judgement.decision AS legacy_judgement_decision,
      legacy_judgement.reason AS legacy_judgement_reason ${taskReadProjection}
      WHERE t.project_id=$1 AND ($2::uuid IS NULL OR t.task_id>$2::uuid) ORDER BY t.task_id LIMIT $3`, [this.projectId, cursor ?? null, limit + 1]);
    return page(r.rows, limit, rowTask, (x) => x.task_id);
  }
  async listLinks(taskId: string): Promise<TaskDocumentLink[]> {
    const r = await this.client.query("SELECT * FROM task_document_link WHERE project_id=$1 AND task_id=$2 ORDER BY link_id LIMIT $3", [this.projectId, taskId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowLink), "task links");
  }
  async getImpact(id: string): Promise<Impact | null> {
    const r = await this.client.query("SELECT * FROM impact_review WHERE project_id=$1 AND impact_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowImpact(r.rows[0]) : null;
  }
  async listImpacts(taskId?: string): Promise<Impact[]> {
    const r = await this.client.query("SELECT * FROM impact_review WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2::uuid) ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END, created_at, impact_id LIMIT $3", [this.projectId, taskId ?? null, maxDetailRows + 1]);
    return bounded(r.rows.map(rowImpact), "impacts");
  }
  async listBasisDecisions(taskId: string): Promise<BasisDecision[]> {
    const r = await this.client.query("SELECT * FROM basis_decision WHERE project_id=$1 AND task_id=$2 ORDER BY created_at, decision_id LIMIT $3", [this.projectId, taskId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowBasisDecision), "basis decisions");
  }
  async getOperation(id: string): Promise<Operation | null> {
    const r = await this.client.query("SELECT * FROM operation_journal WHERE project_id=$1 AND operation_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowOperation(r.rows[0]) : null;
  }
  async findTasksUsingDocument(documentId: string): Promise<Task[]> {
    const r = await this.client.query(`SELECT DISTINCT t.*,dr.body AS content FROM task t
      JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
      JOIN document_revision dr ON dr.project_id=t.project_id AND dr.document_id=t.content_document_id AND dr.revision_id=t.content_revision_id
      JOIN basis_set b ON b.project_id=t.project_id AND b.task_id=t.task_id AND b.task_revision_id=tr.revision_id AND b.basis_set_id=tr.basis_set_id AND b.sealed
      JOIN basis_member bm ON bm.project_id=b.project_id AND bm.task_id=b.task_id AND bm.task_revision_id=b.task_revision_id AND bm.basis_set_id=b.basis_set_id
      WHERE t.project_id=$1 AND bm.document_id=$2 ORDER BY t.task_id LIMIT $3`, [this.projectId, documentId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowTask), "tasks using document");
  }
}

class PgTransaction extends PgReader implements Transaction {
  insertEvaluationRevision(value: import("@evoloop/contracts/evaluation").EvaluationRevision) { return this.evaluations.insertEvaluationRevision(value); }
  insertEvaluationAttempt(value: import("@evoloop/contracts/evaluation").EvaluationAttempt) { return this.evaluations.insertEvaluationAttempt(value); }
  insertEvaluationAssessment(value: import("@evoloop/contracts/evaluation").EvaluationAssessment) { return this.evaluations.insertEvaluationAssessment(value); }
  insertEvaluationConclusion(value: import("@evoloop/contracts/evaluation").EvaluationConclusion) { return this.evaluations.insertEvaluationConclusion(value); }
  insertDiscussion(value: import("@evoloop/contracts").DiscussionRecord, event: import("@evoloop/contracts").DiscussionEvent) { return this.discussions.insertDiscussion(value, event); }
  updateDiscussion(value: import("@evoloop/contracts").DiscussionRecord, expectedVersion: number, event: import("@evoloop/contracts").DiscussionEvent) { return this.discussions.updateDiscussion(value, expectedVersion, event); }
  insertFormalSourceDecision(value:FormalSourceDecision){return this.references.insertFormalSourceDecision(value);}
  insertTaskExternalDecision(value:TaskExternalReferenceRecord){return this.references.insertTaskExternalDecision(value);}
  advanceTaskExternalHead(value:TaskExternalReferenceHead,expectedVersion:number){return this.references.advanceTaskExternalHead(value,expectedVersion);}

  createRole(record: RoleRecord, revision: RoleRevision) { return this.roles.createRole(record, revision); }
  advanceRole(record: RoleRecord, expectedVersion: number, revision: RoleRevision) { return this.roles.advanceRole(record, expectedVersion, revision); }
  addDecision(value: RoleDecision) { return this.roles.addDecision(value); }
  addReview(value: RoleTrialReview) { return this.roles.addReview(value); }
  getHandoff(id: string) { return this.roles.getHandoff(id); }
  addHandoff(value: RoleHandoff, event: RoleHandoffEvent) { return this.roles.addHandoff(value, event); }
  acknowledgeHandoff(value: RoleHandoff, event: RoleHandoffEvent) { return this.roles.acknowledgeHandoff(value, event); }
  listUnacknowledgedHandoffs(id: string) { return this.roles.listUnacknowledgedHandoffs(id); }
  listUnfinishedOwnedTasks(id: string) { return this.roles.listUnfinishedOwnedTasks(id); }
  listOpenRuntimeSessions(id: string) { return this.roles.listOpenRuntimeSessions(id); }
  addSessionBinding(value: RoleSessionBinding) { return this.roles.addSessionBinding(value); }
  insertSchedule(value: ScheduleDefinition) { return this.scheduling.insertSchedule(value); }
  updateSchedule(value: ScheduleDefinition, expectedVersion: number) { return this.scheduling.updateSchedule(value, expectedVersion); }
  insertDocumentPayloadRevision(value: DocumentPayloadRevision) { return this.payloads.insertDocumentPayloadRevision(value); }
  registerDocumentBlob(value: RegisteredDocumentBlob) { return this.payloads.registerDocumentBlob(value); }
  insertGitSourceRef(id: string, ref: GitSourceRef, state: "reachable" | "unavailable" | "withdrawn", observedAt: string) { return this.payloads.insertGitSourceRef(id, ref, state, observedAt); }
  insertRuntimeSession(item: import("@evoloop/contracts").RuntimeSessionRecord) { return this.runtime.insertRuntimeSession(item); }
  updateRuntimeSession(item: import("@evoloop/contracts").RuntimeSessionRecord, expectedVersion: number) { return this.runtime.updateRuntimeSession(item, expectedVersion); }
  insertRuntimeRun(item: import("@evoloop/contracts").RuntimeRunRecord) { return this.runtime.insertRuntimeRun(item); }
  updateRuntimeRun(item: import("@evoloop/contracts").RuntimeRunRecord, expectedVersion: number) { return this.runtime.updateRuntimeRun(item, expectedVersion); }
  appendRuntimeEvent(item: import("@evoloop/contracts").RuntimeRecordEvent) { return this.runtime.appendRuntimeEvent(item); }
  private savepointNumber = 0;
  private assertScope(projectId: string): void {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "object belongs to another project");
  }
  async insertGoal(g:Goal,reason:string):Promise<void> {this.assertScope(g.projectId);await this.client.query("INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[g.projectId,g.id,g.version,g.outcome,g.constraints,g.consumer,g.authority,g.scope,g.owner,g.actorId,g.createdAt]);await this.insertGoalRevision(g,reason);}
  private async insertGoalRevision(g:Goal,reason:string):Promise<void> {await this.client.query("INSERT INTO goal_revision(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[g.projectId,g.id,g.version,g.outcome,g.constraints,g.consumer,g.authority,g.scope,g.owner,g.actorId,reason,g.createdAt]);}
  async updateGoal(g:Goal,expectedVersion:number,reason:string):Promise<void> {this.assertScope(g.projectId);const r=await this.client.query("UPDATE project_goal SET version=$3,outcome=$4,constraints=$5,consumer=$6,authority=$7,scope=$8,owner=$9,actor_id=$10,created_at=$11 WHERE project_id=$1 AND goal_id=$2 AND version=$12",[g.projectId,g.id,g.version,g.outcome,g.constraints,g.consumer,g.authority,g.scope,g.owner,g.actorId,g.createdAt,expectedVersion]);if(!r.rowCount)throw new DomainError("VERSION_CONFLICT","goal version changed",(await this.getGoal(g.id))?.version);await this.insertGoalRevision(g,reason);}
  async insertStage(s:Stage,r:StageRevision):Promise<void> {this.assertScope(s.projectId);await this.client.query("INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[s.projectId,s.id,s.goalId,s.version,s.deliverable,s.learningQuestion,s.state,s.actorId,s.createdAt]);await this.insertStageRevision(r);}
  private async insertStageRevision(r:StageRevision):Promise<void> {await this.client.query("INSERT INTO stage_revision(project_id,stage_id,revision_id,version,state,deliverable,learning_question,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[r.projectId,r.stageId,r.id,r.version,r.state,r.deliverable,r.learningQuestion,r.actorId,r.reason,r.createdAt]);}
  async updateStage(s:Stage,r:StageRevision,expectedVersion:number):Promise<void> {this.assertScope(s.projectId);const q=await this.client.query("UPDATE project_stage SET version=$3,state=$4,actor_id=$5,created_at=$6 WHERE project_id=$1 AND stage_id=$2 AND version=$7",[s.projectId,s.id,s.version,s.state,s.actorId,s.createdAt,expectedVersion]);if(!q.rowCount)throw new DomainError("VERSION_CONFLICT","stage version changed",(await this.getStage(s.id))?.version);await this.insertStageRevision(r);}
  async insertStageReview(r:StageReview):Promise<void> {this.assertScope(r.projectId);await this.client.query("INSERT INTO stage_review(project_id,review_id,stage_id,stage_version,supersedes_review_id,adopted,rejected,gap,next_choice,evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[r.projectId,r.id,r.stageId,r.stageVersion,r.supersedesReviewId,r.adopted,r.rejected,r.gap,r.nextChoice,r.evidence,r.reason,r.actorId,r.createdAt]);}
  async insertTaskProposal(p:TaskProposal):Promise<void> {this.assertScope(p.projectId);await this.client.query("INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,evidence,stop_condition,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[p.projectId,p.taskId,p.taskRevisionId,p.stageId,p.consumer,p.useRequired,p.evidence,p.stopCondition,p.createdAt]);}
  async insertTaskJudgement(j:TaskJudgement):Promise<void> {this.assertScope(j.projectId);await this.client.query("INSERT INTO task_judgement(project_id,judgement_id,task_id,task_revision_id,decision,reason,evidence,relook_condition,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[j.projectId,j.id,j.taskId,j.taskRevisionId,j.decision,j.reason,j.evidence,j.relookCondition,j.actorId,j.createdAt]);}
  async insertDelivery(d:Delivery):Promise<void> {this.assertScope(d.projectId);await this.client.query("INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[d.projectId,d.id,d.taskId,d.taskRevisionId,d.runId??null,d.artifactRef,d.artifactRevision,d.contentHash,d.technicalResult,d.technicalEvidence,d.reason,d.actorId,d.createdAt]);}
  async insertObservation(o:ConsumerObservation):Promise<void> {this.assertScope(o.projectId);await this.client.query("INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[o.projectId,o.id,o.taskId,o.deliveryId,o.observer,o.observerKind,o.result,o.evidence,o.reason,o.actorId,o.createdAt]);}
  async insertTaskClosure(c:TaskClosure):Promise<void> {this.assertScope(c.projectId);await this.client.query("INSERT INTO task_closure(project_id,closure_id,task_id,task_revision_id,delivery_id,decision_id,source_inbox_id,source_event_id,source_task_id,waiting_inbox_id,acceptance_result,acceptance_evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[c.projectId,c.id,c.taskId,c.taskRevisionId,c.deliveryId,c.decisionId,c.sourceInboxId,c.sourceEventId,c.sourceTaskId,c.waitingInboxId,c.acceptanceResult,c.acceptanceEvidence,c.reason,c.actorId,c.createdAt]);}
  async savepoint<T>(action: () => Promise<T>): Promise<T> {
    const name = `effect_${++this.savepointNumber}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await action();
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  async insertProject(p: Project): Promise<void> {
    this.assertScope(p.id);
    await this.client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)", [this.projectId, p.title, p.createdAt]);
  }
  async insertDocument(d: Document): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status,origin_task_id,origin_task_revision_id,origin_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [this.projectId, d.id, d.title, d.version, d.currentRevisionId, d.adoptedRevisionId, d.kind, d.status, d.origin?.taskId ?? null, d.origin?.taskRevisionId ?? null, d.origin?.runId ?? null]);
  }
  async insertDocumentRevision(r: DocumentRevision): Promise<void> {
    this.assertScope(r.projectId);
    await this.client.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, r.documentId, r.id, r.body, r.format, r.contentHash, r.author, r.createdAt, r.previousRevisionId, r.reason]);
  }
  async insertDocumentDecision(d: DocumentDecision): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [this.projectId, d.id, d.documentId, d.revisionId, d.actorId, d.reason, d.createdAt]);
  }
  async updateDocument(d: Document, expectedVersion: number): Promise<void> {
    this.assertScope(d.projectId);
    const r = await this.client.query("UPDATE process_document SET title=$3, version=$4, current_revision_id=$5, adopted_revision_id=$6,kind=$8,status=$9 WHERE project_id=$1 AND document_id=$2 AND version=$7 RETURNING version", [this.projectId, d.id, d.title, d.version, d.currentRevisionId, d.adoptedRevisionId, expectedVersion, d.kind, d.status]);
    if (!r.rowCount) throw await this.versionConflict("process_document", "document_id", d.id);
  }
  async insertTask(t: Task): Promise<void> {
    this.assertScope(t.projectId);
    await this.client.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [this.projectId, t.id, t.version, t.currentRevisionId, t.title, t.acceptance, t.owner, t.state, t.kind, t.contentDocumentId, t.contentRevisionId]);
  }
  async insertTaskRevision(r: TaskRevision): Promise<void> {
    this.assertScope(r.projectId);
    await this.client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [this.projectId, r.taskId, r.id, r.version, r.title, r.acceptance, r.owner, r.state, r.kind, r.contentDocumentId, r.contentRevisionId, r.basisSetId, r.actorId, r.reason, r.createdAt]);
  }
  async insertSealedBasisSet(b: BasisSet): Promise<void> {
    this.assertScope(b.projectId);
    await this.client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed,retentions) VALUES($1,$2,$3,$4,false,$5::jsonb)",
      [this.projectId, b.taskId, b.taskRevisionId, b.id, JSON.stringify(b.retentions ?? [])]);
    for (const member of b.members) {
      await this.client.query("INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [this.projectId, b.taskId, b.taskRevisionId, b.id, member.documentId, member.revisionId]);
    }
    await this.client.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4", [this.projectId, b.taskId, b.taskRevisionId, b.id]);
  }
  async updateTask(t: Task, expectedVersion: number): Promise<void> {
    this.assertScope(t.projectId);
    const r = await this.client.query("UPDATE task SET version=$3,current_revision_id=$4,title=$5,acceptance=$6,owner=$7,state=$8,kind=$9,content_document_id=$10,content_revision_id=$11 WHERE project_id=$1 AND task_id=$2 AND version=$12 RETURNING version", [this.projectId, t.id, t.version, t.currentRevisionId, t.title, t.acceptance, t.owner, t.state, t.kind, t.contentDocumentId, t.contentRevisionId, expectedVersion]);
    if (!r.rowCount) throw await this.versionConflict("task", "task_id", t.id);
  }
  async insertLink(l: TaskDocumentLink): Promise<void> {
    this.assertScope(l.projectId);
    await this.client.query("INSERT INTO task_document_link(project_id,link_id,task_id,document_id,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6)", [this.projectId, l.id, l.taskId, l.documentId, l.actorId, l.createdAt]);
  }
  async insertImpact(i: Impact): Promise<void> {
    this.assertScope(i.projectId);
    await this.client.query("INSERT INTO impact_review(project_id,impact_id,task_id,task_revision_id,document_id,from_revision_id,to_revision_id,state,decision_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, i.id, i.taskId, i.taskRevisionId, i.documentId, i.fromRevisionId, i.toRevisionId, i.state, i.decisionId, i.createdAt]);
  }
  async resolveImpact(id: string, decisionId: string): Promise<void> {
    const r = await this.client.query("UPDATE impact_review SET state='resolved',decision_id=$3 WHERE project_id=$1 AND impact_id=$2 AND state='pending'", [this.projectId, id, decisionId]);
    if (!r.rowCount) throw new DomainError("IMPACT_NOT_PENDING", "impact is not pending");
  }
  async supersedeImpacts(taskId: string, documentId: string): Promise<void> {
    await this.client.query("UPDATE impact_review SET state='superseded' WHERE project_id=$1 AND task_id=$2 AND document_id=$3 AND state='pending'", [this.projectId, taskId, documentId]);
  }
  async insertBasisDecision(d: BasisDecision): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO basis_decision(project_id,decision_id,impact_id,task_id,previous_task_revision_id,next_task_revision_id,decision,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, d.id, d.impactId, d.taskId, d.previousTaskRevisionId, d.nextTaskRevisionId, d.decision, d.reason, d.actorId, d.createdAt]);
  }
  async insertOperation(o: Operation): Promise<void> {
    this.assertScope(o.projectId);
    await this.client.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [this.projectId, o.id, o.actorId, o.commandHash, o.commandType, JSON.stringify(o.result), o.createdAt]);
  }
  async appendOutbox(e: OutboxEvent): Promise<void> {
    this.assertScope(e.projectId);
    await this.client.query("INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [this.projectId, e.id, e.operationId, e.effectKey, e.kind, e.entityId, e.version, e.createdAt]);
  }
  private async versionConflict(table: "task" | "process_document", column: "task_id" | "document_id", id: string): Promise<DomainError> {
    const r = await this.client.query(`SELECT version FROM ${table} WHERE project_id=$1 AND ${column}=$2`, [this.projectId, id]);
    return new DomainError("VERSION_CONFLICT", "object version has changed", r.rows[0]?.version);
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}
  async transaction<T>(projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    let destroy = false;
    try {
      try { await client.query("BEGIN"); } catch (error) { destroy = true; throw error; }
      open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
      const result = await action(new PgTransaction(client, projectId));
      try {
        await client.query("COMMIT");
        open = false;
      } catch (error) {
        // A lost COMMIT response is an unknown outcome, never a domain rejection.
        destroy = true;
        throw error;
      }
      return result;
    } catch (error) {
      if (open && !destroy) {
        try { await client.query("ROLLBACK"); } catch { destroy = true; }
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
  async read<T>(projectId: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    let destroy = false;
    try {
      try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); } catch (error) { destroy = true; throw error; }
      open = true;
      const result = await action(new PgReader(client, projectId));
      try { await client.query("COMMIT"); } catch (error) { destroy = true; throw error; }
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try { await client.query("ROLLBACK"); } catch { destroy = true; }
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}

export function createPool(connectionString: string): pg.Pool { return new Pool({ connectionString }); }
export async function migrate(connectionString: string, schema = "public"): Promise<void> {
  await runner({
    databaseUrl: connectionString,
    dir: fileURLToPath(new URL("../migrations/", import.meta.url)),
    migrationsTable: "pgmigrations",
    schema,
    createSchema: schema !== "public",
    createMigrationsSchema: schema !== "public",
    direction: "up",
    singleTransaction: true,
    log: () => {},
  });
}
