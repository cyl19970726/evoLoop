import type { PoolClient } from "pg";
import type { Occurrence, ScheduleDefinition, ScheduleRevision, SchedulingTransaction } from "@evoloop/contracts/scheduling";
import { DomainError } from "@evoloop/contracts/ports";
import { rowDefinition, rowOccurrence, rowRevision } from "./scheduling-rows.js";

const maxRows = 1000;
const bounded = <T>(rows: T[], label: string): T[] => {
  if (rows.length > maxRows) throw new DomainError("RESULT_TOO_LARGE", `${label} exceeds ${maxRows}`);
  return rows;
};

/** Same client and project transaction as the common operation journal. */
export class PgSchedulingQueries implements SchedulingTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async getSchedule(id: string): Promise<ScheduleDefinition | null> {
    const result = await this.client.query(`SELECT d.version AS head_version,d.state,d.watermark_utc,d.current_revision_id,r.*
      FROM schedule_definition d JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.schedule_id=$2`, [this.projectId, id]);
    return result.rows[0] ? rowDefinition(result.rows[0]) : null;
  }
  async listSchedules(): Promise<ScheduleDefinition[]> {
    const result = await this.client.query(`SELECT d.version AS head_version,d.state,d.watermark_utc,d.current_revision_id,r.*
      FROM schedule_definition d JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 ORDER BY d.schedule_id LIMIT $2`, [this.projectId, maxRows + 1]);
    return bounded(result.rows.map(rowDefinition), "schedules");
  }
  async listScheduleRevisions(id: string): Promise<ScheduleRevision[]> {
    const result = await this.client.query("SELECT * FROM schedule_revision WHERE project_id=$1 AND schedule_id=$2 ORDER BY version LIMIT $3", [this.projectId, id, maxRows + 1]);
    return bounded(result.rows.map(rowRevision), "schedule revisions");
  }
  async listOccurrences(id: string): Promise<Occurrence[]> {
    const result = await this.client.query("SELECT * FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 ORDER BY planned_at_utc LIMIT $3", [this.projectId, id, maxRows + 1]);
    return bounded(result.rows.map(rowOccurrence), "schedule occurrences");
  }
  private async appendRevision(value: ScheduleDefinition): Promise<void> {
    const r = value.revision;
    await this.client.query(`INSERT INTO schedule_revision(project_id,schedule_id,revision_id,version,timezone,rule,misfire,overlap_policy,task_template,authorization_scope,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
      [this.projectId, value.id, r.id, r.version, r.timezone, JSON.stringify(r.rule), JSON.stringify(r.misfire), r.overlap,
        JSON.stringify(r.template), JSON.stringify(r.authorization), r.actorId, r.reason, r.createdAtUtc]);
  }
  private async appendDecision(value: ScheduleDefinition, kind: "create" | "revise"): Promise<void> {
    await this.client.query(`INSERT INTO schedule_decision(project_id,decision_id,schedule_id,schedule_revision_id,kind,actor_id,reason,observed_at_utc)
      VALUES($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7)`, [this.projectId, value.id,
      value.currentRevisionId, kind, value.revision.actorId, value.revision.reason, value.revision.createdAtUtc]);
  }
  async insertSchedule(value: ScheduleDefinition): Promise<void> {
    if (value.projectId !== this.projectId || value.revision.projectId !== this.projectId || value.version !== 1) throw new DomainError("INVALID_SCHEDULE", "schedule scope or version mismatch");
    await this.client.query("INSERT INTO schedule_definition(project_id,schedule_id,version,current_revision_id,state,watermark_utc) VALUES($1,$2,$3,$4,$5,$6)",
      [this.projectId, value.id, value.version, value.currentRevisionId, value.state, value.watermarkUtc]);
    await this.appendRevision(value);
    await this.appendDecision(value, "create");
  }
  async updateSchedule(value: ScheduleDefinition, expectedVersion: number): Promise<void> {
    if (value.projectId !== this.projectId || value.revision.projectId !== this.projectId || value.version !== expectedVersion + 1) throw new DomainError("INVALID_SCHEDULE", "schedule scope or version mismatch");
    const current = await this.getSchedule(value.id);
    if (!current || current.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "schedule version changed", current?.version);
    if (Date.parse(value.watermarkUtc) < Date.parse(current.watermarkUtc) || current.state === "stopped" && value.state !== "stopped") throw new DomainError("INVALID_SCHEDULE", "watermark or stopped state cannot move backward");
    const changed = await this.client.query(`UPDATE schedule_definition SET version=$3,current_revision_id=$4,state=$5,watermark_utc=$6
      WHERE project_id=$1 AND schedule_id=$2 AND version=$7`, [this.projectId, value.id, value.version, value.currentRevisionId, value.state, value.watermarkUtc, expectedVersion]);
    if (!changed.rowCount) throw new DomainError("VERSION_CONFLICT", "schedule version changed", (await this.getSchedule(value.id))?.version);
    await this.appendRevision(value);
    await this.appendDecision(value, "revise");
  }
}
