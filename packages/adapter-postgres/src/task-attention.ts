import type { Pool, PoolClient } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import { readLeaderWorkTask } from "./work-index.js";
import type { TaskAttentionCommand, TaskAttentionFollowUp, TaskAttentionItem,
  TaskAttentionThreshold, TaskAttentionAssessment, TaskAttentionTimedTask } from "@evoloop/contracts";
import { taskAttentionSource } from "@evoloop/contracts";
import { assessTaskAttention, trialAttentionThreshold } from "@evoloop/core";

type Db = Pick<Pool | PoolClient, "query">;
type Row = Record<string, unknown>;
const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const maybeIso = (v: unknown): string | null => v == null ? null : iso(v);
const threshold = (r: Row): TaskAttentionThreshold => ({stageId: r.stage_id as string | null,
  phase: r.phase as TaskAttentionThreshold["phase"], version: Number(r.version),
  stageOverdueMs: r.stage_overdue_ms == null ? null : Number(r.stage_overdue_ms),
  activityWithoutProgressMs: r.activity_without_progress_ms == null ? null : Number(r.activity_without_progress_ms),
  observationGapMs: r.observation_gap_ms == null ? null : Number(r.observation_gap_ms),
  actorId: String(r.actor_id), reason: String(r.reason), updatedAt: iso(r.updated_at)});
const followUp = (r: Row): TaskAttentionFollowUp => ({taskId: String(r.task_id),
  taskRevisionId: String(r.task_revision_id), version: Number(r.version),
  waitingOn: r.waiting_on as TaskAttentionFollowUp["waitingOn"], nextCheckAt: maybeIso(r.next_check_at),
  decision: r.decision as TaskAttentionFollowUp["decision"], actionTaken: String(r.action_taken),
  evidenceRef: r.evidence_ref as string | null,
  releaseHandoff: r.release_handoff as TaskAttentionFollowUp["releaseHandoff"],
  publication: r.publication as TaskAttentionFollowUp["publication"],
  actorId: String(r.actor_id), reason: String(r.reason), updatedAt: iso(r.updated_at)});
export const attentionItem = (r: Row): TaskAttentionItem => ({id: String(r.item_id), taskId: String(r.task_id),
  taskRevisionId: String(r.task_revision_id), stageId: r.stage_id as string | null,
  phase: r.phase as TaskAttentionItem["phase"], signal: r.signal as TaskAttentionItem["signal"],
  waitingOn: r.waiting_on as TaskAttentionItem["waitingOn"],
  reason: String(r.reason),
  state: r.state as TaskAttentionItem["state"], severity: r.severity as TaskAttentionItem["severity"],
  version: Number(r.version), firstDetectedAt: iso(r.first_detected_at), lastDetectedAt: iso(r.last_detected_at),
  sourceObservedAt: iso(r.source_observed_at), evidence: r.evidence as Record<string, unknown>,
  noticeId: r.notice_id as string | null, resolvedAt: maybeIso(r.resolved_at),
  resolutionReason: r.resolution_reason as string | null});

