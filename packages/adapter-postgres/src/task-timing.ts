import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { computeDue } from "@evoloop/core/scheduling";
import type { ScheduleRevision } from "@evoloop/contracts/scheduling";
import type { TaskTimingCommand, TaskTimingInput, TaskTimingQueries, TaskTimingView } from "@evoloop/contracts/task-timing";
import { DomainError } from "@evoloop/contracts/ports";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: Date | string): string => new Date(value).toISOString();
const stableId = (value: string): string => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export class TaskTimingConflict extends DomainError {
  constructor(message: string, code = "TASK_TIMING_CONFLICT", currentVersion?: number) {
    super(code,message,currentVersion); this.name = "TaskTimingConflict";
  }
}

interface Template {
  title: string; content: string; acceptance: string; owner: string;
  kind: string | null; domainId: string | null;
  sourceTaskId: string; sourceTaskRevisionId: string;
  stageId: string | null; consumer: string; useRequired: boolean;
  acceptanceMode: string | null; evidence: string; stopCondition: string;
  documentIds: string[]; dependencyIds: string[]; priority: number | null;
}
interface SeriesRow {
  project_id: string; series_id: string; root_task_id: string;
  authorized_actor_id: string; authorized_role_id: string;
  version: number; current_revision_id: string; state: "active" | "stopped";
  first_at_utc: Date; watermark_utc: Date | null; skipped_count: string;
  timezone: string; repeat: "none" | "daily"; execute_at_utc: Date;
  template: Template;
}

function validateTiming(timing: TaskTimingInput): void {
  if (iso(timing.executeAtUtc) !== timing.executeAtUtc) throw new TaskTimingConflict("executeAtUtc must be canonical UTC ISO");
  if (!timing.timezone || timing.timezone.length > 80) throw new TaskTimingConflict("invalid timezone");
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timing.timezone }); }
  catch { throw new TaskTimingConflict("invalid IANA timezone"); }
  if (timing.repeat !== "none" && timing.repeat !== "daily") throw new TaskTimingConflict("invalid repeat rule");
  if (timing.repeat === "daily" && !timing.executeAtUtc.endsWith(":00.000Z"))
    throw new TaskTimingConflict("daily anchor must be on an exact minute");
}
function localTime(executeAtUtc: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(executeAtUtc));
  return `${parts.find(p => p.type === "hour")!.value}:${parts.find(p => p.type === "minute")!.value}`;
}
function due(row: SeriesRow, nowUtc: string): { plannedAtUtc: string[]; skippedCount: number } {
  const first = iso(row.first_at_utc);
  if (Date.parse(nowUtc) < Date.parse(first)) return { plannedAtUtc: [], skippedCount: 0 };
  const watermark = row.watermark_utc ? iso(row.watermark_utc) : new Date(Date.parse(first) - 1).toISOString();
  if (Date.parse(nowUtc) <= Date.parse(watermark)) return {plannedAtUtc:[],skippedCount:0};
  if (row.repeat === "none") return row.watermark_utc ? { plannedAtUtc: [], skippedCount: 0 } : { plannedAtUtc: [first], skippedCount: 0 };
  // The first instant belongs to the root Task, including ambiguous DST wall time.
  // computeDue rejects horizons beyond 370 calendar days for explicit review.
  // Within that horizon, latest emits one successor and counts skipped slots.
  const from = watermark;
  const revision: ScheduleRevision = {
    projectId: row.project_id, scheduleId: row.series_id, id: row.current_revision_id,
    version: row.version, timezone: row.timezone,
    rule: { kind: "daily", localTime: localTime(iso(row.execute_at_utc), row.timezone) },
    misfire: { kind: "latest" }, overlap: "queue",
    template: { title: row.template.title, content: row.template.content,
      acceptance: row.template.acceptance, owner: row.template.owner },
    authorization: { scopeId: row.series_id, roleId: row.authorized_role_id,
      authorizedBy: row.authorized_actor_id, expiresAtUtc: null },
    reason: "Task timing", actorId: row.authorized_actor_id, createdAtUtc: first,
  };
  const selected = computeDue(revision, from, nowUtc);
  const slots = selected.plannedAtUtc.filter(at => Date.parse(at) > Date.parse(first));
  if (!row.watermark_utc && Date.parse(first) <= Date.parse(nowUtc)) slots.unshift(first);
  const rootWasCounted = !row.watermark_utc && computeDue(revision,
    new Date(Date.parse(first)-1).toISOString(),first).plannedAtUtc.includes(first);
  return { plannedAtUtc: slots,
    skippedCount: Math.max(0, selected.skippedCount - (rootWasCounted ? 1 : 0)) };
}

