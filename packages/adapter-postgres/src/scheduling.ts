import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Occurrence, ScheduleDefinition, ScheduleRevision, ScheduleStore } from "@evoloop/contracts/scheduling";

import { rowDefinition, rowOccurrence } from "./scheduling-rows.js";
const deterministicId = (value: string): string => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ScheduleStoreConflict extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleStoreConflict"; }
}
export class ScheduleReservationUnknown extends Error {
  constructor(public readonly projectId: string, public readonly scheduleId: string, public readonly plannedAtUtc: string) {
    super("occurrence reservation outcome unknown; reconcile stable UTC key before retry"); this.name = "ScheduleReservationUnknown";
  }
}

/** Standalone PG store. The coordinator supplies its shared pool and single-owner lease. */
export class PgSchedulingStore implements ScheduleStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async appendRevision(client: PoolClient, definition: ScheduleDefinition): Promise<void> {
    const r = definition.revision;
    await client.query(`INSERT INTO schedule_revision(project_id,schedule_id,revision_id,version,timezone,rule,misfire,overlap_policy,task_template,authorization_scope,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
      [r.projectId, r.scheduleId, r.id, r.version, r.timezone, JSON.stringify(r.rule), JSON.stringify(r.misfire), r.overlap, JSON.stringify(r.template), JSON.stringify(r.authorization), r.actorId, r.reason, r.createdAtUtc]);
  }

  private async decision(client: PoolClient, definition: ScheduleDefinition, kind: "create" | "revise" | "watermark", reason: string, observedAtUtc: string): Promise<void> {
    await client.query(`INSERT INTO schedule_decision(project_id,decision_id,schedule_id,schedule_revision_id,kind,actor_id,reason,observed_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [definition.projectId, randomUUID(), definition.id, definition.currentRevisionId, kind, definition.revision.actorId, reason, observedAtUtc]);
  }

  async create(definition: ScheduleDefinition): Promise<ScheduleDefinition> {
    return this.transaction(async client => {
      await client.query(`INSERT INTO schedule_definition(project_id,schedule_id,version,current_revision_id,state,watermark_utc) VALUES($1,$2,$3,$4,$5,$6)`,
        [definition.projectId, definition.id, definition.version, definition.currentRevisionId, definition.state, definition.watermarkUtc]);
      await this.appendRevision(client, definition);
      await this.decision(client, definition, "create", definition.revision.reason, definition.revision.createdAtUtc);
      return definition;
    });
  }

  private async load(client: PoolClient, projectId: string, scheduleId: string, lock = false): Promise<ScheduleDefinition | null> {
    const result = await client.query(`SELECT d.version AS head_version,d.state,d.watermark_utc,d.current_revision_id,r.*
      FROM schedule_definition d JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.schedule_id=$2 ${lock ? "FOR UPDATE OF d" : ""}`, [projectId, scheduleId]);
    return result.rows[0] ? rowDefinition(result.rows[0]) : null;
  }

  async get(projectId: string, scheduleId: string): Promise<ScheduleDefinition | null> {
    const client = await this.pool.connect(); try { return await this.load(client, projectId, scheduleId); } finally { client.release(); }
  }

  async listActive(projectId: string): Promise<ScheduleDefinition[]> {
    const result = await this.pool.query(`SELECT d.version AS head_version,d.state,d.watermark_utc,d.current_revision_id,r.*
      FROM schedule_definition d JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.state='active' ORDER BY d.schedule_id LIMIT 101`, [projectId]);
    if (result.rows.length > 100) throw new ScheduleStoreConflict("active schedule page limit exceeded");
    return result.rows.map(rowDefinition);
  }

  async revise(definition: ScheduleDefinition, expectedVersion: number): Promise<ScheduleDefinition> {
    return this.transaction(async client => {
      const current = await this.load(client, definition.projectId, definition.id, true);
      if (!current || current.version !== expectedVersion || definition.version !== expectedVersion + 1 || new Date(definition.watermarkUtc).getTime() < new Date(current.watermarkUtc).getTime() || current.state === "stopped" && definition.state !== "stopped") throw new ScheduleStoreConflict("schedule version, state or watermark conflict");
      const changed = await client.query(`UPDATE schedule_definition SET version=$3,current_revision_id=$4,state=$5,watermark_utc=$6
        WHERE project_id=$1 AND schedule_id=$2 AND version=$7`, [definition.projectId, definition.id, definition.version, definition.currentRevisionId, definition.state, definition.watermarkUtc, expectedVersion]);
      if (changed.rowCount !== 1) throw new ScheduleStoreConflict("schedule version changed");
      await this.appendRevision(client, definition);
      await this.decision(client, definition, "revise", definition.revision.reason, definition.revision.createdAtUtc);
      return definition;
    });
  }

