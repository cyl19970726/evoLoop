import type { PoolClient, QueryResultRow } from 'pg';
import type { NativeObservationRecord, NativeObservationTransaction } from '@evoloop/contracts/native-observation';
import { DomainError } from '@evoloop/contracts/ports';
const iso = (x: Date | string): string => x instanceof Date ? x.toISOString() : x;
const map = (r: QueryResultRow): NativeObservationRecord => ({ ...r.projection,
  projectId: r.project_id, sessionId: r.session_id, threadId: r.thread_id, connectionId: r.connection_id,
  version: r.version, observedAt: iso(r.observed_at), lastEventAt: iso(r.last_event_at),
  freshness: r.freshness, staleReason: r.stale_reason });
export class PgNativeObservation implements NativeObservationTransaction {
  constructor(private readonly client: PoolClient, private readonly scope: string) {}
  private assert(projectId: string): void { if (projectId !== this.scope) throw new DomainError('PROJECT_SCOPE','Native observation belongs to another project'); }
  async get(projectId: string, sessionId: string): Promise<NativeObservationRecord | null> {
    this.assert(projectId);
    const r = await this.client.query('SELECT * FROM session_native_observation WHERE project_id=$1 AND session_id=$2',[projectId,sessionId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async upsert(value: NativeObservationRecord, expectedVersion: number | null): Promise<void> {
    this.assert(value.projectId);
    const projection = { status:value.status,currentTurn:value.currentTurn,items:value.items,plan:value.plan,diff:value.diff,usage:value.usage };
    const r = expectedVersion === null
      ? await this.client.query(`INSERT INTO session_native_observation(project_id,session_id,thread_id,connection_id,version,observed_at,last_event_at,freshness,stale_reason,projection)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING version`,
          [value.projectId,value.sessionId,value.threadId,value.connectionId,value.version,value.observedAt,value.lastEventAt,value.freshness,value.staleReason,JSON.stringify(projection)])
      : await this.client.query(`UPDATE session_native_observation SET thread_id=$3,connection_id=$4,version=$5,observed_at=$6,last_event_at=$7,
          freshness=$8,stale_reason=$9,projection=$10::jsonb WHERE project_id=$1 AND session_id=$2 AND version=$11 RETURNING version`,
          [value.projectId,value.sessionId,value.threadId,value.connectionId,value.version,value.observedAt,value.lastEventAt,value.freshness,value.staleReason,JSON.stringify(projection),expectedVersion]);
    if (!r.rowCount) throw new DomainError('VERSION_CONFLICT','Native observation changed',(await this.get(value.projectId,value.sessionId))?.version);
  }
  async staleConnection(projectId: string, connectionId: string, reason: string, at: string): Promise<number> {
    this.assert(projectId);
    const r = await this.client.query(`UPDATE session_native_observation SET freshness='stale',stale_reason=$3,version=version+1,observed_at=$4
      WHERE project_id=$1 AND connection_id=$2 AND freshness='live'`,[projectId,connectionId,reason,at]);
    return r.rowCount ?? 0;
  }
  async invalidateConnections(projectId: string, currentConnectionId: string, at: string): Promise<number> {
    this.assert(projectId);
    const r = await this.client.query(`UPDATE session_native_observation SET freshness='stale',stale_reason='disconnected',version=version+1,observed_at=$3
      WHERE project_id=$1 AND connection_id<>$2 AND freshness='live'`,[projectId,currentConnectionId,at]);
    return r.rowCount ?? 0;
  }
}
