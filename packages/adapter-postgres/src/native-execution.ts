import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { NativeExecutionEnvironment, NativeExecutionOwner, NativeExecutionStartupPermit,
  NativeExecutionTransaction, NativeExecutionTransition } from "@evoloop/contracts/native-execution";

const hash = /^[a-f0-9]{64}$/;
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const epoch = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new DomainError("NATIVE_EPOCH_INVALID", "Native environment epoch is invalid");
  return number;
};
const nonempty = (value: string, label: string, limit = 4000): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw new DomainError("NATIVE_CONTROL_INVALID", `${label} is required and bounded`);
  return trimmed;
};
const mapped = (r: QueryResultRow): NativeExecutionEnvironment => ({
  epoch: epoch(r.epoch), mode: r.mode, previousMode: r.previous_mode,
  targetPurpose: r.target_purpose, targetProjectId: r.target_project_id,
  targetSessionId: r.target_session_id, targetThreadId: r.target_thread_id,
  targetMessageId: r.target_message_id, operationId: r.operation_id,
  ownerNonce: r.owner_nonce, ownerPid: r.owner_pid, ownerStartIdentity: r.owner_start_identity,
  expectedPolicyHash: r.expected_policy_hash, observedPolicyHash: r.observed_policy_hash,
  oldOwnerExitEvidenceRef: r.old_owner_exit_evidence_ref,
  spawnedOwnerRecordedAt: iso(r.spawned_owner_recorded_at),
  verificationEvidenceRef: r.verification_evidence_ref,
  nativeAttemptedAt: iso(r.native_attempted_at), verifiedAt: iso(r.verified_at),
  reason: r.reason, updatedAt: iso(r.updated_at)!,
});
const changed = (rows: QueryResultRow[]): NativeExecutionEnvironment => {
  if (!rows[0]) throw new DomainError("NATIVE_CONTROL_CONFLICT", "Native environment changed; read the current epoch");
  return mapped(rows[0]);
};

/** Use the caller's existing PoolClient/transaction. Switch mutations touch only this one row. */
export class PgNativeExecution implements NativeExecutionTransaction {
  constructor(private readonly client: PoolClient) {}

  async getNativeExecutionEnvironment(): Promise<NativeExecutionEnvironment | null> {
    const result = await this.client.query("SELECT * FROM native_execution_environment WHERE singleton=true");
    return result.rows[0] ? mapped(result.rows[0]) : null;
  }

  async adoptUnknown(reason: string): Promise<NativeExecutionEnvironment> {
    const result = await this.client.query(`INSERT INTO native_execution_environment(singleton,epoch,mode,reason,updated_at)
      VALUES(true,1,'unknown',$1,now()) ON CONFLICT(singleton) DO NOTHING RETURNING *`,
      [nonempty(reason, "adoption reason")]);
    if (!result.rows[0]) throw new DomainError("NATIVE_CONTROL_EXISTS", "Native environment was already adopted");
    return mapped(result.rows[0]);
  }

  async beginTransition(input: NativeExecutionTransition): Promise<NativeExecutionEnvironment> {
    const expectedEpoch = epoch(input.expectedEpoch);
    if (!hash.test(input.expectedPolicyHash) || (input.purpose === "message") !== (input.messageId !== null))
      throw new DomainError("NATIVE_CONTROL_INVALID", "Transition requires exact policy and message target");
    const result = await this.client.query(`UPDATE native_execution_environment SET epoch=epoch+1,
      previous_mode=mode,previous_target=jsonb_build_object('purpose',target_purpose,'projectId',target_project_id,
        'sessionId',target_session_id,'threadId',target_thread_id,'messageId',target_message_id,
        'expectedHash',expected_policy_hash),mode='transition',target_purpose=$2,target_project_id=$3,target_session_id=$4,
      target_thread_id=$5,target_message_id=$6,operation_id=$7,expected_policy_hash=$8,
      old_owner_exit_evidence_ref=NULL,spawned_owner_recorded_at=NULL,native_attempted_at=NULL,
      reason=$9,updated_at=now() WHERE singleton=true AND epoch=$1 AND mode<>'transition' RETURNING *`,
      [expectedEpoch,input.purpose,input.projectId,input.sessionId,nonempty(input.nativeThreadId,"native Thread ID",240),
        input.messageId,input.operationId,input.expectedPolicyHash,nonempty(input.reason,"transition reason")]);
    return changed(result.rows);
  }

  async markNativeAttempt(expectedEpoch: number, operationId: string): Promise<NativeExecutionEnvironment> {
    const result = await this.client.query(`UPDATE native_execution_environment SET native_attempted_at=now(),updated_at=now()
      WHERE singleton=true AND epoch=$1 AND mode='transition' AND operation_id=$2 AND native_attempted_at IS NULL RETURNING *`,
      [epoch(expectedEpoch),operationId]);
    return changed(result.rows);
  }

  async recordOldOwnerExit(expectedEpoch: number, operationId: string, evidenceRef: string): Promise<NativeExecutionEnvironment> {
    const result = await this.client.query(`UPDATE native_execution_environment SET old_owner_exit_evidence_ref=$3,updated_at=now()
      WHERE singleton=true AND epoch=$1 AND mode='transition' AND operation_id=$2
        AND native_attempted_at IS NOT NULL AND old_owner_exit_evidence_ref IS NULL RETURNING *`,
      [epoch(expectedEpoch),operationId,nonempty(evidenceRef,"old owner exit evidence")]);
    return changed(result.rows);
  }

