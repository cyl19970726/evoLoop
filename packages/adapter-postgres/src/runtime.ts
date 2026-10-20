import type { PoolClient, QueryResultRow } from "pg";
import type { RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const limit = 10_000;
const bounded = <T>(items: T[], label: string): T[] => {
  if (items.length > limit) throw new DomainError("RESULT_TOO_LARGE", `${label} exceeds ${limit}`);
  return items;
};
const session = (r: QueryResultRow): RuntimeSessionRecord => ({
  projectId: r.project_id, id: r.session_id, roleId: r.role_id, cwd: r.cwd,
  authorizationScope: r.authorization_scope, model: r.model, sandbox: r.sandbox,
  approvalPolicy: r.approval_policy, state: r.state, version: r.version,
  nativeThreadId: r.native_thread_id, nativeSessionId: r.native_session_id,
  operationId: r.operation_id, actorId: r.actor_id,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const run = (r: QueryResultRow): RuntimeRunRecord => ({
  projectId: r.project_id, id: r.run_id, taskId: r.task_id,
  taskRevisionId: r.task_revision_id, basisSetId: r.basis_set_id,
  sessionId: r.session_id, operationId: r.operation_id,
  input: r.input, inputHash: r.input_hash, state: r.state, version: r.version,
  nativeTurnId: r.native_turn_id, interruptRequested: r.interrupt_requested,
  resultSummary: r.result_summary, actorId: r.actor_id,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const event = (r: QueryResultRow): RuntimeRecordEvent => ({
  projectId: r.project_id, id: r.event_id, runId: r.run_id, sessionId: r.session_id,
  kind: r.kind, detail: r.detail, nativeTurnId: r.native_turn_id,
  cursor: r.cursor, itemsDigest: r.items_digest,
  actorId: r.actor_id, createdAt: iso(r.created_at),
});

export class PgRuntimeStore {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  private scope(projectId: string): void {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "runtime record belongs to another project");
  }
  async getRuntimeSession(id: string): Promise<RuntimeSessionRecord | null> {
    const result = await this.client.query("SELECT * FROM runtime_session WHERE project_id=$1 AND session_id=$2", [this.projectId, id]);
    return result.rows[0] ? session(result.rows[0]) : null;
  }
  async listRuntimeSessions(): Promise<RuntimeSessionRecord[]> {
    const result = await this.client.query("SELECT * FROM runtime_session WHERE project_id=$1 ORDER BY created_at,session_id LIMIT $2", [this.projectId, limit + 1]);
    return bounded(result.rows.map(session), "runtime sessions");
  }
  async getRuntimeRun(id: string): Promise<RuntimeRunRecord | null> {
    const result = await this.client.query("SELECT * FROM runtime_run WHERE project_id=$1 AND run_id=$2", [this.projectId, id]);
    return result.rows[0] ? run(result.rows[0]) : null;
  }
  async listRuntimeRuns(taskId?: string): Promise<RuntimeRunRecord[]> {
    const result = await this.client.query("SELECT * FROM runtime_run WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2::uuid) ORDER BY created_at,run_id LIMIT $3", [this.projectId, taskId ?? null, limit + 1]);
    return bounded(result.rows.map(run), "runtime runs");
  }
  async listRuntimeEvents(runId: string): Promise<RuntimeRecordEvent[]> {
    const result = await this.client.query("SELECT * FROM runtime_record_event WHERE project_id=$1 AND run_id=$2 ORDER BY sequence LIMIT $3", [this.projectId, runId, limit + 1]);
    return bounded(result.rows.map(event), "runtime events");
  }
  async listRuntimeSessionEvents(sessionId: string): Promise<RuntimeRecordEvent[]> {
    const result = await this.client.query("SELECT * FROM runtime_record_event WHERE project_id=$1 AND session_id=$2 ORDER BY sequence LIMIT $3", [this.projectId, sessionId, limit + 1]);
    return bounded(result.rows.map(event), "runtime session events");
  }
  async insertRuntimeSession(item: RuntimeSessionRecord): Promise<void> {
    this.scope(item.projectId);
    await this.client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [item.projectId,item.id,item.roleId,item.cwd,item.authorizationScope,item.model,item.sandbox,item.approvalPolicy,item.state,item.version,item.nativeThreadId,item.nativeSessionId,item.operationId,item.actorId,item.createdAt,item.updatedAt]);
  }
  async updateRuntimeSession(item: RuntimeSessionRecord, expectedVersion: number): Promise<void> {
    this.scope(item.projectId);
    const result = await this.client.query(`UPDATE runtime_session SET state=$3,version=$4,native_thread_id=$5,native_session_id=$6,updated_at=$7
      WHERE project_id=$1 AND session_id=$2 AND version=$8`,
      [item.projectId,item.id,item.state,item.version,item.nativeThreadId,item.nativeSessionId,item.updatedAt,expectedVersion]);
    if (!result.rowCount) throw new DomainError("VERSION_CONFLICT", "runtime session version changed", (await this.getRuntimeSession(item.id))?.version);
  }
  async insertRuntimeRun(item: RuntimeRunRecord): Promise<void> {
    this.scope(item.projectId);
    await this.client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,interrupt_requested,result_summary,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [item.projectId,item.id,item.taskId,item.taskRevisionId,item.basisSetId,item.sessionId,item.operationId,item.input,item.inputHash,item.state,item.version,item.nativeTurnId,item.interruptRequested,item.resultSummary,item.actorId,item.createdAt,item.updatedAt]);
  }
  async updateRuntimeRun(item: RuntimeRunRecord, expectedVersion: number): Promise<void> {
    this.scope(item.projectId);
    const result = await this.client.query(`UPDATE runtime_run SET state=$3,version=$4,native_turn_id=$5,interrupt_requested=$6,result_summary=$7,updated_at=$8
      WHERE project_id=$1 AND run_id=$2 AND version=$9`,
      [item.projectId,item.id,item.state,item.version,item.nativeTurnId,item.interruptRequested,item.resultSummary,item.updatedAt,expectedVersion]);
    if (!result.rowCount) throw new DomainError("VERSION_CONFLICT", "runtime run version changed", (await this.getRuntimeRun(item.id))?.version);
  }
  async appendRuntimeEvent(item: RuntimeRecordEvent): Promise<void> {
    this.scope(item.projectId);
    await this.client.query(`INSERT INTO runtime_record_event(project_id,event_id,run_id,session_id,kind,detail,native_turn_id,cursor,items_digest,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [item.projectId,item.id,item.runId,item.sessionId,item.kind,item.detail,item.nativeTurnId,item.cursor,item.itemsDigest,item.actorId,item.createdAt]);
  }
}