export class PgTaskAttention {
  constructor(private readonly db: Db, private readonly projectId: string) {}
  async thresholds(stageId?: string, phase?: string): Promise<TaskAttentionThreshold[]> {
    const r = await this.db.query(`SELECT * FROM task_attention_threshold WHERE project_id=$1
      AND ($2::uuid IS NULL OR stage_id=$2) AND ($3::text IS NULL OR phase=$3)
      ORDER BY phase,stage_id NULLS FIRST LIMIT 200`, [this.projectId,stageId??null,phase??null]);
    return r.rows.map(threshold);
  }
  async effectiveThreshold(stageId: string | null, phase: string): Promise<TaskAttentionThreshold | null> {
    const r = await this.db.query(`SELECT * FROM task_attention_threshold WHERE project_id=$1 AND phase=$2
      AND (stage_id=$3::uuid OR stage_id IS NULL)
      ORDER BY stage_id NULLS LAST LIMIT 1`, [this.projectId,phase,stageId]);
    return r.rows[0] ? threshold(r.rows[0]) : null;
  }
  async getFollowUp(taskId: string): Promise<TaskAttentionFollowUp | null> {
    const r=await this.db.query(`SELECT * FROM task_attention_follow_up WHERE project_id=$1 AND task_id=$2`,
      [this.projectId,taskId]);
    return r.rows[0] ? followUp(r.rows[0]) : null;
  }
  async followUpHistory(taskId: string): Promise<TaskAttentionFollowUp[]> {
    const r=await this.db.query(`SELECT * FROM task_attention_follow_up_revision
      WHERE project_id=$1 AND task_id=$2 ORDER BY version DESC LIMIT 100`,[this.projectId,taskId]);
    return r.rows.map(row => followUp({...row,updated_at:row.created_at}));
  }
  async getItem(itemId: string): Promise<TaskAttentionItem | null> {
    const r=await this.db.query(`SELECT * FROM task_attention_item WHERE project_id=$1 AND item_id=$2`,
      [this.projectId,itemId]);
    return r.rows[0] ? attentionItem(r.rows[0]) : null;
  }
  async itemEvents(itemId: string): Promise<Row[]> {
    const r=await this.db.query(`SELECT event_id AS "eventId",item_version AS "itemVersion",kind,severity,
      evidence,actor_id AS "actorId",reason,created_at AS "createdAt"
      FROM task_attention_item_event WHERE project_id=$1 AND item_id=$2
      ORDER BY item_version DESC LIMIT 100`,[this.projectId,itemId]);
    return r.rows.map(x=>({...x,createdAt:iso(x.createdAt)}));
  }
  async items(query: {taskId?: string|undefined; state?: "open"|"resolved"|undefined;
    phase?:string|undefined;signal?:string|undefined;waitingOnKind?:string|undefined;
    waitingOnId?:string|undefined;limit: number;cursor?: string|undefined}):
    Promise<{items:TaskAttentionItem[];nextCursor:string|null}> {
    const limit=query.limit;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError("INVALID_PAGE","Attention limit must be 1..100");
    let after: {projectId:string;taskId:string|null;state:string|null;phase:string|null;signal:string|null;
      waitingOnKind:string|null;waitingOnId:string|null;at:string;id:string}|null=null;
    if(query.cursor)try {
      after=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8"));
      if(after?.projectId!==this.projectId||after?.taskId!==(query.taskId??null)||
        after?.state!==(query.state??null)||after?.phase!==(query.phase??null)||
        after?.signal!==(query.signal??null)||after?.waitingOnKind!==(query.waitingOnKind??null)||
        after?.waitingOnId!==(query.waitingOnId??null)||!after?.at||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after?.id??"")||
        !Number.isFinite(Date.parse(after.at)))
        throw new Error("scope");
    }catch {throw new DomainError("INVALID_CURSOR","Attention cursor does not match this query");}
    const r=await this.db.query(`SELECT * FROM task_attention_item WHERE project_id=$1
      AND ($2::uuid IS NULL OR task_id=$2) AND ($3::text IS NULL OR state=$3)
      AND ($4::timestamptz IS NULL OR (first_detected_at,item_id)<($4::timestamptz,$5::uuid))
      AND ($6::text IS NULL OR phase=$6) AND ($7::text IS NULL OR signal=$7)
      AND ($8::text IS NULL OR waiting_on->>'kind'=$8)
      AND ($9::text IS NULL OR waiting_on->>'id'=$9)
      ORDER BY first_detected_at DESC,item_id DESC LIMIT $10`,
      [this.projectId,query.taskId??null,query.state??null,after?.at??null,after?.id??null,
        query.phase??null,query.signal??null,query.waitingOnKind??null,query.waitingOnId??null,limit+1]);
    const items=r.rows.slice(0,limit).map(attentionItem), last=items.at(-1);
    return {items,nextCursor:r.rows.length>limit&&last?Buffer.from(JSON.stringify({projectId:this.projectId,
      taskId:query.taskId??null,state:query.state??null,phase:query.phase??null,signal:query.signal??null,
      waitingOnKind:query.waitingOnKind??null,waitingOnId:query.waitingOnId??null,
      at:last.firstDetectedAt,id:last.id})).toString("base64url"):null};
  }
  private async taskHead(taskId: string, expectedVersion: number, expectedRevisionId: string) {
    const r=await this.db.query(`SELECT version,current_revision_id FROM task
      WHERE project_id=$1 AND task_id=$2 FOR UPDATE`,[this.projectId,taskId]);
    if(!r.rows[0])throw new DomainError("TASK_NOT_FOUND","Task is unavailable in this project");
    if(r.rows[0].version!==expectedVersion||r.rows[0].current_revision_id!==expectedRevisionId)
      throw new DomainError("VERSION_CONFLICT","Task version or revision changed",r.rows[0].version);
  }
  async setThreshold(command: Extract<TaskAttentionCommand,{type:"task.attention.thresholds.set"}>,
    actorId:string,now:string):Promise<{entityId:string;version:number}> {
    if(command.stageId){
      const stage=await this.db.query(`SELECT 1 FROM project_stage WHERE project_id=$1 AND stage_id=$2`,
        [this.projectId,command.stageId]);
      if(!stage.rows[0])throw new DomainError("STAGE_NOT_FOUND","Stage is unavailable in this project");
    }
    const prior=await this.db.query(`SELECT version FROM task_attention_threshold
      WHERE project_id=$1 AND stage_id IS NOT DISTINCT FROM $2::uuid AND phase=$3 FOR UPDATE`,
      [this.projectId,command.stageId,command.phase]);
    const version=Number(prior.rows[0]?.version??0);
    if(version!==command.expectedVersion)throw new DomainError("VERSION_CONFLICT","Threshold changed",version);
    const next=version+1, values=[this.projectId,command.stageId,command.phase,next,
      command.stageOverdueMs,command.activityWithoutProgressMs,command.observationGapMs,actorId,command.reason,now];
    if(version===0)await this.db.query(`INSERT INTO task_attention_threshold(project_id,stage_id,phase,version,
      stage_overdue_ms,activity_without_progress_ms,observation_gap_ms,actor_id,reason,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,values);
    else await this.db.query(`UPDATE task_attention_threshold SET version=$4,stage_overdue_ms=$5,
      activity_without_progress_ms=$6,observation_gap_ms=$7,actor_id=$8,reason=$9,updated_at=$10
      WHERE project_id=$1 AND stage_id IS NOT DISTINCT FROM $2::uuid AND phase=$3`,values);
    await this.db.query(`INSERT INTO task_attention_threshold_revision(project_id,stage_id,phase,version,
      stage_overdue_ms,activity_without_progress_ms,observation_gap_ms,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,values);
    return {entityId:command.stageId??command.projectId,version:next};
  }
  async setFollowUp(command: Extract<TaskAttentionCommand,{type:"task.attention.followUp.set"}>,
    actorId:string,now:string):Promise<{entityId:string;version:number}> {
    await this.taskHead(command.taskId,command.expectedTaskVersion,command.expectedTaskRevisionId);
    const prior=await this.db.query(`SELECT version,task_revision_id,release_handoff,publication FROM task_attention_follow_up
      WHERE project_id=$1 AND task_id=$2 FOR UPDATE`,[this.projectId,command.taskId]);
    const version=Number(prior.rows[0]?.version??0);
    if(version!==command.expectedVersion)throw new DomainError("VERSION_CONFLICT","Follow-up changed",version);
    const priorHead=prior.rows[0],sameRevision=priorHead?.task_revision_id===command.expectedTaskRevisionId;
    const priorHandoff=priorHead?.release_handoff as typeof command.releaseHandoff;
    const sameHandoff=!!priorHandoff&&!!command.releaseHandoff&&
      priorHandoff.recipient===command.releaseHandoff.recipient&&
      priorHandoff.artifactRef===command.releaseHandoff.artifactRef&&
      priorHandoff.note===command.releaseHandoff.note&&
      priorHandoff.readyForPublicationAt===command.releaseHandoff.readyForPublicationAt;
    if(sameRevision&&priorHead?.publication&&!sameHandoff)
      throw new DomainError("PUBLICATION_HISTORY_CONFLICT","Recorded publication handoff is immutable on this Task revision");
    if(command.releaseHandoff&&Date.parse(command.releaseHandoff.readyForPublicationAt)>Date.parse(now))
      throw new DomainError("HANDOFF_TIME_INVALID","Publication readiness cannot be recorded in the future");
    const next=version+1, values=[this.projectId,command.taskId,command.expectedTaskRevisionId,next,
      command.waitingOn,command.decision,command.actionTaken,command.evidenceRef,command.nextCheckAt,
      command.releaseHandoff,sameRevision?priorHead?.publication??null:null,actorId,command.reason,now];
    if(version===0)await this.db.query(`INSERT INTO task_attention_follow_up(project_id,task_id,task_revision_id,
      version,waiting_on,decision,action_taken,evidence_ref,next_check_at,release_handoff,
      publication,actor_id,reason,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,values);
    else await this.db.query(`UPDATE task_attention_follow_up SET task_revision_id=$3,version=$4,waiting_on=$5,
      decision=$6,action_taken=$7,evidence_ref=$8,next_check_at=$9,release_handoff=$10,
      publication=$11,actor_id=$12,reason=$13,updated_at=$14
      WHERE project_id=$1 AND task_id=$2`,values);
    await this.db.query(`INSERT INTO task_attention_follow_up_revision(project_id,task_id,task_revision_id,
      version,waiting_on,decision,action_taken,evidence_ref,next_check_at,release_handoff,
      publication,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,values);
    return {entityId:command.taskId,version:next};
  }
  async recordPublication(command:Extract<TaskAttentionCommand,{type:"task.attention.publication.record"}>,
    actorId:string,now:string):Promise<{entityId:string;version:number}> {
    await this.taskHead(command.taskId,command.expectedTaskVersion,command.expectedTaskRevisionId);
    const r=await this.db.query(`SELECT * FROM task_attention_follow_up WHERE project_id=$1 AND task_id=$2 FOR UPDATE`,
      [this.projectId,command.taskId]);
    const prior=r.rows[0];
    if(!prior||prior.version!==command.expectedVersion)throw new DomainError("VERSION_CONFLICT","Follow-up changed",prior?.version??0);
    if(prior.task_revision_id!==command.expectedTaskRevisionId||!prior.release_handoff)
      throw new DomainError("PUBLICATION_HANDOFF_REQUIRED","Current Task revision needs a publication handoff");
    if(prior.publication)throw new DomainError("PUBLICATION_ALREADY_RECORDED","Publication evidence is already recorded");
    const readyAt=Date.parse(String(prior.release_handoff.readyForPublicationAt));
    if(!Number.isFinite(readyAt)||Date.parse(command.publishedAt)<readyAt||Date.parse(command.publishedAt)>Date.parse(now))
      throw new DomainError("PUBLICATION_TIME_INVALID","Publication must follow handoff readiness and not be in the future");
    const value={publishedAt:command.publishedAt,publicationRef:command.publicationRef},next=prior.version+1;
    await this.db.query(`UPDATE task_attention_follow_up SET version=$3,publication=$4,actor_id=$5,reason=$6,
      updated_at=$7 WHERE project_id=$1 AND task_id=$2`,[this.projectId,command.taskId,next,value,actorId,command.reason,now]);
    await this.db.query(`INSERT INTO task_attention_follow_up_revision(project_id,task_id,task_revision_id,
      version,waiting_on,decision,action_taken,evidence_ref,next_check_at,release_handoff,
      publication,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[this.projectId,command.taskId,
      command.expectedTaskRevisionId,next,prior.waiting_on,prior.decision,prior.action_taken,
      prior.evidence_ref,prior.next_check_at,prior.release_handoff,value,actorId,command.reason,now]);
    return {entityId:command.taskId,version:next};
  }
  async resolve(command:Extract<TaskAttentionCommand,{type:"task.attention.resolve"}>,
    actorId:string,now:string):Promise<{entityId:string;version:number}> {
    const r=await this.db.query(`SELECT * FROM task_attention_item WHERE project_id=$1 AND item_id=$2 FOR UPDATE`,
      [this.projectId,command.itemId]);
    const item=r.rows[0];
    if(!item)throw new DomainError("ATTENTION_NOT_FOUND","Attention item is unavailable in this project");
    if(item.state!=="open"||item.version!==command.expectedVersion)
      throw new DomainError("VERSION_CONFLICT","Attention item changed",item.version);
    const next=item.version+1;
    await this.db.query(`UPDATE task_attention_item SET state='resolved',version=$3,resolved_at=$4,
      resolution_reason=$5 WHERE project_id=$1 AND item_id=$2`,[this.projectId,command.itemId,next,command.reason,now]);
    await this.db.query(`INSERT INTO task_attention_item_event(project_id,item_id,item_version,kind,severity,
      evidence,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.projectId,command.itemId,next,command.disposition,item.severity,item.evidence,actorId,command.reason,now]);
    await this.retireNotice(item.notice_id);
    return {entityId:command.itemId,version:next};
  }
  async retireNotice(noticeId:string|null):Promise<void> {
    if(!noticeId)return;
    const n=await this.db.query(`SELECT state,message_id FROM leader_result_notice
      WHERE project_id=$1 AND notice_id=$2 FOR UPDATE`,[this.projectId,noticeId]);
    const notice=n.rows[0];
    if(!notice)return;
    const m=await this.db.query(`SELECT state,version FROM session_message
      WHERE project_id=$1 AND message_id=$2 FOR UPDATE`,[this.projectId,notice.message_id]);
    const message=m.rows[0];
    let cancelled=false;
    if(message?.state==="queued"){
      const started=await this.db.query(`SELECT 1 FROM session_message_processing
        WHERE project_id=$1 AND message_id=$2 LIMIT 1`,[this.projectId,notice.message_id]);
      if(started.rows[0])return;
      const result=await this.db.query(`UPDATE session_message SET state='cancelled',version=version+1,
        blocked_reason='ATTENTION_SOURCE_EXPIRED',updated_at=now()
        WHERE project_id=$1 AND message_id=$2 AND state='queued' AND version=$3`,
        [this.projectId,notice.message_id,message.version]);
      if(result.rowCount!==1)return;
      cancelled=true;
    }
    if(notice.state==="pending" && (!message || cancelled || message.state==="cancelled"))
      await this.db.query(`UPDATE leader_result_notice SET state='blocked',blocked_reason='ATTENTION_SOURCE_EXPIRED',
        updated_at=now() WHERE project_id=$1 AND notice_id=$2 AND state='pending'`,[this.projectId,noticeId]);
  }
  /** The caller holds the project transaction lock and has reread this Task under a row lock. */
  async recordAssessment(task:TaskAttentionTimedTask, assessments:TaskAttentionAssessment[], now:string,
    followUp:TaskAttentionFollowUp|null):Promise<void> {
    const current=task.timing.current;
    const source=taskAttentionSource(task,followUp);
    const waitingOn=followUp?.taskRevisionId===task.currentRevisionId && followUp.waitingOn
      ? followUp.waitingOn : current.waitingFor;
    const open=await this.db.query(`SELECT * FROM task_attention_item WHERE project_id=$1 AND task_id=$2
      AND state='open' FOR UPDATE`,[this.projectId,task.taskId]);
    const bySignal=new Map(open.rows.map(row=>[String(row.signal),row]));
    for(const item of open.rows){
      if(current.stage==="closed"||current.stage==="cancelled"||
        item.task_revision_id!==task.currentRevisionId || item.phase!==current.stage ||
        item.source_kind!==source?.kind || item.source_id!==source?.id){
        await this.resolveRecorded(item,"source_expired","Current Task source changed",now);
        bySignal.delete(String(item.signal));
      }
    }
    for(const assessment of assessments){
      const prior=bySignal.get(assessment.signal);
      if(assessment.status==="unknown")continue;
      if(assessment.status==="clear"){
        if(prior)await this.resolveRecorded(prior,"resolved",assessment.reason,now);
        continue;
      }
      if(!source || !assessment.severity)continue;
      if(prior){
        if(prior.severity==="watch" && assessment.severity==="urgent"){
          await this.retireNotice(prior.notice_id);
          const next=Number(prior.version)+1;
          await this.db.query(`UPDATE task_attention_item SET severity='urgent',version=$3,
            last_detected_at=$4,source_observed_at=$5,evidence=$6,reason=$7
            WHERE project_id=$1 AND item_id=$2`,[this.projectId,prior.item_id,next,now,task.timing.observedAt,assessment.evidence,assessment.reason]);
          await this.eventAndNotice(prior.item_id,task,next,"escalated","urgent",assessment,now);
        }else await this.db.query(`UPDATE task_attention_item SET last_detected_at=$3
          WHERE project_id=$1 AND item_id=$2`,[this.projectId,prior.item_id,now]);
        continue;
      }
      const inserted=await this.db.query(`INSERT INTO task_attention_item(project_id,task_id,
        task_revision_id,stage_id,phase,signal,source_kind,source_id,waiting_on,state,severity,version,
        first_detected_at,last_detected_at,source_observed_at,reason,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,1,$11,$11,$12,$13,$14) RETURNING item_id`,
        [this.projectId,task.taskId,task.currentRevisionId,task.stage?.stageId??null,current.stage,
          assessment.signal,source.kind,source.id,waitingOn,assessment.severity,now,
          task.timing.observedAt,assessment.reason,assessment.evidence]);
      await this.eventAndNotice(inserted.rows[0]!.item_id,task,1,"opened",assessment.severity,assessment,now);
    }
  }
  private async resolveRecorded(item:Row,kind:"resolved"|"source_expired",reason:string,now:string):Promise<void>{
    const next=Number(item.version)+1;
    await this.db.query(`UPDATE task_attention_item SET state='resolved',version=$3,resolved_at=$4,
      resolution_reason=$5 WHERE project_id=$1 AND item_id=$2 AND state='open'`,
      [this.projectId,item.item_id,next,now,reason]);
    await this.db.query(`INSERT INTO task_attention_item_event(project_id,item_id,item_version,kind,severity,
      evidence,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8)`,
      [this.projectId,item.item_id,next,kind,item.severity,item.evidence,reason,now]);
    await this.retireNotice(item.notice_id as string|null);
  }
  private async eventAndNotice(itemId:string,task:TaskAttentionTimedTask,version:number,
    kind:"opened"|"escalated",severity:"watch"|"urgent",
    assessment:TaskAttentionAssessment,now:string):Promise<void>{
    const event=await this.db.query(`INSERT INTO task_attention_item_event(project_id,item_id,item_version,
      kind,severity,evidence,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8) RETURNING event_id`,
      [this.projectId,itemId,version,kind,severity,assessment.evidence,assessment.reason,now]);
    const eventId=String(event.rows[0]!.event_id);
    await this.db.query(`SELECT enqueue_leader_result_notice($1,'task_attention',$2,$3,$4,NULL,NULL,$5,$6)`,
      [this.projectId,eventId,task.taskId,task.currentRevisionId,`task-attention:${itemId}@${version}`,now]);
    const notice=await this.db.query(`SELECT notice_id FROM leader_result_notice
      WHERE project_id=$1 AND kind='task_attention' AND source_event_id=$2`,[this.projectId,eventId]);
    await this.db.query(`UPDATE task_attention_item SET notice_id=$3 WHERE project_id=$1 AND item_id=$2`,
      [this.projectId,itemId,notice.rows[0]!.notice_id]);
  }
}

/** Recheck fixed notice source immediately before a native message can start. */
export async function taskAttentionNoticeCurrent(pool:Db,projectId:string,noticeId:string):Promise<boolean>{
  const r=await pool.query(`SELECT i.state,i.notice_id,i.task_id,i.task_revision_id,i.phase,i.signal,
      i.source_kind,i.source_id,t.current_revision_id AS current_revision_id,n.task_revision_id AS notice_revision_id
    FROM leader_result_notice n
    JOIN task_attention_item_event e ON e.project_id=n.project_id AND e.event_id=n.source_event_id
    JOIN task_attention_item i ON i.project_id=e.project_id AND i.item_id=e.item_id
    JOIN task t ON t.project_id=i.project_id AND t.task_id=i.task_id
    WHERE n.project_id=$1 AND n.notice_id=$2 AND n.kind='task_attention'`,[projectId,noticeId]);
  const source=r.rows[0];
  if(!source||source.state!=="open"||source.notice_id!==noticeId||
    source.task_revision_id!==source.current_revision_id||source.notice_revision_id!==source.current_revision_id)
    return false;
  const task=await readLeaderWorkTask(pool,projectId,String(source.task_id));
  const store=new PgTaskAttention(pool,projectId);
  const followUp=task?await store.getFollowUp(task.taskId):null;
  const currentSource=task?taskAttentionSource(task,followUp):null;
  if (!task || task.currentRevisionId!==source.task_revision_id ||
    task.timing.current.stage!==source.phase ||
    currentSource?.kind!==source.source_kind || currentSource?.id!==source.source_id)
    return false;
  const configured=await store.effectiveThreshold(task.stage?.stageId??null,task.timing.current.stage);
  const assessment=assessTaskAttention(task,configured??trialAttentionThreshold(task.timing.current.stage),
    task.timing.observedAt,followUp).find(item=>item.signal===source.signal);
  return assessment?.status==="triggered";
}
export async function disposeStaleTaskAttentionNotice(pool:Pool,projectId:string,noticeId:string):Promise<boolean>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
    const current=await taskAttentionNoticeCurrent(client,projectId,noticeId);
    if(!current)await new PgTaskAttention(client,projectId).retireNotice(noticeId);
    await client.query("COMMIT");
    return current;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Two bounded indexed streams, including terminal Tasks only while an item remains open. */
export async function scanTaskAttentionCandidates(db:Db,projectId:string,cursor:string|null,limit:number):Promise<string[]>{
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new DomainError("INVALID_PAGE","Attention scan limit must be 1..50");
  const r=await db.query(`WITH candidates AS (
    (SELECT task_id FROM task WHERE project_id=$1 AND state IN ('todo','in_progress')
      AND ($2::uuid IS NULL OR task_id>$2) ORDER BY task_id LIMIT $3)
    UNION
    (SELECT DISTINCT task_id FROM task_attention_item WHERE project_id=$1 AND state='open'
      AND ($2::uuid IS NULL OR task_id>$2) ORDER BY task_id LIMIT $3)
  ) SELECT task_id FROM candidates ORDER BY task_id LIMIT $3`,[projectId,cursor,limit]);
  return r.rows.map(row=>String(row.task_id));
}