function nextDaily(row: SeriesRow, afterUtc: string): string | null {
  if (row.state !== "active" || row.repeat !== "daily") return null;
  const revision: ScheduleRevision = {
    projectId: row.project_id, scheduleId: row.series_id, id: row.current_revision_id,
    version: row.version, timezone: row.timezone,
    rule: { kind: "daily", localTime: localTime(iso(row.execute_at_utc), row.timezone) },
    misfire: { kind: "bounded", maxCatchUp: 5 }, overlap: "queue",
    template: { title: row.template.title, content: row.template.content,
      acceptance: row.template.acceptance, owner: row.template.owner },
    authorization: { scopeId: row.series_id, roleId: row.authorized_role_id,
      authorizedBy: row.authorized_actor_id, expiresAtUtc: null },
    reason: "Task timing", actorId: row.authorized_actor_id, createdAtUtc: iso(row.first_at_utc),
  };
  return computeDue(revision, afterUtc,
    new Date(Date.parse(afterUtc) + 3 * 86_400_000).toISOString()).plannedAtUtc
    .find(at => Date.parse(at) > Date.parse(iso(row.first_at_utc))) ?? null;
}

async function templateFromTask(client: PoolClient, projectId: string, taskId: string): Promise<Template> {
  const task = await client.query(`SELECT t.*,d.body FROM task t JOIN document_revision d
    ON d.project_id=t.project_id AND d.document_id=t.content_document_id AND d.revision_id=t.content_revision_id
    WHERE t.project_id=$1 AND t.task_id=$2 FOR SHARE OF t`, [projectId, taskId]);
  const t = task.rows[0];
  if (!t) throw new TaskTimingConflict("Task does not exist");
  const proposal = await client.query(`SELECT p.* FROM task_proposal p
    JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id
      AND r.revision_id=p.task_revision_id
    WHERE p.project_id=$1 AND p.task_id=$2 AND r.version<=$3
    ORDER BY r.version DESC LIMIT 1`, [projectId, taskId, t.version]);
  const p = proposal.rows[0];
  if (!p) throw new TaskTimingConflict("Task proposal is missing");
  const links = await client.query(`SELECT document_id FROM task_document_link WHERE project_id=$1 AND task_id=$2 ORDER BY document_id`, [projectId, taskId]);
  const deps = await client.query(`SELECT depends_on_task_id FROM task_dependency WHERE project_id=$1 AND task_id=$2 ORDER BY depends_on_task_id`, [projectId, taskId]);
  const plan = await client.query(`SELECT priority FROM task_work_plan WHERE project_id=$1 AND task_id=$2`,[projectId,taskId]);
  return { title: t.title, content: t.body, acceptance: t.acceptance, owner: t.owner,
    kind: t.kind, domainId: t.domain_id, sourceTaskId: taskId, sourceTaskRevisionId: t.current_revision_id,
    stageId: p.stage_id, consumer: p.consumer, useRequired: p.use_required,
    acceptanceMode: p.acceptance_mode, evidence: p.evidence, stopCondition: p.stop_condition,
    documentIds: links.rows.map(r => r.document_id), dependencyIds: deps.rows.map(r => r.depends_on_task_id),
    priority: plan.rows[0]?.priority ?? null };
}
async function validateTemplate(client: PoolClient, projectId: string, template: Template): Promise<void> {
  if (!uuid.test(template.owner)) throw new TaskTimingConflict("Task owner must be a real Role");
  const role = await client.query(`SELECT state FROM role_definition WHERE project_id=$1 AND role_id=$2 FOR SHARE`, [projectId, template.owner]);
  if (!role.rows[0] || !["active", "trial"].includes(role.rows[0].state)) throw new TaskTimingConflict("Task owner Role is not active or trial");
  if (template.stageId) {
    const stage = await client.query(`SELECT state FROM project_stage WHERE project_id=$1 AND stage_id=$2 FOR SHARE`, [projectId, template.stageId]);
    if (stage.rows[0]?.state !== "active") throw new TaskTimingConflict("Task stage is no longer active");
  }
  if (template.domainId) {
    const domain = await client.query(`SELECT state FROM business_domain WHERE project_id=$1 AND domain_id=$2 FOR SHARE`,
      [projectId,template.domainId]);
    if (domain.rows[0]?.state !== "active") throw new TaskTimingConflict("Task domain is no longer active");
  }
  if (template.acceptanceMode === "human_required" && !template.consumer)
    throw new TaskTimingConflict("human acceptance requires its named consumer");
  if (template.useRequired && !template.acceptanceMode)
    throw new TaskTimingConflict("Task consumer policy is incomplete");
  for (const id of template.documentIds) {
    const result = await client.query(`SELECT adopted_revision_id FROM process_document WHERE project_id=$1 AND document_id=$2 FOR SHARE`, [projectId, id]);
    if (!result.rows[0] || !result.rows[0].adopted_revision_id)
      throw new TaskTimingConflict(`linked document ${id} is absent or not adopted`);
  }
  // A copied dependency must already have accepted evidence. Otherwise a new Task
  // would inherit a stale or ambiguous gate; leave the slot pending for Lead review.
  for (const id of template.dependencyIds) {
    const result = await client.query(`SELECT 1 FROM task t WHERE t.project_id=$1 AND t.task_id=$2
      AND (EXISTS(SELECT 1 FROM task_closure c WHERE c.project_id=t.project_id AND c.task_id=t.task_id AND c.task_revision_id=t.current_revision_id)
        OR EXISTS(SELECT 1 FROM resident_queue_claim q JOIN resident_queue_attempt a
          ON a.project_id=q.project_id AND a.claim_id=q.claim_id
          WHERE q.project_id=t.project_id AND q.task_id=t.task_id AND q.release_kind='accepted'
            AND a.task_revision_id=t.current_revision_id))`, [projectId, id]);
    if (!result.rows.length) throw new TaskTimingConflict(`dependency ${id} needs review before copying`);
  }
}
async function loadSeries(client: PoolClient, projectId: string, seriesId: string, lock = false): Promise<SeriesRow | null> {
  const result = await client.query(`SELECT s.*,r.timezone,r.repeat,r.execute_at_utc,r.template
    FROM task_timing_series s JOIN task_timing_series_revision r
      ON r.project_id=s.project_id AND r.series_id=s.series_id AND r.revision_id=s.current_revision_id
    WHERE s.project_id=$1 AND s.series_id=$2 ${lock ? "FOR UPDATE OF s" : ""}`, [projectId, seriesId]);
  return result.rows[0] ?? null;
}
async function seriesForTask(client: PoolClient, projectId: string, taskId: string, lock = false): Promise<SeriesRow | null> {
  const binding = await client.query(`SELECT series_id FROM task_timing WHERE project_id=$1 AND task_id=$2`, [projectId, taskId]);
  return binding.rows[0] ? loadSeries(client, projectId, binding.rows[0].series_id, lock) : null;
}
async function appendRevision(client: PoolClient, row: SeriesRow, template: Template,
  timing: TaskTimingInput, actorId: string, nowUtc: string, reason: string, state: "active" | "stopped",
  reauthorize = false): Promise<void> {
  const version = row.version + 1, revisionId = randomUUID();
  await client.query(`UPDATE task_timing_series SET version=$3,current_revision_id=$4,state=$5,updated_at_utc=$6,
    authorized_actor_id=CASE WHEN $7 THEN $8 ELSE authorized_actor_id END,
    authorized_role_id=CASE WHEN $7 THEN $9 ELSE authorized_role_id END
    WHERE project_id=$1 AND series_id=$2`, [row.project_id, row.series_id, version, revisionId,
      state, nowUtc, reauthorize, actorId, template.owner]);
  await client.query(`INSERT INTO task_timing_series_revision(project_id,series_id,revision_id,version,
    source_task_id,source_task_revision_id,timezone,repeat,execute_at_utc,template,state,actor_id,reason,created_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
    [row.project_id,row.series_id,revisionId,version,template.sourceTaskId,template.sourceTaskRevisionId,
      timing.timezone,timing.repeat,timing.executeAtUtc,JSON.stringify(template),state,actorId,reason,nowUtc]);
}

async function reviseCurrentTask(client: PoolClient, projectId: string, taskId: string,
  expectedVersion: number, change: {title?:string|undefined;content?:string|undefined;acceptance?:string|undefined},
  actorId: string, nowUtc: string, reason: string): Promise<void> {
  if (change.title === undefined && change.content === undefined && change.acceptance === undefined) return;
  const read = await client.query(`SELECT t.*,dr.body,d.version AS document_version,
    d.adopted_revision_id FROM task t JOIN process_document d
    ON d.project_id=t.project_id AND d.document_id=t.content_document_id
    JOIN document_revision dr ON dr.project_id=t.project_id AND dr.document_id=t.content_document_id
      AND dr.revision_id=t.content_revision_id
    WHERE t.project_id=$1 AND t.task_id=$2 FOR UPDATE OF t,d`,[projectId,taskId]);
  const t = read.rows[0];
  if (!t) throw new TaskTimingConflict("Current Task is missing");
  if (t.version !== expectedVersion)
    throw new TaskTimingConflict("Current Task version changed","VERSION_CONFLICT",t.version);
  if (t.state !== "todo") throw new TaskTimingConflict("Current Task already started");
  const title = change.title ?? t.title, content = change.content ?? t.body;
  const acceptance = change.acceptance ?? t.acceptance;
  if (title === t.title && content === t.body && acceptance === t.acceptance) return;
  let contentRevisionId: string = t.content_revision_id;
  if (content !== t.body) {
    contentRevisionId = randomUUID();
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,previous_revision_id,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,$6,$7,$8,$9,'text/markdown',$10,'[]'::jsonb)`,
      [projectId,t.content_document_id,contentRevisionId,content,hash(content),actorId,nowUtc,
        t.content_revision_id,reason,`${t.content_document_id}.md`]);
  }
  if (title !== t.title || contentRevisionId !== t.content_revision_id)
    await client.query(`UPDATE process_document SET version=$3,title=$4,current_revision_id=$5,
      status=$6 WHERE project_id=$1 AND document_id=$2`,[projectId,t.content_document_id,
        t.document_version+1,title,contentRevisionId,t.adopted_revision_id ? "published" : "draft"]);
  const revisionId = randomUUID(), nextBasisId = t.state === "todo" ? await client.query(`SELECT basis_set_id
    FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3`,
    [projectId,taskId,t.current_revision_id]).then(result => result.rows[0]?.basis_set_id ? randomUUID() : null) : null;
  await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,
    owner,state,kind,domain_id,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'todo',$8,$9,$10,$11,$12,$13,$14,$15)`,
    [projectId,taskId,revisionId,t.version+1,title,acceptance,t.owner,t.kind,t.domain_id,
      t.content_document_id,contentRevisionId,nextBasisId,actorId,reason,nowUtc]);
  if (nextBasisId) {
    const prior = await client.query(`SELECT m.document_id,m.document_revision_id FROM basis_member m
      JOIN task_revision r ON r.project_id=m.project_id AND r.task_id=m.task_id
        AND r.revision_id=m.task_revision_id AND r.basis_set_id=m.basis_set_id
      WHERE m.project_id=$1 AND m.task_id=$2 AND m.task_revision_id=$3`,
      [projectId,taskId,t.current_revision_id]);
    await client.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,false)`,[projectId,taskId,revisionId,nextBasisId]);
    for (const member of prior.rows) await client.query(`INSERT INTO basis_member(project_id,task_id,
      task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [projectId,taskId,revisionId,nextBasisId,member.document_id,
        member.document_id === t.content_document_id ? contentRevisionId : member.document_revision_id]);
    await client.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2
      AND task_revision_id=$3 AND basis_set_id=$4`,[projectId,taskId,revisionId,nextBasisId]);
  }
  const proposal = await client.query(`SELECT p.stage_id,p.consumer,p.use_required,p.acceptance_mode,
    p.evidence,p.stop_condition FROM task_proposal p JOIN task_revision r
      ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id
    WHERE p.project_id=$1 AND p.task_id=$2 AND r.version<=$3
    ORDER BY r.version DESC LIMIT 1`,[projectId,taskId,t.version]);
  const p = proposal.rows[0];
  if (!p) throw new TaskTimingConflict("Task proposal is missing");
  await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,
    use_required,acceptance_mode,evidence,stop_condition,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[projectId,taskId,revisionId,p.stage_id,
      p.consumer,p.use_required,p.acceptance_mode,p.evidence,p.stop_condition,nowUtc]);
  await client.query(`UPDATE task SET version=$3,current_revision_id=$4,title=$5,acceptance=$6,
    content_revision_id=$7 WHERE project_id=$1 AND task_id=$2`,[projectId,taskId,t.version+1,
      revisionId,title,acceptance,contentRevisionId]);
}

