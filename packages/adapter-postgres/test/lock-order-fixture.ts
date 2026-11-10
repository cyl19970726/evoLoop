// Two-connection interleaving for lock-order tests: stop one writer before a chosen statement,
// start the other, wait until the other is blocked on a lock, then let the first continue.
import assert from "node:assert/strict";
import pg from "pg";

type Stop = (text: string, values: unknown[]) => boolean;

/** A pool whose connection stops before the first matching statement until resumed. */
export function gatedPool(connectionString: string, options: string, stopBefore: Stop) {
  const inner = new pg.Pool({ connectionString, options, max: 2 });
  let reached!: () => void, resume!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let stopped = false;
  const facade = {
    connect: async () => {
      const client = await inner.connect();
      const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
      Object.assign(client, { query: async (text: string, values?: unknown[]) => {
        if (!stopped && stopBefore(text, values ?? [])) { stopped = true; reached(); await resumed; }
        return query(text, values);
      } });
      return client;
    },
    // Statements outside a transaction (for example a read back after a failure) are not gated.
    query: (text: string, values?: unknown[]) => inner.query(text, values),
  };
  return { pool: facade as unknown as pg.Pool, paused, resume, end: () => inner.end() };
}

/** Resolves once a backend with this application name is waiting on a heavyweight lock. */
export async function waitsOnLock(observer: pg.Pool, application: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = await observer.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'`, [application]);
    if (waiting.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${application} never waited on a lock`);
}

export const describeOutcome = (outcome: PromiseSettledResult<unknown>): string => outcome.status === "fulfilled" ? "ok" :
  `${(outcome.reason as { code?: string }).code ?? ""} ${String((outcome.reason as Error).message ?? outcome.reason)}`;

/**
 * Runs `stopped` on a gated connection until it reaches `stopBefore`, then starts `other` (whose
 * connections carry `otherApplication`), waits for `other` to block on a lock and lets `stopped`
 * continue. Asserts neither side failed, so a deadlock (40P01) on either side fails the test.
 */
export async function interleave<A, B>(input: {
  connectionString: string; options: string; observer: pg.Pool; otherApplication: string;
  stopBefore: Stop; stopped: (pool: pg.Pool) => Promise<A>; other: () => Promise<B>;
  labels?: [string, string];
}): Promise<[A, B]> {
  const [stoppedLabel, otherLabel] = input.labels ?? ["stopped writer", "other writer"];
  const gate = gatedPool(input.connectionString, input.options, input.stopBefore);
  try {
    const first = input.stopped(gate.pool);
    first.catch(() => {});
    await Promise.race([gate.paused, first.then(() => { throw new Error(`${stoppedLabel} finished before the interleaving point`); })]);
    const second = input.other();
    second.catch(() => {});
    await waitsOnLock(input.observer, input.otherApplication);
    gate.resume();
    const [a, b] = await Promise.allSettled([first, second]);
    assert.equal(b.status, "fulfilled", `${otherLabel}: ${describeOutcome(b)}`);
    assert.equal(a.status, "fulfilled", `${stoppedLabel}: ${describeOutcome(a)}`);
    return [(a as PromiseFulfilledResult<A>).value, (b as PromiseFulfilledResult<B>).value];
  } finally { gate.resume(); await gate.end(); }
}
