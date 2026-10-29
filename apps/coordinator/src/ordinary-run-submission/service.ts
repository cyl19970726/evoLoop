import type { Pool } from "pg";
import { createHash } from "node:crypto";
import type { Operation, Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { Delivery } from "@evoloop/contracts/workflow";
import type { OrdinaryRunSubmissionCommand, OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { DomainError, type UnitOfWork } from "@evoloop/contracts/ports";
import { submitOrdinaryRun } from "@evoloop/core/ordinary-run-submission";
import { PgOrdinaryRunSubmissionStore } from "@evoloop/adapter-postgres/ordinary-run-submission";

export class OrdinaryRunSubmissionService {
  constructor(private readonly pool: Pool, private readonly uow: UnitOfWork,
    private readonly canWrite: () => boolean = () => true) {}

  private requireLease(): void {
    if (!this.canWrite()) throw new DomainError("LEASE_LOST", "Coordinator lease lost before ordinary submission write");
  }

  private async transaction<T>(projectId: string, action: (store: PgOrdinaryRunSubmissionStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false, destroy = false;
    try {
      await client.query("BEGIN"); open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
      this.requireLease(); // The pool and project lock may have waited after the HTTP or pump check.
      const value = await action(new PgOrdinaryRunSubmissionStore(client, projectId));
      this.requireLease(); // A known loss before COMMIT rolls back this transaction.
      try { await client.query("COMMIT"); open = false; }
      catch (error) { destroy = true; throw error; }
      return value;
    } catch (error) {
      if (open && !destroy) try { await client.query("ROLLBACK"); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }

  async submit(principal: Principal, command: OrdinaryRunSubmissionCommand): Promise<OrdinaryRunSubmissionRecord> {
    return this.transaction(command.projectId, store => submitOrdinaryRun(store, principal, command,
      new Date().toISOString(), {hash: value => createHash("sha256").update(value).digest("hex")}));
  }

  async getByOperation(principal: Principal, projectId: string, operationId: string): Promise<OrdinaryRunSubmissionRecord | null> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read permission is required");
    return this.withStore(projectId, async store => {
      const record = await store.getByOperationId(operationId);
      if (record && record.submittedBy !== principal.actorId && !principal.permissions.includes("review"))
        throw new DomainError("FORBIDDEN", "Only the signer or a reviewer can read this submission");
      return record;
    });
  }

  async getByRun(principal: Principal, projectId: string, runId: string): Promise<OrdinaryRunSubmissionRecord | null> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read permission is required");
    return this.withStore(projectId, async store => {
      const record = await store.get(runId);
      if (!record && !await store.getRun(runId)) throw new DomainError("NOT_FOUND", "Run not found");
      if (record && record.submittedBy !== principal.actorId && !principal.permissions.includes("review"))
        throw new DomainError("FORBIDDEN", "Only the signer or a reviewer can read this submission");
      return record;
    });
  }

  private async withStore<T>(projectId: string, action: (store: PgOrdinaryRunSubmissionStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await action(new PgOrdinaryRunSubmissionStore(client, projectId)); }
    finally { client.release(); }
  }

  async readSubmission(projectId: string, runId: string): Promise<OrdinaryRunSubmissionRecord | null> {
    return this.withStore(projectId, store => store.get(runId));
  }

  async readRun(projectId: string, runId: string): Promise<RuntimeRunRecord | null> {
    return this.withStore(projectId, store => store.getRun(runId));
  }

  /** Internal recovery read, confined to the immutable submission's reserved operation. */
  async readDeliveryOperation(submission: OrdinaryRunSubmissionRecord): Promise<Operation | null> {
    const fixed = await this.readSubmission(submission.projectId, submission.runId);
    if (!fixed || fixed.id !== submission.id || fixed.operationId !== submission.operationId ||
      fixed.deliveryOperationId !== submission.deliveryOperationId ||
      fixed.submittedBy !== submission.submittedBy || fixed.commandHash !== submission.commandHash ||
      fixed.deliveryCommandHash !== submission.deliveryCommandHash)
      throw new DomainError("SUBMISSION_CONFLICT", "Original Run submission changed during recovery");
    return this.uow.read(submission.projectId, reader => reader.getOperation(submission.deliveryOperationId));
  }

  async updateSubmission(next: OrdinaryRunSubmissionRecord, expectedVersion: number): Promise<boolean> {
    return this.transaction(next.projectId, async store => {
      const actual = await store.get(next.runId);
      if (!actual || actual.version !== expectedVersion) return false;
      await store.update(next, expectedVersion);
      return true;
    });
  }

  async readDelivery(projectId: string, deliveryId: string): Promise<Delivery | null> {
    return this.uow.read(projectId, reader => reader.getDelivery(deliveryId));
  }

  async listUnsettled(projectId: string, limit = 100, after?: {createdAtUtc:string;runId:string}): Promise<OrdinaryRunSubmissionRecord[]> {
    return this.withStore(projectId, store => store.listUnsettled(limit, after));
  }

  async listUnsettledProjects(): Promise<string[]> {
    const rows = await this.pool.query("SELECT DISTINCT project_id FROM ordinary_run_submission WHERE state IN ('submitted','blocked','sealing','unknown') ORDER BY project_id");
    return rows.rows.map(row => row.project_id as string);
  }

  async getFixedRecipient(projectId: string, runId: string): Promise<string | null> {
    return this.withStore(projectId, store => store.getFixedRecipient(runId));
  }
}

/** The callback runs after the underlying PostgreSQL transaction has its project lock. */
export function leaseCheckedUnitOfWork(uow: UnitOfWork, canWrite: () => boolean): UnitOfWork {
  const check = () => { if (!canWrite()) throw new DomainError("LEASE_LOST", "Coordinator lease lost before Delivery commit"); };
  return {
    read: (projectId, action) => uow.read(projectId, action),
    transaction: (projectId, action) => uow.transaction(projectId, async tx => {
      check();
      const result = await action(tx);
      check();
      return result;
    }),
  };
}
