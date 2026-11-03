import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";

// A dedicated connection owns the process lock. It is never returned alive to the pool.
export async function acquireCoordinatorLease(pool: Pool) {
  const client: PoolClient = await pool.connect();
  let held = false;
  let closed = false;
  const nonce = randomUUID();
  const lost = () => { held = false; };
  client.on("error", lost);
  client.on("end", lost);
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(731209842) AS acquired");
    held = result.rows[0]?.acquired === true;
    if (!held) throw new Error("Another coordinator owns this database; stop it before starting another.");
    // Publish the new lease generation before serving traffic. A manual stop transaction
    // pins this row; a successor must wait for its commit before becoming available.
    await client.query(`INSERT INTO coordinator_lease_epoch(singleton,nonce) VALUES(true,$1)
      ON CONFLICT(singleton) DO UPDATE SET nonce=EXCLUDED.nonce,acquired_at=now()`,[nonce]);
  } catch (error) { client.release(true); throw error; }
  const timer = setInterval(() => {
    if (!held || closed) return;
    void client.query("SELECT 1").catch(lost);
  }, 2000);
  timer.unref();
  return {
    canWrite: () => held && !closed,
    nonce,
    async release() {
      if (closed) return; closed = true; held = false; clearInterval(timer);
      // Destroying the dedicated connection releases its advisory lock even after a failed query.
      client.release(true);
    },
  };
}

/** The row share lock pins the generation through COMMIT; the next owner updates it before serving. */
export function leaseFencedUnitOfWork(uow:UnitOfWork,lease:{nonce:string;canWrite():boolean}):UnitOfWork{
  const check=()=>{if(!lease.canWrite())throw new DomainError('LEASE_LOST','Coordinator lease lost during manual stop');};
  return {
    read:(projectId,action)=>uow.read(projectId,action),
    transaction:(projectId,action)=>uow.transaction(projectId,async tx=>{
      check();
      if(!tx.assertCoordinatorLeaseEpoch)
        throw new DomainError('MANUAL_STOP_UNAVAILABLE','Coordinator lease generation fence is unavailable');
      await tx.assertCoordinatorLeaseEpoch(lease.nonce);
      check();
      const result=await action(tx);
      check();
      return result;
    }),
  };
}
