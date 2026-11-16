import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HubError } from "./errors.js";
import { generateSigningKey, type SigningKey } from "./identity.js";
import { hashToken, newToken } from "./ids.js";
import type { HubStore } from "./store.js";

export type MachineRecord = {
  machineId: string;
  name: string;
  state: "pending" | "active" | "removed";
  publicKey: string | null;
  allowedRoots: string[];
  hostLabel: string | null;
  createdAt: string;
  joinedAt: string | null;
  removedAt: string | null;
  lastSeenAt: string | null;
};

type Row = {
  machine_id: string; name: string; state: "pending" | "active" | "removed"; public_key: string | null; allowed_roots: string[];
  host_label: string | null; created_at: Date; joined_at: Date | null; removed_at: Date | null; last_seen_at: Date | null;
};
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
const machineOf = (row: Row): MachineRecord => ({
  machineId: row.machine_id, name: row.name, state: row.state, publicKey: row.public_key, allowedRoots: row.allowed_roots, hostLabel: row.host_label,
  createdAt: row.created_at.toISOString(), joinedAt: iso(row.joined_at), removedAt: iso(row.removed_at), lastSeenAt: iso(row.last_seen_at),
});

export const JOIN_CODE_TTL_MS = 10 * 60 * 1000;

/** Machines and the Hub signing key: the persistent half. The live connections are in ConnectionRegistry. */
export class MachineStore {
  private signingKey: SigningKey | null = null;
  constructor(private readonly pool: Pool) {}

  /** The active signing key; created on first use. Another Hub process racing to create it loses on the unique index and reads the winner's. */
  async activeSigningKey(at: Date = new Date()): Promise<SigningKey> {
    if (this.signingKey) return this.signingKey;
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await this.pool.query<{ kid: string; public_key: string; private_key: string }>(
        "SELECT kid, public_key, private_key FROM hub_signing_key WHERE active");
      const row = found.rows[0];
      if (row) return (this.signingKey = { kid: row.kid, publicKey: row.public_key, privateKey: row.private_key });
      const fresh = generateSigningKey();
      try {
        await this.pool.query("INSERT INTO hub_signing_key(kid, public_key, private_key, active, created_at) VALUES ($1,$2,$3,true,$4)",
          [fresh.kid, fresh.publicKey, fresh.privateKey, at]);
        return (this.signingKey = fresh);
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
    throw new HubError(500, "SIGNING_KEY_UNAVAILABLE", "The Hub signing key could not be read.");
  }

  /** The public halves of every Hub signing key, newest first, for a machine to save when it joins. */
  async publicKeys(): Promise<Array<{ kid: string; publicKey: string }>> {
    const result = await this.pool.query<{ kid: string; public_key: string }>("SELECT kid, public_key FROM hub_signing_key ORDER BY created_at DESC");
    return result.rows.map(row => ({ kid: row.kid, publicKey: row.public_key }));
  }

  async create(input: { name: string; createdBy: string; at: Date }): Promise<{ machine: MachineRecord; code: string; expiresAt: Date }> {
    const machineId = randomUUID();
    const code = newToken();
    const expiresAt = new Date(input.at.getTime() + JOIN_CODE_TTL_MS);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<Row>(
        `INSERT INTO hub_machine(machine_id, name, state, created_by, created_at) VALUES ($1,$2,'pending',$3,$4) RETURNING *`,
        [machineId, input.name, input.createdBy, input.at]);
      await client.query("INSERT INTO hub_machine_join_code(code_hash, machine_id, expires_at, created_at) VALUES ($1,$2,$3,$4)",
        [hashToken(code), machineId, expiresAt, input.at]);
      await client.query("COMMIT");
      return { machine: machineOf(inserted.rows[0]!), code, expiresAt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") throw new HubError(409, "MACHINE_NAME_TAKEN", "A machine with this name already exists.");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Use a join code: one atomic UPDATE marks it used only if it is unused, unexpired and its machine is still pending, so a second use of the same
   * code (or a use after the machine was removed) matches no row and fails the same way as a wrong code.
   */
  async join(input: { code: string; publicKey: string; allowedRoots: string[]; hostLabel: string | null; at: Date }): Promise<MachineRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const used = await client.query<{ machine_id: string }>(
        `UPDATE hub_machine_join_code c SET used_at=$2
         WHERE c.code_hash=$1 AND c.used_at IS NULL AND c.expires_at > $2
           AND EXISTS (SELECT 1 FROM hub_machine m WHERE m.machine_id=c.machine_id AND m.state='pending')
         RETURNING c.machine_id`,
        [hashToken(input.code), input.at]);
      const machineId = used.rows[0]?.machine_id;
      if (!machineId) {
        await client.query("ROLLBACK");
        throw new HubError(403, "JOIN_CODE_INVALID", "The join code is invalid, expired or already used.");
      }
      const updated = await client.query<Row>(
        `UPDATE hub_machine SET state='active', public_key=$2, allowed_roots=$3, host_label=$4, joined_at=$5, last_seen_at=$5
         WHERE machine_id=$1 RETURNING *`,
        [machineId, input.publicKey, input.allowedRoots, input.hostLabel, input.at]);
      await client.query("COMMIT");
      return machineOf(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(machineId: string): Promise<MachineRecord | null> {
    const result = await this.pool.query<Row>("SELECT * FROM hub_machine WHERE machine_id=$1", [machineId]);
    return result.rows[0] ? machineOf(result.rows[0]) : null;
  }

  async list(): Promise<MachineRecord[]> {
    const result = await this.pool.query<Row>("SELECT * FROM hub_machine ORDER BY created_at, machine_id");
    return result.rows.map(machineOf);
  }

  /** Remove at once: from this commit on, no request signed by the machine is accepted and no identity is issued for it. */
  async remove(machineId: string, at: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE hub_machine SET state='removed', removed_at=$2 WHERE machine_id=$1 AND state<>'removed'", [machineId, at]);
      await client.query("DELETE FROM hub_machine_join_code WHERE machine_id=$1 AND used_at IS NULL", [machineId]);
      // Projects placed on the machine keep their record (and the machine keeps its data) but point nowhere until an administrator places them again.
      await client.query("UPDATE hub_project SET machine_id=NULL, updated_at=$2 WHERE machine_id=$1", [machineId, at]);
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async touch(machineId: string, at: Date): Promise<void> {
    await this.pool.query("UPDATE hub_machine SET last_seen_at=$2 WHERE machine_id=$1 AND state='active'", [machineId, at]);
  }

  async projectMachine(projectId: string): Promise<string | null> {
    const result = await this.pool.query<{ machine_id: string | null }>("SELECT machine_id FROM hub_project WHERE project_id=$1", [projectId]);
    return result.rows[0]?.machine_id ?? null;
  }
}

export type MachineStoreHolder = { machines: MachineStore; store: HubStore };
