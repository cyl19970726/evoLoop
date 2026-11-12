import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { DecisionRequest, DecisionRequestTransaction } from "@evoloop/contracts/decision-requests";

const iso = (v: Date | string | null): string | null => v === null ? null : v instanceof Date ? v.toISOString() : v;
const requestOf = (r: QueryResultRow): DecisionRequest => ({ projectId: r.project_id, id: r.request_id, requestedBy: r.requested_by, requestedFrom: r.requested_from,
  taskId: r.task_id, subject: r.subject, question: r.question, options: r.options, state: r.state, answer: r.answer, answerReason: r.answer_reason,
  answeredBy: r.answered_by, answeredAt: iso(r.answered_at), withdrawnReason: r.withdrawn_reason, version: r.version, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });

export class PgDecisionRequests implements DecisionRequestTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async getDecisionRequest(id: string): Promise<DecisionRequest | null> {
    const r = await this.client.query("SELECT * FROM decision_request WHERE project_id=$1 AND request_id=$2", [this.projectId, id]);
    return r.rows[0] ? requestOf(r.rows[0]) : null;
  }
  async insertDecisionRequest(v: DecisionRequest): Promise<void> {
    await this.client.query(`INSERT INTO decision_request(project_id,request_id,requested_by,requested_from,task_id,subject,question,options,state,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'open',1,$9,$9)`, [this.projectId, v.id, v.requestedBy, v.requestedFrom, v.taskId, v.subject, v.question, JSON.stringify(v.options), v.createdAt]);
  }
  async updateDecisionRequest(v: DecisionRequest, expectedVersion: number): Promise<void> {
    const r = await this.client.query(`UPDATE decision_request SET state=$4,answer=$5,answer_reason=$6,answered_by=$7,answered_at=$8,withdrawn_reason=$9,version=$10,updated_at=$11
      WHERE project_id=$1 AND request_id=$2 AND version=$3`, [this.projectId, v.id, expectedVersion, v.state, v.answer, v.answerReason, v.answeredBy, v.answeredAt, v.withdrawnReason, v.version, v.updatedAt]);
    if (!r.rowCount) throw new DomainError("VERSION_CONFLICT", "The decision request changed");
  }
  async listOpenDecisionRequests(requestedFrom: string): Promise<DecisionRequest[]> {
    return (await this.client.query("SELECT * FROM decision_request WHERE project_id=$1 AND requested_from=$2 AND state='open' ORDER BY created_at,request_id", [this.projectId, requestedFrom])).rows.map(requestOf);
  }
}
