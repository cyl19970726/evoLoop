// What a release needs from drain mode (docs/architecture/deployment.md §2): start the drain, wait until the instance
// reports it is drained, and after stopping the coordinator wait until its process has really let go of the database
// lock before taking a backup. Pure of I/O details so the timing rules are tested without an instance.

/** The coordinator holds this advisory lock for as long as it may write (apps/coordinator/src/lease.ts). */
export const coordinatorLockKey = 731209842;
/** pg_advisory_lock(bigint) shows in pg_locks as classid = high 32 bits, objid = low 32 bits, objsubid = 1. */
export const coordinatorLockQuery = `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=${Math.floor(coordinatorLockKey / 2 ** 32)} AND objid=${coordinatorLockKey % 2 ** 32} AND objsubid=1 AND granted`;

const describe = status => `${status.state}: ${status.inFlight.counts.runs} Run(s), ${status.inFlight.counts.messageTurns} message Turn(s) in flight; ${status.queued.messages} message(s) and ${status.queued.runs} Run(s) queued`;

/**
 * Poll the drain status until it is drained. Never releases the drain itself: on a timeout the instance stays drained-or-
 * draining, so the person releasing it decides. Resolves with the final status, or rejects with the last one.
 */
export async function waitForDrained({ status, sleep, now = Date.now, timeoutMs, pollMs = 5000, log = () => {} }) {
  const deadline = now() + timeoutMs;
  let last;
  for (;;) {
    last = await status();
    if (last.state === "active") throw Object.assign(new Error("The instance is not draining (the drain was released or never started)."), { status: last });
    log(describe(last));
    if (last.state === "drained" && last.safeToStop) return last;
    if (now() >= deadline) throw Object.assign(new Error(`Not drained after ${Math.round(timeoutMs / 1000)}s: ${describe(last)}. The drain is still on; release it with "release-drain release" if the release is called off.`), { status: last });
    await sleep(pollMs);
  }
}

/** Wait until no session holds the coordinator's lock: the port freeing is not enough, the old process may still be closing children. */
export async function waitForLockRelease({ holders, sleep, now = Date.now, timeoutMs, pollMs = 1000, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const pids = await holders();
    if (pids.length === 0) return;
    log(`coordinator lock still held by backend ${pids.join(", ")}`);
    if (now() >= deadline) throw new Error(`The coordinator lock is still held by backend ${pids.join(", ")} after ${Math.round(timeoutMs / 1000)}s; do not back up yet.`);
    await sleep(pollMs);
  }
}
