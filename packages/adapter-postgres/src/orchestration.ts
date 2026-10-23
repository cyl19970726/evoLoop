import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { OrchestrationAuthorizationFact, OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationOperation, OrchestrationReader, OrchestrationSourceFact, OrchestrationStore, OrchestrationSubmission, OrchestrationTaskFact, OrchestrationTransaction, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import { scheduledSourceFacts } from "./schedule-source.js";

type Row = Record<string, any>;
type Authorization = {
  getAuthorizationFact(projectId: string, scopeId: string): Promise<OrchestrationAuthorizationFact | null>;
  canActAsRole(projectId: string, actorId: string, roleId: string): Promise<boolean>;
  wasActorRole(projectId: string, actorId: string, loopId: string, roleId: string): Promise<boolean>;
};
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const data = <T>(row: Row | undefined): T | null => row ? row.data as T : null;
const page = <T>(items: T[], limit: number, id: (item:T)=>string) => ({
  items: items.slice(0,limit), nextCursor: items.length>limit ? id(items[limit-1]!) : null,
});
class Reader implements OrchestrationReader {
  constructor(protected readonly db:PoolClient, protected readonly projectId:string) {}
  private async waitingResumeFact(id:string,seen:Set<string>):Promise<OrchestrationSourceFact|null>{
    const r=await this.db.query(`SELECT e.*,op.actor_id AS operation_actor,op.result AS operation_result,op.command_hash,
      d.data AS dispatch_data,w.data AS decision_data,l.data AS loop_data,
      run.task_id AS run_task_id,run.state AS run_state
      FROM orchestration_event e
      JOIN orchestration_operation op ON op.project_id=e.project_id AND op.operation_id=e.operation_id
      JOIN orchestration_loop l ON l.project_id=e.project_id AND l.loop_id=e.loop_id
      JOIN orchestration_decision w ON w.project_id=e.project_id AND w.decision_id=e.entity_id
      JOIN orchestration_dispatch d ON d.project_id=e.project_id AND d.dispatch_id=w.dispatch_id
      JOIN runtime_run run ON run.project_id=e.project_id AND run.run_id=(d.data->>'runtimeRunId')::uuid
      WHERE e.project_id=$1 AND e.event_id=$2 AND e.kind='waiting.resumed' AND e.entity_type='decision'
        AND NOT EXISTS (SELECT 1 FROM orchestration_event duplicate WHERE duplicate.project_id=e.project_id
          AND duplicate.kind='waiting.resumed' AND duplicate.event_id<>e.event_id
          AND duplicate.operation_id=e.operation_id AND duplicate.actor_id=e.actor_id
          AND duplicate.entity_type=e.entity_type AND duplicate.entity_id=e.entity_id
          AND duplicate.detail=e.detail)`,[this.projectId,id]);
    const x=r.rows[0];if(!x)return null;
    const detail=x.detail as Record<string,unknown>,op=x.operation_result as Record<string,unknown>;
    const loop=x.loop_data as OrchestrationLoop,dispatch=x.dispatch_data as OrchestrationDispatch,decision=x.decision_data as OrchestrationWorkerDecision;
    if(x.operation_actor!==x.actor_id || op.entityType!=="loop" || op.entityId!==loop.id ||
      !Number.isInteger(op.version) || Number(op.version)<2 || Number(op.version)>loop.version ||
      op.version!==detail.resumedAtLoopVersion ||
      decision.projectId!==this.projectId || decision.id!==x.entity_id || decision.kind!=="waiting" ||
      decision.dispatchId!==dispatch.id || decision.runId!==dispatch.runtimeRunId || decision.taskId!==dispatch.taskId ||
      dispatch.projectId!==this.projectId || dispatch.loopId!==loop.id || dispatch.parentDispatchId!==null ||
      dispatch.recipientRoleId!==loop.cognitiveRoleId || dispatch.state!=="completed" || dispatch.outcome!=="waiting" ||
      x.run_task_id!==dispatch.taskId || !["completed","failed","interrupted"].includes(x.run_state) ||
      detail.decisionId!==decision.id || detail.dispatchId!==dispatch.id || detail.runId!==decision.runId ||
      typeof detail.evidenceRef!=="string" || !detail.evidenceRef.trim() ||
      typeof detail.reason!=="string" || !detail.reason.trim() ||
      typeof detail.previousSourceEventId!=="string" || detail.previousSourceEventId!==dispatch.sourceEventId ||
      typeof detail.originalSourceEventId!=="string" || typeof detail.issueDocumentId!=="string" ||
      typeof detail.issueRevisionId!=="string" || typeof detail.issueContentHash!=="string")return null;
    const command={projectId:this.projectId,operationId:x.operation_id,type:"loop.resumeWaiting",loopId:loop.id,
      expectedLoopVersion:Number(op.version)-1,decisionId:decision.id,dispatchId:dispatch.id,
      evidenceRef:detail.evidenceRef,reason:detail.reason};
    if(createHash("sha256").update(canonical(command)).digest("hex")!==x.command_hash)return null;
    const previous=await this.getSourceFactInternal(detail.previousSourceEventId,seen);
    const root=detail.originalSourceEventId===detail.previousSourceEventId?previous:
      await this.getSourceFactInternal(detail.originalSourceEventId,seen);
    if(!previous || !root || root.kind!=="document" || root.projectId!==this.projectId ||
      !root.operationId || !root.sourceActorId || root.subjectVersion!==1 || !root.issueRevisionId || !root.issueContentHash ||
      (previous.kind==="document" && previous.id!==root.id) ||
      (previous.kind==="waiting.resumed" && (previous.sourceLoopId!==loop.id || previous.originalSourceEventId!==root.id ||
        previous.subjectId!==root.subjectId || previous.issueRevisionId!==root.issueRevisionId ||
        previous.issueContentHash!==root.issueContentHash)) ||
      !["document","waiting.resumed"].includes(previous.kind) ||
      detail.issueDocumentId!==root.subjectId || detail.issueRevisionId!==root.issueRevisionId ||
      detail.issueContentHash!==root.issueContentHash)return null;
    const fixed=await this.db.query(`SELECT 1 FROM process_document doc
      JOIN task_revision tr ON tr.project_id=doc.project_id AND tr.task_id=doc.origin_task_id
        AND tr.revision_id=doc.origin_task_revision_id
      JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal JOIN task_revision pr
        ON pr.project_id=proposal.project_id AND pr.task_id=proposal.task_id AND pr.revision_id=proposal.task_revision_id
        WHERE proposal.project_id=tr.project_id AND proposal.task_id=tr.task_id AND pr.version<=tr.version
        ORDER BY pr.version DESC LIMIT 1) scope ON scope.stage_id IS NOT NULL
      JOIN project_stage stage ON stage.project_id=doc.project_id AND stage.stage_id=scope.stage_id
      LEFT JOIN runtime_run origin_run ON origin_run.project_id=doc.project_id AND origin_run.run_id=doc.origin_run_id
      WHERE doc.project_id=$1 AND doc.document_id=$2 AND doc.kind='issue' AND stage.goal_id=$3
        AND ($4::uuid IS NULL OR stage.stage_id=$4)
        AND (doc.origin_run_id IS NULL OR (origin_run.task_id=doc.origin_task_id AND
          origin_run.task_revision_id=doc.origin_task_revision_id AND origin_run.state<>'unknown')) LIMIT 1`,
      [this.projectId,root.subjectId,loop.goalId,loop.stageId]);
    if(!fixed.rowCount)return null;
    return {projectId:this.projectId,id:x.event_id,createdAtUtc:iso(x.created_at_utc),kind:"waiting.resumed",
      subjectId:root.subjectId,subjectVersion:1,sourceLoopId:loop.id,originDispatchId:dispatch.id,
      operationId:x.operation_id,sourceActorId:x.actor_id,observationId:null,deliveryId:null,observationResult:null,
      issueRevisionId:root.issueRevisionId,issueContentHash:root.issueContentHash,waitingDecisionId:decision.id,
      previousSourceEventId:previous.id,originalSourceEventId:root.id,waitingRunId:decision.runId};
  }
  async getOperation(id:string){const r=await this.db.query("SELECT * FROM orchestration_operation WHERE project_id=$1 AND operation_id=$2",[this.projectId,id]);const x=r.rows[0];return x?{projectId:x.project_id,id:x.operation_id,actorId:x.actor_id,commandHash:x.command_hash,result:x.result,createdAtUtc:iso(x.created_at_utc)} as OrchestrationOperation:null;}
  protected async one<T>(table:string,key:string,id:string):Promise<T|null> {
    const r=await this.db.query(`SELECT data FROM ${table} WHERE project_id=$1 AND ${key}=$2`,[this.projectId,id]);
    return data<T>(r.rows[0]);
  }
  protected async listing<T>(table:string,key:string,limit:number,cursor?:string,loopId?:string) {
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("limit must be 1..100");
    const clauses=["project_id=$1",...(loopId?["loop_id=$2"]:[]),...(cursor?[`${key}>$${loopId?3:2}`]:[])];
    const args=[this.projectId,...(loopId?[loopId]:[]),...(cursor?[cursor]:[]),limit+1];
    const r=await this.db.query(`SELECT data FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY ${key} LIMIT $${args.length}`,args);
    return page<T>(r.rows.map(x=>x.data),limit,x=>String((x as Record<string,string>).id));
  }
  getLoop(id:string){return this.one<OrchestrationLoop>("orchestration_loop","loop_id",id);}
  listLoops(limit:number,cursor?:string){return this.listing<OrchestrationLoop>("orchestration_loop","loop_id",limit,cursor);}
  getInbox(id:string){return this.one<OrchestrationInbox>("orchestration_inbox","inbox_id",id);}
  listInbox(loopId:string,limit:number,cursor?:string){return this.listing<OrchestrationInbox>("orchestration_inbox","inbox_id",limit,cursor,loopId);}
  getDispatch(id:string){return this.one<OrchestrationDispatch>("orchestration_dispatch","dispatch_id",id);}
  listDispatches(loopId:string,limit:number,cursor?:string){return this.listing<OrchestrationDispatch>("orchestration_dispatch","dispatch_id",limit,cursor,loopId);}
  getSubmission(id:string){return this.one<OrchestrationSubmission>("orchestration_submission","submission_id",id);}
  getDecision(id:string){return this.one<OrchestrationWorkerDecision>("orchestration_decision","decision_id",id);}
  async findSubmissionByDispatch(dispatchId:string){const r=await this.db.query("SELECT data FROM orchestration_submission WHERE project_id=$1 AND dispatch_id=$2",[this.projectId,dispatchId]);return data<OrchestrationSubmission>(r.rows[0]);}
  async findDecisionByDispatch(dispatchId:string){const r=await this.db.query("SELECT data FROM orchestration_decision WHERE project_id=$1 AND dispatch_id=$2",[this.projectId,dispatchId]);return data<OrchestrationWorkerDecision>(r.rows[0]);}
  async hasChildDispatch(parentDispatchId:string){const r=await this.db.query("SELECT 1 FROM orchestration_dispatch WHERE project_id=$1 AND data->>'parentDispatchId'=$2 LIMIT 1",[this.projectId,parentDispatchId]);return !!r.rowCount;}
  async hasWaitingResume(decisionId:string){const r=await this.db.query("SELECT 1 FROM orchestration_event WHERE project_id=$1 AND kind='waiting.resumed' AND entity_id=$2 LIMIT 1",[this.projectId,decisionId]);return !!r.rowCount;}
  async hasUnsettledDispatchForSource(loopId:string,sourceEventId:string,exceptDispatchId:string){const r=await this.db.query(`SELECT 1 FROM orchestration_dispatch WHERE project_id=$1 AND loop_id=$2
    AND data->>'sourceEventId'=$3 AND dispatch_id<>$4 AND state IN ('pending','claimed','dispatching','accepted','unknown') LIMIT 1`,[this.projectId,loopId,sourceEventId,exceptDispatchId]);return !!r.rowCount;}
  listSubmissions(loopId:string,limit:number,cursor?:string){return this.listing<OrchestrationSubmission>("orchestration_submission","submission_id",limit,cursor,loopId);}
  async listEvents(loopId:string,limit:number,cursor?:string){
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("limit must be 1..100");
    const args=[this.projectId,loopId,...(cursor?[cursor]:[]),limit+1];
    const r=await this.db.query(`SELECT * FROM orchestration_event WHERE project_id=$1 AND loop_id=$2 ${cursor?"AND event_id>$3":""} ORDER BY event_id LIMIT $${args.length}`,args);
    const rows=r.rows.map(x=>({projectId:x.project_id,id:x.event_id,loopId:x.loop_id,entityType:x.entity_type,entityId:x.entity_id,operationId:x.operation_id,kind:x.kind,actorId:x.actor_id,detail:x.detail,createdAtUtc:iso(x.created_at_utc)} as OrchestrationEvent));
    return page(rows,limit,x=>x.id);
  }
  async listSourceFacts(loopId:string,limit:number,cursor?:string){
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("limit must be 1..100");
    const loop=await this.getLoop(loopId);
    if(!loop)return {items:[],nextCursor:null};
    const [cursorTime,cursorId] = cursor ? cursor.split("|") : [undefined,undefined];
    if(cursor && (!cursorTime||!cursorId))throw new Error("invalid source cursor");
    const r=await this.db.query(`WITH sources AS (
      SELECT event_id AS id,created_at_utc,kind,entity_id AS subject_id,1 AS subject_version,
        loop_id AS source_loop_id,NULL::uuid AS origin_dispatch_id,
        NULL::uuid AS operation_id,NULL::text AS source_actor_id,NULL::uuid AS observation_id,
        NULL::uuid AS delivery_id,NULL::text AS observation_result,NULL::uuid AS gap_run_id,NULL::integer AS gap_task_version,
        NULL::uuid AS issue_revision_id,NULL::text AS issue_content_hash
        FROM orchestration_event WHERE project_id=$1 AND loop_id=$2 AND event_id=$3::uuid AND kind='loop.enrolled'
      UNION ALL
      SELECT e.event_id,e.created_at_utc,e.kind,d.task_id,d.version,e.loop_id,d.dispatch_id,
        NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::integer,NULL::uuid,NULL::text
        FROM orchestration_event e JOIN orchestration_dispatch d ON d.project_id=e.project_id AND d.dispatch_id=e.entity_id
        JOIN orchestration_loop l ON l.project_id=e.project_id AND l.loop_id=e.loop_id
        WHERE e.project_id=$1 AND e.loop_id=$2 AND e.kind='worker.outcome'
          AND e.detail->>'outcome' IN ('delivered','failed','waiting','no_action')
          AND d.data->>'recipientRoleId'<>l.data->>'cognitiveRoleId'
      UNION ALL
      SELECT e.event_id,e.created_at,e.kind,e.entity_id,e.version,NULL::uuid,NULL::uuid,
        e.operation_id,j.actor_id,o.observation_id,o.delivery_id,o.result,NULL::uuid,NULL::integer,NULL::uuid,NULL::text
        FROM outbox_event e
        JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
          AND j.command_type='observation.record' AND j.result->>'status'='applied'
        JOIN consumer_observation o ON o.project_id=e.project_id AND o.observation_id::text=j.result->>'revisionId'
          AND o.task_id=e.entity_id AND o.actor_id=j.actor_id
        JOIN delivery d ON d.project_id=o.project_id AND d.delivery_id=o.delivery_id AND d.task_id=o.task_id
          AND d.actor_id<>o.actor_id
        JOIN task_revision dr ON dr.project_id=d.project_id AND dr.task_id=d.task_id AND dr.revision_id=d.task_revision_id
        JOIN LATERAL (SELECT p.stage_id FROM task_proposal p
          JOIN task_revision pr ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id
          WHERE p.project_id=d.project_id AND p.task_id=d.task_id AND pr.version<=dr.version
          ORDER BY pr.version DESC LIMIT 1) p ON p.stage_id IS NOT NULL
        JOIN project_stage s ON s.project_id=d.project_id AND s.stage_id=p.stage_id
        WHERE e.project_id=$1 AND e.kind='observation.record'
          AND (e.created_at>$4::timestamptz OR (e.created_at=$4::timestamptz AND ($5::uuid IS NULL OR e.event_id>$5::uuid)))
          AND s.goal_id=$9::uuid AND ($10::uuid IS NULL OR s.stage_id=$10::uuid)
      UNION ALL
      SELECT e.event_id,e.created_at_utc,e.kind,d.task_id,(op.result->>'version')::integer,e.loop_id,d.dispatch_id,
        NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::text,
        COALESCE((e.detail->>'runId')::uuid,(d.data->>'runtimeRunId')::uuid),
        COALESCE((e.detail->>'taskVersion')::integer,d.task_version),NULL::uuid,NULL::text
        FROM orchestration_event e
        JOIN orchestration_dispatch d ON d.project_id=e.project_id AND d.dispatch_id=e.entity_id
        JOIN orchestration_operation op ON op.project_id=e.project_id AND op.operation_id=e.operation_id
        JOIN runtime_run r ON r.project_id=d.project_id AND r.run_id=(d.data->>'runtimeRunId')::uuid
        JOIN task_revision tr ON tr.project_id=d.project_id AND tr.task_id=d.task_id AND tr.version=d.task_version
        JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision pr
          ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id
          WHERE p.project_id=d.project_id AND p.task_id=d.task_id AND pr.version<=tr.version
          ORDER BY pr.version DESC LIMIT 1) fixed_scope ON fixed_scope.stage_id IS NOT NULL
        JOIN project_stage fixed_stage ON fixed_stage.project_id=d.project_id AND fixed_stage.stage_id=fixed_scope.stage_id
        WHERE e.project_id=$1 AND e.loop_id=$2 AND e.kind='dispatch.gap'
          AND fixed_stage.goal_id=$9::uuid AND ($10::uuid IS NULL OR fixed_stage.stage_id=$10::uuid)
          AND d.state='accepted' AND d.data->>'outcome' IS NULL
          AND r.state IN ('completed','failed','interrupted')
          AND COALESCE((e.detail->>'runId')::uuid,r.run_id)=r.run_id
          AND NOT EXISTS (SELECT 1 FROM orchestration_submission s WHERE s.project_id=d.project_id AND s.dispatch_id=d.dispatch_id)
          AND NOT EXISTS (SELECT 1 FROM orchestration_decision w WHERE w.project_id=d.project_id AND w.dispatch_id=d.dispatch_id)
          AND NOT EXISTS (SELECT 1 FROM orchestration_event source_gap WHERE source_gap.project_id=d.project_id
            AND source_gap.loop_id=d.loop_id AND source_gap.event_id::text=d.data->>'sourceEventId'
            AND source_gap.kind='dispatch.gap')
          AND NOT EXISTS (SELECT 1 FROM orchestration_event earlier WHERE earlier.project_id=e.project_id
            AND earlier.loop_id=e.loop_id AND earlier.entity_id=e.entity_id AND earlier.kind='dispatch.gap'
            AND (earlier.created_at_utc,earlier.event_id)<(e.created_at_utc,e.event_id))
      UNION ALL
      SELECT e.event_id,e.created_at,e.kind,e.entity_id,e.version,NULL::uuid,NULL::uuid,
        e.operation_id,j.actor_id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::integer,
        r.revision_id,r.content_hash
        FROM outbox_event e
        JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
          AND j.command_type='document.create' AND j.result->>'status'='applied'
          AND j.result->>'entityId'=e.entity_id::text AND j.result->>'version'='1'
        JOIN process_document d ON d.project_id=e.project_id AND d.document_id=e.entity_id
          AND d.kind='issue' AND d.origin_task_id IS NOT NULL
        JOIN document_revision r ON r.project_id=d.project_id AND r.document_id=d.document_id
          AND r.revision_id::text=j.result->>'revisionId' AND r.previous_revision_id IS NULL AND r.author=j.actor_id
        JOIN task_revision tr ON tr.project_id=d.project_id AND tr.task_id=d.origin_task_id
          AND tr.revision_id=d.origin_task_revision_id
        JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision pr
          ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id
          WHERE p.project_id=tr.project_id AND p.task_id=tr.task_id AND pr.version<=tr.version
          ORDER BY pr.version DESC LIMIT 1) fixed_scope ON fixed_scope.stage_id IS NOT NULL
        JOIN project_stage fixed_stage ON fixed_stage.project_id=tr.project_id AND fixed_stage.stage_id=fixed_scope.stage_id
        LEFT JOIN runtime_run run ON run.project_id=d.project_id AND run.run_id=d.origin_run_id
        WHERE e.project_id=$1 AND e.kind='document' AND e.version=1
          AND (e.created_at>$4::timestamptz OR (e.created_at=$4::timestamptz AND ($5::uuid IS NULL OR e.event_id>$5::uuid)))
          AND fixed_stage.goal_id=$9::uuid AND ($10::uuid IS NULL OR fixed_stage.stage_id=$10::uuid)
          AND (d.origin_run_id IS NULL OR (run.task_id=d.origin_task_id AND
            run.task_revision_id=d.origin_task_revision_id AND run.state<>'unknown'))
    ) SELECT * FROM sources WHERE ($6::timestamptz IS NULL OR (created_at_utc,id)>($6::timestamptz,$7::uuid))
      ORDER BY created_at_utc,id LIMIT $8`,[this.projectId,loopId,loop.bootstrapEventId,
        loop.sourceAfter.createdAtUtc,loop.sourceAfter.eventId,cursorTime??null,cursorId??null,limit+1,loop.goalId,loop.stageId]);
    const items=r.rows.map(x=>({projectId:this.projectId,id:x.id,createdAtUtc:iso(x.created_at_utc),
      kind:x.kind,subjectId:x.subject_id,subjectVersion:x.subject_version,
      sourceLoopId:x.source_loop_id??null,originDispatchId:x.origin_dispatch_id??null,
      operationId:x.operation_id??null,sourceActorId:x.source_actor_id??null,observationId:x.observation_id??null,
      deliveryId:x.delivery_id??null,observationResult:x.observation_result??null,
      gapRunId:x.gap_run_id??null,gapTaskVersion:x.gap_task_version??null,
      issueRevisionId:x.issue_revision_id??null,issueContentHash:x.issue_content_hash??null} as OrchestrationSourceFact));
    const scheduled = await scheduledSourceFacts(this.db, this.projectId, { loopId,
      afterUtc: loop.sourceAfter.createdAtUtc, afterId: loop.sourceAfter.eventId,
      cursorUtc: cursorTime, cursorId, limit: limit + 1 });
    items.push(...scheduled);
    let scanTime=cursorTime??loop.sourceAfter.createdAtUtc;
    let scanId=cursorId??loop.sourceAfter.eventId;
    let verifiedWaiting=0;
    while(verifiedWaiting<=limit){
      const waiting=await this.db.query(`SELECT event_id,created_at_utc::text AS cursor_time FROM orchestration_event
        WHERE project_id=$1 AND loop_id=$2 AND kind='waiting.resumed'
          AND (created_at_utc>$3::timestamptz OR (created_at_utc=$3::timestamptz AND ($4::uuid IS NULL OR event_id>$4::uuid)))
          AND (created_at_utc>$5::timestamptz OR (created_at_utc=$5::timestamptz AND ($6::uuid IS NULL OR event_id>$6::uuid)))
        ORDER BY created_at_utc,event_id LIMIT 100`,[this.projectId,loopId,loop.sourceAfter.createdAtUtc,loop.sourceAfter.eventId,scanTime,scanId]);
      if(!waiting.rows.length)break;
      for(const row of waiting.rows){
        scanTime=row.cursor_time;scanId=row.event_id;
        const source=await this.getSourceFact(row.event_id);
        if(source){items.push(source);verifiedWaiting++;if(verifiedWaiting>limit)break;}
      }
      if(verifiedWaiting>limit || waiting.rows.length<100)break;
    }
    items.sort((a,b)=>a.createdAtUtc.localeCompare(b.createdAtUtc)||a.id.localeCompare(b.id));
    return {items:items.slice(0,limit),nextCursor:items.length>limit?`${items[limit-1]!.createdAtUtc}|${items[limit-1]!.id}`:null};
  }
  getSourceFact(id:string):Promise<OrchestrationSourceFact|null>{return this.getSourceFactInternal(id,new Set());}
  private async getSourceFactInternal(id:string,seen:Set<string>):Promise<OrchestrationSourceFact|null>{
    if(seen.has(id) || seen.size>=32)return null;
    const nextSeen=new Set(seen);nextSeen.add(id);
    const waiting=await this.db.query("SELECT 1 FROM orchestration_event WHERE project_id=$1 AND event_id=$2 AND kind='waiting.resumed'",[this.projectId,id]);
    if(waiting.rowCount)return this.waitingResumeFact(id,nextSeen);
    const r=await this.db.query(`SELECT e.event_id,e.created_at AS created_at_utc,e.kind,e.entity_id AS subject_id,e.version AS subject_version,
      NULL::uuid AS source_loop_id,NULL::uuid AS origin_dispatch_id,e.operation_id,
      CASE WHEN j.result->>'status'='applied' AND
        (e.kind='observation.record' AND j.command_type='observation.record' OR
         e.kind='document' AND j.command_type='document.create' AND issue.document_id IS NOT NULL)
        THEN j.actor_id END AS source_actor_id,
      o.observation_id,o.delivery_id,o.result AS observation_result,NULL::uuid AS gap_run_id,NULL::integer AS gap_task_version,
      issue_revision.revision_id AS issue_revision_id,issue_revision.content_hash AS issue_content_hash
      FROM outbox_event e
      LEFT JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
        AND e.kind IN ('observation.record','document')
      LEFT JOIN consumer_observation o ON o.project_id=e.project_id AND o.observation_id::text=j.result->>'revisionId'
        AND o.task_id=e.entity_id AND o.actor_id=j.actor_id AND j.command_type='observation.record' AND j.result->>'status'='applied'
      LEFT JOIN process_document issue ON issue.project_id=e.project_id AND issue.document_id=e.entity_id
        AND issue.kind='issue' AND issue.origin_task_id IS NOT NULL AND e.version=1
        AND j.command_type='document.create' AND j.result->>'status'='applied'
        AND j.result->>'entityId'=e.entity_id::text AND j.result->>'version'='1'
      LEFT JOIN document_revision issue_revision ON issue_revision.project_id=issue.project_id
        AND issue_revision.document_id=issue.document_id AND issue_revision.revision_id::text=j.result->>'revisionId'
        AND issue_revision.previous_revision_id IS NULL AND issue_revision.author=j.actor_id
      WHERE e.project_id=$1 AND e.event_id=$2 AND e.kind <> 'schedule.task.todo'
    UNION ALL SELECT e.event_id,e.created_at_utc,e.kind,e.entity_id,1,e.loop_id,NULL::uuid,
      NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::integer,NULL::uuid,NULL::text
      FROM orchestration_event e JOIN orchestration_loop l ON l.project_id=e.project_id AND l.loop_id=e.loop_id
      WHERE e.project_id=$1 AND e.event_id=$2 AND e.event_id=(l.data->>'bootstrapEventId')::uuid AND e.kind='loop.enrolled'
    UNION ALL SELECT e.event_id,e.created_at_utc,e.kind,d.task_id,d.version,e.loop_id,d.dispatch_id,
      NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::integer,NULL::uuid,NULL::text
      FROM orchestration_event e JOIN orchestration_dispatch d ON d.project_id=e.project_id AND d.dispatch_id=e.entity_id
      JOIN orchestration_loop l ON l.project_id=e.project_id AND l.loop_id=e.loop_id
      WHERE e.project_id=$1 AND e.event_id=$2 AND e.kind='worker.outcome'
        AND e.detail->>'outcome' IN ('delivered','failed','waiting','no_action')
        AND d.data->>'recipientRoleId'<>l.data->>'cognitiveRoleId'
    UNION ALL SELECT e.event_id,e.created_at_utc,e.kind,d.task_id,(op.result->>'version')::integer,e.loop_id,d.dispatch_id,
      NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::text,
      COALESCE((e.detail->>'runId')::uuid,(d.data->>'runtimeRunId')::uuid),
      COALESCE((e.detail->>'taskVersion')::integer,d.task_version),NULL::uuid,NULL::text
      FROM orchestration_event e
      JOIN orchestration_dispatch d ON d.project_id=e.project_id AND d.dispatch_id=e.entity_id
      JOIN orchestration_operation op ON op.project_id=e.project_id AND op.operation_id=e.operation_id
      JOIN runtime_run r ON r.project_id=d.project_id AND r.run_id=(d.data->>'runtimeRunId')::uuid
      WHERE e.project_id=$1 AND e.event_id=$2 AND e.kind='dispatch.gap'
        AND d.state='accepted' AND d.data->>'outcome' IS NULL AND r.state IN ('completed','failed','interrupted')
        AND COALESCE((e.detail->>'runId')::uuid,r.run_id)=r.run_id
        AND NOT EXISTS (SELECT 1 FROM orchestration_submission s WHERE s.project_id=d.project_id AND s.dispatch_id=d.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_decision w WHERE w.project_id=d.project_id AND w.dispatch_id=d.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_event earlier WHERE earlier.project_id=e.project_id
          AND earlier.loop_id=e.loop_id AND earlier.entity_id=e.entity_id AND earlier.kind='dispatch.gap'
        AND (earlier.created_at_utc,earlier.event_id)<(e.created_at_utc,e.event_id))`,[this.projectId,id]);const x=r.rows[0];
    if (!x) return (await scheduledSourceFacts(this.db,this.projectId,{eventId:id}))[0] ?? null;
    return x?{projectId:this.projectId,id:x.event_id,createdAtUtc:iso(x.created_at_utc),kind:x.kind,subjectId:x.subject_id,subjectVersion:x.subject_version,sourceLoopId:x.source_loop_id??null,originDispatchId:x.origin_dispatch_id??null,operationId:x.operation_id??null,sourceActorId:x.source_actor_id??null,observationId:x.observation_id??null,deliveryId:x.delivery_id??null,observationResult:x.observation_result??null,gapRunId:x.gap_run_id??null,gapTaskVersion:x.gap_task_version??null,issueRevisionId:x.issue_revision_id??null,issueContentHash:x.issue_content_hash??null}:null;}

}
class Tx extends Reader implements OrchestrationTransaction {
  constructor(db:PoolClient,projectId:string,private readonly authorization:Authorization){super(db,projectId);}
  async insertOperation(x:OrchestrationOperation){await this.db.query("INSERT INTO orchestration_operation VALUES($1,$2,$3,$4,$5::jsonb,$6)",[this.projectId,x.id,x.actorId,x.commandHash,JSON.stringify(x.result),x.createdAtUtc]);}
  async insertLoop(x:OrchestrationLoop){await this.db.query("INSERT INTO orchestration_loop VALUES($1,$2,$3,$4,$5::jsonb)",[this.projectId,x.id,x.version,x.state,JSON.stringify(x)]);}
  async updateLoop(x:OrchestrationLoop,expectedVersion:number){await this.cas("orchestration_loop","loop_id",x.id,expectedVersion,x.version,x.state,x);}
  async findInbox(loopId:string,sourceEventId:string,recipientRoleId:string,purpose:string){const r=await this.db.query("SELECT data FROM orchestration_inbox WHERE project_id=$1 AND loop_id=$2 AND source_event_id=$3 AND recipient_role_id=$4 AND purpose=$5",[this.projectId,loopId,sourceEventId,recipientRoleId,purpose]);return data<OrchestrationInbox>(r.rows[0]);}
  async insertInbox(x:OrchestrationInbox){await this.db.query("INSERT INTO orchestration_inbox VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",[this.projectId,x.id,x.loopId,x.sourceEventId,x.recipientRoleId,x.purpose,x.version,x.state,JSON.stringify(x)]);}
  async updateInbox(x:OrchestrationInbox,expectedVersion:number){await this.cas("orchestration_inbox","inbox_id",x.id,expectedVersion,x.version,x.state,x);}
  async insertDispatch(x:OrchestrationDispatch){await this.db.query("INSERT INTO orchestration_dispatch VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",[this.projectId,x.id,x.loopId,x.inboxId,x.taskId,x.taskVersion,x.version,x.state,JSON.stringify(x)]);}
  async updateDispatch(x:OrchestrationDispatch,expectedVersion:number){await this.cas("orchestration_dispatch","dispatch_id",x.id,expectedVersion,x.version,x.state,x);}
  async insertSubmission(x:OrchestrationSubmission){const dispatch=await this.getDispatch(x.dispatchId);if(!dispatch)throw new Error("dispatch unavailable");await this.db.query("INSERT INTO orchestration_submission VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[this.projectId,x.id,x.dispatchId,dispatch.loopId,x.version,x.state,JSON.stringify(x)]);}
  async insertDecision(x:OrchestrationWorkerDecision){await this.db.query("INSERT INTO orchestration_decision VALUES($1,$2,$3,$4::jsonb)",[this.projectId,x.id,x.dispatchId,JSON.stringify(x)]);}
  async updateSubmission(x:OrchestrationSubmission,expectedVersion:number){await this.cas("orchestration_submission","submission_id",x.id,expectedVersion,x.version,x.state,x);}
  private async cas(table:string,key:string,id:string,expected:number,next:number,state:string,x:unknown){const r=await this.db.query(`UPDATE ${table} SET version=$4,state=$5,data=$6::jsonb WHERE project_id=$1 AND ${key}=$2 AND version=$3`,[this.projectId,id,expected,next,state,JSON.stringify(x)]);if(r.rowCount!==1)throw new Error("ORCHESTRATION_VERSION_CONFLICT");}
  async countCapacityUsed(loopId:string){const r=await this.db.query(`SELECT count(*)::int AS n FROM orchestration_dispatch d
    LEFT JOIN runtime_run r ON r.project_id=d.project_id AND r.run_id=(d.data->>'runtimeRunId')::uuid
    WHERE d.project_id=$1 AND d.loop_id=$2 AND (d.state IN ('claimed','dispatching','unknown')
      OR (d.state='accepted' AND (r.run_id IS NULL OR r.state IN ('requested','dispatching','running','unknown'))))`,
    [this.projectId,loopId]);return r.rows[0].n as number;}
  async appendEvent(x:OrchestrationEvent){await this.db.query("INSERT INTO orchestration_event VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",[this.projectId,x.id,x.loopId,x.entityType,x.entityId,x.operationId,x.kind,x.actorId,JSON.stringify(x.detail),x.createdAtUtc]);}
  async getTaskFact(id:string):Promise<OrchestrationTaskFact|null>{const r=await this.db.query(`SELECT t.*,p.stage_id,s.goal_id FROM task t LEFT JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id WHERE p.project_id=t.project_id AND p.task_id=t.task_id ORDER BY r.version DESC LIMIT 1) p ON true LEFT JOIN project_stage s ON s.project_id=t.project_id AND s.stage_id=p.stage_id WHERE t.project_id=$1 AND t.task_id=$2`,[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.task_id,version:x.version,state:x.state,ownerRoleId:x.owner,goalId:x.goal_id??null,stageId:x.stage_id??null}:null;}
  async getTaskScopeAtVersion(taskId:string,taskVersion:number){const r=await this.db.query(`SELECT tr.version,p.stage_id,s.goal_id FROM task_revision tr
    LEFT JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal
      JOIN task_revision pr ON pr.project_id=proposal.project_id AND pr.task_id=proposal.task_id AND pr.revision_id=proposal.task_revision_id
      WHERE proposal.project_id=tr.project_id AND proposal.task_id=tr.task_id AND pr.version<=tr.version
      ORDER BY pr.version DESC LIMIT 1) p ON true
    LEFT JOIN project_stage s ON s.project_id=tr.project_id AND s.stage_id=p.stage_id
    WHERE tr.project_id=$1 AND tr.task_id=$2 AND tr.version=$3`,[this.projectId,taskId,taskVersion]);
    const x=r.rows[0];return x?{projectId:this.projectId,taskId,taskVersion:x.version,stageId:x.stage_id??null,goalId:x.goal_id??null}:null;}
  async getGoalFact(id:string){const r=await this.db.query("SELECT goal_id FROM project_goal WHERE project_id=$1 AND goal_id=$2",[this.projectId,id]);return r.rows[0]?{projectId:this.projectId,id,state:"active"}:null;}
  async getStageFact(id:string){const r=await this.db.query("SELECT stage_id,goal_id,state FROM project_stage WHERE project_id=$1 AND stage_id=$2 FOR SHARE",[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.stage_id,goalId:x.goal_id,state:x.state}:null;}
  getAuthorizationFact(scopeId:string){return this.authorization.getAuthorizationFact(this.projectId,scopeId);}
  canActAsRole(actorId:string,roleId:string){return this.authorization.canActAsRole(this.projectId,actorId,roleId);}
  wasActorRole(actorId:string,loopId:string,roleId:string){return this.authorization.wasActorRole(this.projectId,actorId,loopId,roleId);}
  async getRunFact(id:string){const r=await this.db.query("SELECT run_id,task_id,task_revision_id,input_hash,state FROM runtime_run WHERE project_id=$1 AND run_id=$2",[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.run_id,taskId:x.task_id,taskRevisionId:x.task_revision_id,inputHash:x.input_hash,state:x.state}:null;}
  async getDeliveryFact(id:string){const r=await this.db.query("SELECT delivery_id,task_id,task_revision_id,run_id,actor_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence FROM delivery WHERE project_id=$1 AND delivery_id=$2",[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.delivery_id,taskId:x.task_id,taskRevisionId:x.task_revision_id,runId:x.run_id,actorId:x.actor_id,artifactRef:x.artifact_ref,artifactRevision:x.artifact_revision,contentHash:x.content_hash,technicalResult:x.technical_result,technicalEvidence:x.technical_evidence}:null;}
  async getObservationFact(id:string){const r=await this.db.query(`SELECT o.observation_id,o.task_id,o.delivery_id,o.actor_id,o.result,d.task_revision_id,p.stage_id
    FROM consumer_observation o JOIN delivery d ON d.project_id=o.project_id AND d.delivery_id=o.delivery_id AND d.task_id=o.task_id
    JOIN task_revision dr ON dr.project_id=d.project_id AND dr.task_id=d.task_id AND dr.revision_id=d.task_revision_id
    LEFT JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal
      JOIN task_revision pr ON pr.project_id=proposal.project_id AND pr.task_id=proposal.task_id AND pr.revision_id=proposal.task_revision_id
      WHERE proposal.project_id=d.project_id AND proposal.task_id=d.task_id AND pr.version<=dr.version
      ORDER BY pr.version DESC LIMIT 1) p ON true
    WHERE o.project_id=$1 AND o.observation_id=$2`,[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.observation_id,taskId:x.task_id,deliveryId:x.delivery_id,actorId:x.actor_id,result:x.result,taskRevisionId:x.task_revision_id,stageId:x.stage_id??null}:null;}
  async getWorkflowOperationFact(id:string){const r=await this.db.query("SELECT operation_id,actor_id,command_type,command_hash,result FROM operation_journal WHERE project_id=$1 AND operation_id=$2",[this.projectId,id]);const x=r.rows[0];return x?{projectId:this.projectId,id:x.operation_id,actorId:x.actor_id,commandType:x.command_type,commandHash:x.command_hash,status:x.result.status,resultRefId:x.result.revisionId??x.result.entityId??null,resultVersion:x.result.version??null}:null;}
  async getIssueFact(documentId:string,revisionId:string){const r=await this.db.query(`SELECT d.document_id,d.origin_task_id,d.origin_task_revision_id,d.origin_run_id,
      r.revision_id,r.content_hash,r.author,tr.version AS origin_task_version
    FROM process_document d JOIN document_revision r ON r.project_id=d.project_id AND r.document_id=d.document_id
      AND r.revision_id=$3 AND r.previous_revision_id IS NULL
    JOIN task_revision tr ON tr.project_id=d.project_id AND tr.task_id=d.origin_task_id
      AND tr.revision_id=d.origin_task_revision_id
    WHERE d.project_id=$1 AND d.document_id=$2 AND d.kind='issue' AND d.origin_task_id IS NOT NULL`,
    [this.projectId,documentId,revisionId]);const x=r.rows[0];return x?{projectId:this.projectId,documentId:x.document_id,
      revisionId:x.revision_id,contentHash:x.content_hash,author:x.author,kind:"issue" as const,
      originTaskId:x.origin_task_id,originTaskRevisionId:x.origin_task_revision_id,
      originTaskVersion:x.origin_task_version,originRunId:x.origin_run_id??null}:null;}
}
/** Live grants are injected by the coordinator; this store never turns persisted role names into authority. */
export class PgOrchestrationStore implements OrchestrationStore {
  constructor(private readonly pool:Pool,private readonly authorization:Authorization){}
  async transaction<T>(projectId:string,action:(tx:OrchestrationTransaction)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query("BEGIN");const locked=await client.query("SELECT project_id FROM project WHERE project_id=$1 FOR UPDATE",[projectId]);if(!locked.rowCount)throw new Error("PROJECT_NOT_FOUND");const result=await action(new Tx(client,projectId,this.authorization));await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  async read<T>(projectId:string,action:(reader:OrchestrationReader)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query("BEGIN TRANSACTION READ ONLY");const result=await action(new Reader(client,projectId));await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
}