/** Uses the caller's transaction, including the Task command journal transaction. */
export class PgTaskTimingQueries implements TaskTimingQueries {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async get(taskId: string): Promise<TaskTimingView | null> {
    const row = await seriesForTask(this.client, this.projectId, taskId);
    if (!row) return null;
    const currentResult = await this.client.query(`SELECT o.task_id,o.previous_task_id,o.planned_at_utc,t.state
      FROM task_timing_occurrence o JOIN task t ON t.project_id=o.project_id AND t.task_id=o.task_id
      WHERE o.project_id=$1 AND o.series_id=$2 AND o.task_id=$3`, [this.projectId,row.series_id,taskId]);
    const current = currentResult.rows[0];
    if (!current) throw new TaskTimingConflict("Task timing binding is inconsistent");
    const nextResult = await this.client.query(`SELECT task_id,planned_at_utc FROM task_timing_occurrence
      WHERE project_id=$1 AND series_id=$2 AND planned_at_utc>$3 ORDER BY planned_at_utc LIMIT 1`,
      [this.projectId,row.series_id,current.planned_at_utc]);
    const next = nextResult.rows[0];
    const latest = await this.client.query(`SELECT planned_at_utc FROM task_timing_occurrence
      WHERE project_id=$1 AND series_id=$2 ORDER BY planned_at_utc DESC LIMIT 1`,[this.projectId,row.series_id]);
    const nextAt = nextDaily(row,iso(latest.rows[0].planned_at_utc));
    const previous = current.previous_task_id ? await this.client.query(`SELECT state FROM task
      WHERE project_id=$1 AND task_id=$2`,[this.projectId,current.previous_task_id]) : null;
    let waitingReason = previous?.rows[0] && !["done", "cancelled"].includes(previous.rows[0].state)
      ? `上一份任务 ${current.previous_task_id} 仍为${previous.rows[0].state === "todo" ? "待办" : "进行中"}` : null;
    if (!waitingReason && current.previous_task_id) {
      const unsettled = await this.client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1
        AND task_id=$2 AND state IN ('requested','dispatching','running','unknown') LIMIT 1`,
        [this.projectId,current.previous_task_id]);
      if (unsettled.rows.length) waitingReason = `上一份任务 ${current.previous_task_id} 的运行尚未结算`;
    }
    const recent = await this.client.query(`SELECT o.task_id,o.planned_at_utc,t.state
      FROM task_timing_occurrence o JOIN task t ON t.project_id=o.project_id AND t.task_id=o.task_id
      WHERE o.project_id=$1 AND o.series_id=$2 ORDER BY o.planned_at_utc DESC LIMIT 100`,
      [this.projectId,row.series_id]);
    return { projectId: this.projectId, taskId, seriesId: row.series_id, rootTaskId: row.root_task_id, version: row.version,
      seriesState: row.state, executeAtUtc: iso(current.planned_at_utc), timezone: row.timezone,
      repeat: row.repeat, previousTaskId: current.previous_task_id ?? null,
      nextTaskId: next?.task_id ?? null, nextAtUtc: next ? iso(next.planned_at_utc) : nextAt,
      waitingReason, futureTemplate: {title:row.template.title,content:row.template.content,
        acceptance:row.template.acceptance},
      occurrences: recent.rows.reverse().map(r => ({taskId:r.task_id,executeAtUtc:iso(r.planned_at_utc),state:r.state})) };
  }

  async create(taskId: string, timing: TaskTimingInput, actorId: string, nowUtc: string): Promise<void> {
    validateTiming(timing);
    const task = await this.client.query(`SELECT state FROM task WHERE project_id=$1 AND task_id=$2 FOR SHARE`,
      [this.projectId,taskId]);
    if (task.rows[0]?.state !== "todo") throw new TaskTimingConflict("Timing requires a todo Task");
    const existing = await this.client.query(`SELECT 1 FROM task_timing WHERE project_id=$1 AND task_id=$2`, [this.projectId,taskId]);
    if (existing.rows.length) throw new TaskTimingConflict("Task already belongs to a timing series");
    const template = await templateFromTask(this.client, this.projectId, taskId);
    await validateTemplate(this.client, this.projectId, template);
    const seriesId = randomUUID(), revisionId = randomUUID();
    await this.client.query(`INSERT INTO task_timing_series(project_id,series_id,root_task_id,authorized_actor_id,
      authorized_role_id,version,current_revision_id,state,first_at_utc,updated_at_utc)
      VALUES($1,$2,$3,$4,$5,1,$6,'active',$7,$8)`,
      [this.projectId,seriesId,taskId,actorId,template.owner,revisionId,timing.executeAtUtc,nowUtc]);
    await this.client.query(`INSERT INTO task_timing_series_revision(project_id,series_id,revision_id,version,
      source_task_id,source_task_revision_id,timezone,repeat,execute_at_utc,template,state,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9::jsonb,'active',$10,'Initial Task timing',$11)`,
      [this.projectId,seriesId,revisionId,taskId,template.sourceTaskRevisionId,timing.timezone,timing.repeat,
        timing.executeAtUtc,JSON.stringify(template),actorId,nowUtc]);
    await this.client.query(`INSERT INTO task_timing_occurrence(project_id,series_id,planned_at_utc,task_id,
      series_revision_id,previous_task_id,created_at_utc) VALUES($1,$2,$3,$4,$5,NULL,$6)`,
      [this.projectId,seriesId,timing.executeAtUtc,taskId,revisionId,nowUtc]);
    await this.client.query(`INSERT INTO task_timing(project_id,task_id,series_id,planned_at_utc)
      VALUES($1,$2,$3,$4)`, [this.projectId,taskId,seriesId,timing.executeAtUtc]);
  }

  async set(command: Extract<TaskTimingCommand,{type:"task.timing.set"}>, actorId: string, nowUtc: string): Promise<TaskTimingView> {
    const taskId = command.taskId;
    const timing: TaskTimingInput = {executeAtUtc:command.executeAtUtc,timezone:command.timezone,repeat:command.repeat};
    validateTiming(timing);
    let row = await seriesForTask(this.client,this.projectId,taskId,true);
    if (!row) {
      if (command.expectedTimingVersion !== 0 || command.scope === "future")
        throw new TaskTimingConflict("Task has no timing series","VERSION_CONFLICT",0);
      await this.create(taskId,timing,actorId,nowUtc);
      row = await seriesForTask(this.client,this.projectId,taskId,true);
    } else {
      if (row.version !== command.expectedTimingVersion)
        throw new TaskTimingConflict("Task timing version changed","VERSION_CONFLICT",row.version);
      if (row.state !== "active") throw new TaskTimingConflict("Task timing series stopped");
    }
    if (!row) throw new TaskTimingConflict("Task timing creation failed");
    if (command.scope !== "future") await reviseCurrentTask(this.client,this.projectId,taskId,
      command.expectedTaskVersion,command,actorId,nowUtc,command.reason);
    if (command.scope !== "future" && command.expectedTimingVersion !== 0) {
      const occurrence = await this.client.query(`SELECT planned_at_utc FROM task_timing_occurrence WHERE project_id=$1 AND task_id=$2`,[this.projectId,taskId]);
      if (!occurrence.rows[0]) throw new TaskTimingConflict("Task occurrence missing");
      if (iso(occurrence.rows[0].planned_at_utc) !== timing.executeAtUtc) {
      if (Date.parse(iso(occurrence.rows[0].planned_at_utc)) <= Date.parse(nowUtc))
        throw new TaskTimingConflict("Cannot move a due or started occurrence");
      const before = await this.client.query(`SELECT planned_at_utc FROM task_timing_occurrence
        WHERE project_id=$1 AND series_id=$2 AND planned_at_utc<$3 ORDER BY planned_at_utc DESC LIMIT 1`,
        [this.projectId,row.series_id,occurrence.rows[0].planned_at_utc]);
      const after = await this.client.query(`SELECT planned_at_utc FROM task_timing_occurrence
        WHERE project_id=$1 AND series_id=$2 AND planned_at_utc>$3 ORDER BY planned_at_utc LIMIT 1`,
        [this.projectId,row.series_id,occurrence.rows[0].planned_at_utc]);
      if ((before.rows[0] && Date.parse(command.executeAtUtc) <= Date.parse(iso(before.rows[0].planned_at_utc))) ||
          (after.rows[0] && Date.parse(command.executeAtUtc) >= Date.parse(iso(after.rows[0].planned_at_utc))) ||
          (row.watermark_utc && Date.parse(command.executeAtUtc) <= Date.parse(iso(row.watermark_utc))))
        throw new TaskTimingConflict("Rescheduled slot must stay after the watermark and between adjacent Tasks");
      await this.client.query(`INSERT INTO task_timing_occurrence_revision(project_id,revision_id,series_id,
        task_id,previous_at_utc,next_at_utc,actor_id,reason,created_at_utc)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[this.projectId,randomUUID(),row.series_id,taskId,
          occurrence.rows[0].planned_at_utc,command.executeAtUtc,actorId,command.reason,nowUtc]);
      await this.client.query(`UPDATE task_timing_occurrence SET planned_at_utc=$3 WHERE project_id=$1 AND task_id=$2`,
        [this.projectId,taskId,timing.executeAtUtc]);
      await this.client.query(`UPDATE task_timing SET planned_at_utc=$3 WHERE project_id=$1 AND task_id=$2`,
        [this.projectId,taskId,timing.executeAtUtc]);
      if (taskId === row.root_task_id) await this.client.query(`UPDATE task_timing_series SET first_at_utc=$3
        WHERE project_id=$1 AND series_id=$2`,[this.projectId,row.series_id,timing.executeAtUtc]);
      }
    }
    let template = row.template;
    if (command.scope !== "this") {
      template = command.scope === "this_and_future" ? await templateFromTask(this.client,this.projectId,taskId)
        : {...template,title:command.title ?? template.title,content:command.content ?? template.content,
          acceptance:command.acceptance ?? template.acceptance};
      if (command.scope === "future") {
        const source = await this.client.query(`SELECT current_revision_id,owner FROM task
          WHERE project_id=$1 AND task_id=$2 FOR SHARE`,[this.projectId,taskId]);
        if (!source.rows[0]) throw new TaskTimingConflict("Future edit source Task missing");
        const sourceChanged = template.title !== row.template.title || template.content !== row.template.content ||
          template.acceptance !== row.template.acceptance || source.rows[0].owner !== row.template.owner;
        template = {...template,owner:source.rows[0].owner,
          sourceTaskId:sourceChanged ? taskId : template.sourceTaskId,
          sourceTaskRevisionId:sourceChanged ? source.rows[0].current_revision_id : template.sourceTaskRevisionId};
      }
      await validateTemplate(this.client,this.projectId,template);
    }
    if (command.expectedTimingVersion !== 0 ||
        command.scope === "this_and_future" && JSON.stringify(template) !== JSON.stringify(row.template)) {
      const seriesTiming = command.scope === "this" ? {
        executeAtUtc: iso(row.execute_at_utc), timezone: row.timezone, repeat: row.repeat,
      } : timing;
      await appendRevision(this.client,row,template,seriesTiming,actorId,nowUtc,command.reason,"active",
        command.scope !== "this");
    }
    return (await this.get(taskId))!;
  }

  async stop(command: Extract<TaskTimingCommand,{type:"task.timing.stop"}>, actorId: string, nowUtc: string): Promise<TaskTimingView> {
    const row = await seriesForTask(this.client,this.projectId,command.taskId,true);
    if (!row) throw new TaskTimingConflict("Task has no timing series","VERSION_CONFLICT",0);
    if (row.version !== command.expectedTimingVersion)
      throw new TaskTimingConflict("Task timing version changed","VERSION_CONFLICT",row.version);
    if (row.state !== "active") throw new TaskTimingConflict("Task timing series stopped");
    await appendRevision(this.client,row,row.template,{executeAtUtc:iso(row.execute_at_utc),timezone:row.timezone,
      repeat:row.repeat},actorId,nowUtc,command.reason,"stopped");
    return (await this.get(command.taskId))!;
  }

  async updateFuture(taskId: string, update: {title:string;content:string;acceptance:string}, expectedTimingVersion: number, actorId: string, nowUtc: string): Promise<void> {
    const row = await seriesForTask(this.client,this.projectId,taskId,true);
    if (!row || row.state !== "active") throw new TaskTimingConflict("Active timing series required");
    if (row.version !== expectedTimingVersion)
      throw new TaskTimingConflict("Task timing version changed","VERSION_CONFLICT",row.version);
    const current = await templateFromTask(this.client,this.projectId,taskId);
    const template = {...current,...update};
    await validateTemplate(this.client,this.projectId,template);
    await appendRevision(this.client,row,template,{executeAtUtc:iso(row.execute_at_utc),timezone:row.timezone,
      repeat:row.repeat},actorId,nowUtc,"Task content updated for future occurrences","active",true);
  }
}