  async recordSpawnedOwner(expectedEpoch: number, operationId: string, owner: NativeExecutionOwner): Promise<NativeExecutionEnvironment> {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
      throw new DomainError("NATIVE_CONTROL_INVALID", "Spawned owner PID is invalid");
    const result = await this.client.query(`UPDATE native_execution_environment SET
      owner_nonce=$3,owner_pid=$4,owner_start_identity=$5,spawned_owner_recorded_at=now(),updated_at=now()
      WHERE singleton=true AND epoch=$1 AND mode='transition' AND operation_id=$2
        AND native_attempted_at IS NOT NULL AND old_owner_exit_evidence_ref IS NOT NULL
        AND spawned_owner_recorded_at IS NULL RETURNING *`,
      [epoch(expectedEpoch),operationId,owner.nonce,owner.pid,nonempty(owner.startIdentity,"owner start identity",240)]);
    return changed(result.rows);
  }

  async verifyEnvironment(expectedEpoch: number, operationId: string, owner: NativeExecutionOwner,
    observedPolicyHash: string, evidenceRef: string, verifiedTargetPolicyHash: string): Promise<NativeExecutionEnvironment> {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !hash.test(observedPolicyHash) || !hash.test(verifiedTargetPolicyHash))
      throw new DomainError("NATIVE_CONTROL_INVALID", "Verified owner and policy are required");
    const result = await this.client.query(`UPDATE native_execution_environment SET
      mode=CASE target_purpose WHEN 'message' THEN 'message_verified' ELSE 'business_verified' END,
      observed_policy_hash=$6,
      verified_at=now(),verification_evidence_ref=$7,reason='Verified original native environment',updated_at=now()
      WHERE singleton=true AND epoch=$1 AND mode='transition' AND operation_id=$2
        AND native_attempted_at IS NOT NULL AND old_owner_exit_evidence_ref IS NOT NULL
        AND spawned_owner_recorded_at IS NOT NULL
        AND owner_nonce=$3 AND owner_pid=$4 AND owner_start_identity=$5
        AND expected_policy_hash=$8 RETURNING *`,
      [epoch(expectedEpoch),operationId,owner.nonce,owner.pid,
        nonempty(owner.startIdentity,"owner start identity",240),observedPolicyHash,
        nonempty(evidenceRef,"verification evidence"),verifiedTargetPolicyHash]);
    return changed(result.rows);
  }

  async markEnvironmentUnknown(expectedEpoch: number, reason: string): Promise<NativeExecutionEnvironment> {
    const result = await this.client.query(`UPDATE native_execution_environment SET mode='unknown',reason=$2,updated_at=now()
      WHERE singleton=true AND epoch=$1 RETURNING *`,[epoch(expectedEpoch),nonempty(reason,"unknown reason")]);
    return changed(result.rows);
  }

  async cancelPreparation(expectedEpoch: number, operationId: string, reason: string): Promise<NativeExecutionEnvironment> {
    const result = await this.client.query(`UPDATE native_execution_environment SET
      mode=previous_mode,previous_mode=NULL,target_purpose=previous_target->>'purpose',
      target_project_id=(previous_target->>'projectId')::uuid,target_session_id=(previous_target->>'sessionId')::uuid,
      target_thread_id=previous_target->>'threadId',target_message_id=(previous_target->>'messageId')::uuid,
      operation_id=NULL,expected_policy_hash=previous_target->>'expectedHash',previous_target=NULL,
      reason=$3,updated_at=now() WHERE singleton=true AND epoch=$1 AND mode='transition'
        AND operation_id=$2 AND previous_mode IS NOT NULL AND native_attempted_at IS NULL
        AND old_owner_exit_evidence_ref IS NULL RETURNING *`,
      [epoch(expectedEpoch),operationId,nonempty(reason,"cancellation reason")]);
    return changed(result.rows);
  }

  async permitNativeStartup(input: NativeExecutionStartupPermit): Promise<void> {
    const result = await this.client.query("SELECT * FROM native_execution_environment WHERE singleton=true FOR UPDATE");
    if (!result.rows[0]) return; // legacy compatibility only; never verified
    const control = mapped(result.rows[0]);
    if (control.epoch !== epoch(input.expectedEpoch) ||
      (input.kind === "message" ? control.mode !== "message_verified" ||
        control.targetProjectId !== input.projectId || control.targetSessionId !== input.sessionId ||
        control.targetMessageId !== input.messageId : control.mode !== "business_verified"))
      throw new DomainError("NATIVE_ENVIRONMENT_BLOCKED", "Native environment does not permit this original startup");
    if (input.kind === "message" && !input.messageId)
      throw new DomainError("NATIVE_CONTROL_INVALID", "Original message ID is required");
    const claim = JSON.stringify({kind:input.kind,epoch:control.epoch,projectId:input.projectId,
      sessionId:input.sessionId,operationId:input.operationId,...(input.messageId ? {messageId:input.messageId} : {})});
    await this.client.query("SELECT set_config('evoloop.native_execution_startup',$1,true)",[claim]);
  }
}
