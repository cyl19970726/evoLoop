import type { Pool, PoolClient } from "pg";

// A dedicated connection owns the process lock. It is never returned alive to the pool.
export async function acquireCoordinatorLease(pool: Pool) {
  const client: PoolClient = await pool.connect();
  let held = false;
  let closed = false;
  const lost = () => { held = false; };
  client.on("error", lost);
  client.on("end", lost);
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(731209842) AS acquired");
    held = result.rows[0]?.acquired === true;
    if (!held) throw new Error("Another coordinator owns this database; stop it before starting another.");
  } catch (error) { client.release(true); throw error; }
  const timer = setInterval(() => {
    if (!held || closed) return;
    void client.query("SELECT 1").catch(lost);
  }, 2000);
  timer.unref();
  return {
    canWrite: () => held && !closed,
    async release() {
      if (closed) return; closed = true; held = false; clearInterval(timer);
      // Destroying the dedicated connection releases its advisory lock even after a failed query.
      client.release(true);
    },
  };
}