export interface TaskTimingTickResult {
  seriesId: string; taskId: string; plannedAtUtc: string; created: boolean;
}
export class TaskTimingTickPartialError extends Error {
  constructor(public readonly completed: TaskTimingTickResult[],
    public readonly failures: {seriesId:string; reason:string}[]) {
    super(`${failures.length} Task timing series need review`);
    this.name = "TaskTimingTickPartialError";
  }
}

async function emitDue(client: PoolClient, projectId: string, seriesId: string,
  plannedAtUtc: string, taskId: string, actorId: string, nowUtc: string): Promise<void> {
  const key = `${projectId}:${seriesId}:${plannedAtUtc}`;
  const operationId = stableId(`task-timing-operation:${key}`);
  const eventId = stableId(`task-timing-outbox:${key}`);
  const result = {status:"applied",operationId,entityId:taskId,version:1};
  await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,
    command_type,result,created_at) VALUES($1,$2,$3,$4,'task.timing.due',$5::jsonb,$6)`,
    [projectId,operationId,actorId,hash(key),JSON.stringify(result),nowUtc]);
  await client.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,
    entity_id,version,created_at) VALUES($1,$2,$3,$4,'task', $5,1,$6)`,
    [projectId,eventId,operationId,`task-timing:${seriesId}:${plannedAtUtc}`,taskId,nowUtc]);
}