  async getOccurrence(projectId: string, scheduleId: string, plannedAtUtc: string): Promise<Occurrence | null> {
    const result = await this.pool.query("SELECT * FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3", [projectId, scheduleId, plannedAtUtc]);
    return result.rows[0] ? rowOccurrence(result.rows[0]) : null;
  }

  async hasOpenOccurrence(projectId: string, scheduleId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM schedule_occurrence o JOIN task t ON t.project_id=o.project_id AND t.task_id=o.task_id
      WHERE o.project_id=$1 AND o.schedule_id=$2 AND o.state='created' AND t.state NOT IN ('done','cancelled') LIMIT 1`, [projectId, scheduleId]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async listQueued(projectId: string, scheduleId: string): Promise<Occurrence[]> {
    const result = await this.pool.query("SELECT * FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND state='queued' ORDER BY planned_at_utc LIMIT 101", [projectId, scheduleId]);
    if (result.rows.length > 100) throw new ScheduleStoreConflict("queued occurrence page limit exceeded");
    return result.rows.map(rowOccurrence);
  }

  async materialize(definition: ScheduleDefinition, plannedAtUtc: string, observedAtUtc: string, requestedState: Occurrence["state"], reason: string): Promise<Occurrence> {
    return this.transaction(async client => {
      const current = await this.load(client, definition.projectId, definition.id, true);
      if (!current || current.version !== definition.version || current.state !== "active") throw new ScheduleStoreConflict("schedule changed before occurrence reservation");
      const previous = await client.query("SELECT * FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3 FOR UPDATE", [definition.projectId, definition.id, plannedAtUtc]);
      const existing = previous.rows[0] ? rowOccurrence(previous.rows[0]) : null;
      if (existing && existing.state !== "queued") return existing;
      if (existing && requestedState !== "created") return existing;
      if (existing && existing.revisionId !== current.currentRevisionId) throw new ScheduleStoreConflict("queued occurrence needs revision review");
      if (!existing && (Date.parse(plannedAtUtc) <= Date.parse(current.watermarkUtc) || Date.parse(plannedAtUtc) > Date.parse(observedAtUtc))) throw new ScheduleStoreConflict("occurrence is outside current due window");
      if (current.revision.authorization.expiresAtUtc && Date.parse(observedAtUtc) >= Date.parse(current.revision.authorization.expiresAtUtc)) throw new ScheduleStoreConflict("schedule authorization expired");
      const roleIds = [current.revision.authorization.roleId, current.revision.template.owner].filter(value => uuid.test(value));
      if (roleIds.length) {
        const roles = await client.query("SELECT role_id,state FROM role_definition WHERE project_id=$1 AND role_id=ANY($2::uuid[]) FOR SHARE", [definition.projectId, roleIds]);
        if (roles.rows.some(role => role.state === "retired")) throw new ScheduleStoreConflict("retired role cannot authorize or receive scheduled work");
      }
      const overlap = await client.query(`SELECT 1 FROM schedule_occurrence o JOIN task t ON t.project_id=o.project_id AND t.task_id=o.task_id
        WHERE o.project_id=$1 AND o.schedule_id=$2 AND o.planned_at_utc<>$3 AND o.state='created' AND t.state NOT IN ('done','cancelled') LIMIT 1`, [definition.projectId, definition.id, plannedAtUtc]);
      const state: Occurrence["state"] = overlap.rows.length && requestedState === "created" ? current.revision.overlap === "queue" ? "queued" : "skipped" : requestedState;
      const key = `${definition.projectId}:${definition.id}:${plannedAtUtc}`;
      const operationId = deterministicId(`schedule-operation:${key}`);
      const taskId = state === "created" ? deterministicId(`schedule-task:${key}`) : null;
      if (existing) {
        if (state !== "created") return existing;
        await client.query("UPDATE schedule_occurrence SET state='created',task_id=$4,observed_at_utc=$5,reason=$6 WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3", [definition.projectId, definition.id, plannedAtUtc, taskId, observedAtUtc, reason]);
      } else {
        await client.query(`INSERT INTO schedule_occurrence(project_id,schedule_id,schedule_revision_id,planned_at_utc,observed_at_utc,state,task_id,operation_id,reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [definition.projectId, definition.id, definition.currentRevisionId, plannedAtUtc, observedAtUtc, state, taskId, operationId, reason]);
      }
      if (state === "created" && taskId) {
        const template = current.revision.template;
        const content = template.content;
        if (typeof content !== "string" || !content.trim()) throw new ScheduleStoreConflict("schedule Task template has no content");
        const revisionId = deterministicId(`schedule-task-revision:${key}`);
        const documentId = deterministicId(`schedule-task-document:${key}`);
        const documentRevisionId = deterministicId(`schedule-task-document-revision:${key}`);
        const actorId = `schedule:${current.revision.authorization.roleId}`;
        await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
          VALUES($1,$2,$3,1,$4,NULL,'task','draft')`, [definition.projectId, documentId, template.title, documentRevisionId]);
        await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason,media_type,original_name,assets_manifest)
          VALUES($1,$2,$3,$4,'markdown',$5,$6,$7,NULL,$8,'text/markdown',$9,'[]'::jsonb)`, [definition.projectId, documentId, documentRevisionId, content,
          createHash("sha256").update(content).digest("hex"), actorId, observedAtUtc,
          `schedule ${definition.id} at ${plannedAtUtc}`, `${taskId}.md`]);
        await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
          VALUES($1,$2,1,$3,$4,$5,$6,'todo',NULL,$7,$8)`, [definition.projectId, taskId, revisionId, template.title, template.acceptance, template.owner, documentId, documentRevisionId]);
        await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
          VALUES($1,$2,$3,1,$4,$5,$6,'todo',NULL,$7,$8,NULL,$9,$10,$11)`, [definition.projectId, taskId, revisionId, template.title, template.acceptance, template.owner, documentId, documentRevisionId, actorId, `schedule ${definition.id} at ${plannedAtUtc}`, observedAtUtc]);
        await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,evidence,stop_condition,created_at)
          VALUES($1,$2,$3,NULL,$4,false,$5,'',$6)`, [definition.projectId, taskId, revisionId, template.owner, `schedule ${definition.id} revision ${definition.currentRevisionId}`, observedAtUtc]);
        const receipt = { status: "applied", operationId, entityId: taskId, version: 1 };
        const hash = createHash("sha256").update(key).digest("hex");
        await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
          VALUES($1,$2,$3,$4,'schedule.occurrence', $5::jsonb,$6)`, [definition.projectId, operationId, actorId, hash, JSON.stringify(receipt), observedAtUtc]);
        await client.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at)
          VALUES($1,$2,$3,$4,'schedule.task.todo',$5,1,$6)`, [definition.projectId, deterministicId(`schedule-outbox:${key}`), operationId, `schedule:${definition.id}:${plannedAtUtc}`, taskId, observedAtUtc]);
      }
      const row = await client.query("SELECT * FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3", [definition.projectId, definition.id, plannedAtUtc]);
      return rowOccurrence(row.rows[0]);
    }).catch(async error => {
      if (error instanceof ScheduleStoreConflict) throw error;
      const observed = await this.getOccurrence(definition.projectId, definition.id, plannedAtUtc).catch(() => null);
      if (observed) return observed;
      throw new ScheduleReservationUnknown(definition.projectId, definition.id, plannedAtUtc);
    });
  }

  async advanceWatermark(projectId: string, scheduleId: string, expectedVersion: number, throughUtc: string, reason: string): Promise<void> {
    await this.transaction(async client => {
      const current = await this.load(client, projectId, scheduleId, true);
      if (!current || current.version !== expectedVersion || current.state !== "active") throw new ScheduleStoreConflict("schedule changed before watermark advancement");
      if (new Date(throughUtc).getTime() <= new Date(current.watermarkUtc).getTime()) return;
      await client.query("UPDATE schedule_definition SET watermark_utc=$3 WHERE project_id=$1 AND schedule_id=$2", [projectId, scheduleId, throughUtc]);
      await this.decision(client, current, "watermark", reason, throughUtc);
    });
  }
}