/** Coordinator must pass its currently granted actor and Role; each series is filtered again in SQL. */
export class PgTaskTimingStore {
  constructor(private readonly pool: Pool) {}
  async readSeries(projectId: string, seriesId: string): Promise<SeriesRow | null> {
    const client = await this.pool.connect();
    try { return await loadSeries(client,projectId,seriesId); } finally { client.release(); }
  }
  async tick(projectId: string, nowUtc: string, actorId: string, roleId: string, scopeId: string): Promise<TaskTimingTickResult[]> {
    if (!uuid.test(roleId)) throw new TaskTimingConflict("tick requires a real Role");
    const client = await this.pool.connect();
    const created: TaskTimingTickResult[] = [];
    const failures: {seriesId:string;reason:string}[] = [];
    try {
      await client.query("BEGIN");
      const matching = await client.query(`SELECT series_id FROM task_timing_series
        WHERE project_id=$1 AND authorized_actor_id=$2 AND authorized_role_id=$3 AND state='active'
          AND ($4 = 'task-timing:' || root_task_id::text)
        ORDER BY series_id FOR UPDATE SKIP LOCKED`,[projectId,actorId,roleId,scopeId]);
      for (const item of matching.rows) {
        const completedBefore = created.length;
        await client.query("SAVEPOINT task_timing_series_tick");
        try {
        const row = await loadSeries(client,projectId,item.series_id);
        if (!row) throw new TaskTimingConflict("Selected Task timing series disappeared");
        const selected = due(row,nowUtc);
        if (!selected.plannedAtUtc.length) {
          await client.query("RELEASE SAVEPOINT task_timing_series_tick");
          continue;
        }
        let previous = await client.query(`SELECT task_id FROM task_timing_occurrence
          WHERE project_id=$1 AND series_id=$2 ORDER BY planned_at_utc DESC LIMIT 1`,[projectId,row.series_id]);
        for (const plannedAtUtc of selected.plannedAtUtc) {
          if (plannedAtUtc === iso(row.first_at_utc)) {
            await emitDue(client,projectId,row.series_id,plannedAtUtc,row.root_task_id,actorId,nowUtc);
            created.push({seriesId:row.series_id,taskId:row.root_task_id,plannedAtUtc,created:false});
            continue;
          }
          const existing = await client.query(`SELECT task_id FROM task_timing_occurrence
            WHERE project_id=$1 AND series_id=$2 AND planned_at_utc=$3`,[projectId,row.series_id,plannedAtUtc]);
          if (existing.rows.length) continue;
          await validateTemplate(client,projectId,row.template);
          const key = `${projectId}:${row.series_id}:${plannedAtUtc}`;
          const taskId = stableId(`task-timing-task:${key}`), taskRevisionId = stableId(`task-timing-revision:${key}`);
          const documentId = stableId(`task-timing-document:${key}`), contentRevisionId = stableId(`task-timing-content:${key}`);
          const t = row.template, reason = `Task timing series ${row.series_id} at ${plannedAtUtc}`;
          await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
            VALUES($1,$2,$3,1,$4,'task','draft')`,[projectId,documentId,t.title,contentRevisionId]);
          await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
            author,created_at,reason,media_type,original_name,assets_manifest)
            VALUES($1,$2,$3,$4,'markdown',$5,$6,$7,$8,'text/markdown',$9,'[]'::jsonb)`,
            [projectId,documentId,contentRevisionId,t.content,hash(t.content),actorId,nowUtc,reason,`${taskId}.md`]);
          await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
            kind,domain_id,content_document_id,content_revision_id)
            VALUES($1,$2,1,$3,$4,$5,$6,'todo',$7,$8,$9,$10)`,
            [projectId,taskId,taskRevisionId,t.title,t.acceptance,t.owner,t.kind,t.domainId,documentId,contentRevisionId]);
          await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,
            kind,domain_id,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
            VALUES($1,$2,$3,1,$4,$5,$6,'todo',$7,$8,$9,$10,NULL,$11,$12,$13)`,
            [projectId,taskId,taskRevisionId,t.title,t.acceptance,t.owner,t.kind,t.domainId,documentId,contentRevisionId,
              actorId,reason,nowUtc]);
          await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,
            acceptance_mode,evidence,stop_condition,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [projectId,taskId,taskRevisionId,t.stageId,t.consumer,t.useRequired,t.acceptanceMode,t.evidence,t.stopCondition,nowUtc]);
          for (const document of t.documentIds) await client.query(`INSERT INTO task_document_link(project_id,link_id,
            task_id,document_id,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [projectId,randomUUID(),taskId,document,actorId,nowUtc]);
          for (const dependency of t.dependencyIds) await client.query(`INSERT INTO task_dependency(project_id,task_id,
            depends_on_task_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [projectId,taskId,dependency,actorId,reason,nowUtc]);
          await client.query(`INSERT INTO task_work_plan(project_id,task_id,version,planned_start_at,due_at,
            priority,actor_id,reason,updated_at) VALUES($1,$2,1,$3,NULL,$4,$5,$6,$7)`,
            [projectId,taskId,plannedAtUtc,t.priority,actorId,reason,nowUtc]);
          await client.query(`INSERT INTO task_timing_occurrence(project_id,series_id,planned_at_utc,task_id,
            series_revision_id,previous_task_id,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [projectId,row.series_id,plannedAtUtc,taskId,row.current_revision_id,previous.rows[0]?.task_id ?? row.root_task_id,nowUtc]);
          await client.query(`INSERT INTO task_timing(project_id,task_id,series_id,planned_at_utc)
            VALUES($1,$2,$3,$4)`,[projectId,taskId,row.series_id,plannedAtUtc]);
          await emitDue(client,projectId,row.series_id,plannedAtUtc,taskId,actorId,nowUtc);
          previous = {rows:[{task_id:taskId}]} as typeof previous;
          created.push({seriesId:row.series_id,taskId,plannedAtUtc,created:true});
        }
        await client.query(`UPDATE task_timing_series SET watermark_utc=$3,skipped_count=skipped_count+$4,
          updated_at_utc=$5 WHERE project_id=$1 AND series_id=$2`,
          [projectId,row.series_id,nowUtc,selected.skippedCount,nowUtc]);
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT task_timing_series_tick");
          created.length = completedBefore;
          failures.push({seriesId:item.series_id,reason:error instanceof Error ? error.message : String(error)});
        }
        await client.query("RELEASE SAVEPOINT task_timing_series_tick");
      }
      await client.query("COMMIT");
      if (failures.length) throw new TaskTimingTickPartialError(created,failures);
      return created;
    } catch (error) {
      if (!(error instanceof TaskTimingTickPartialError)) await client.query("ROLLBACK");
      throw error;
    }
    finally { client.release(); }
  }
}
