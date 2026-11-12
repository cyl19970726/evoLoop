import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type pg from "pg";
import { DrainControl } from "../src/drain/service.ts";

const projectId = randomUUID(), sessionId = randomUUID(), at = "2026-11-10T00:00:00.000Z";

test("a read failure holds: the instance never starts work when it cannot tell whether it is being drained", async () => {
  const broken = new DrainControl({ query: async () => { throw new Error("database unavailable"); } } as unknown as pg.Pool, { cacheMs: 0 });
  assert.equal(await broken.holdNewStarts(), true);
});

test("Runs begun or unknown count as in flight; a Run that is only requested is queued and does not keep the drain open", async () => {
  const rows = (state: string) => ({ project_id: projectId, run_id: randomUUID(), task_id: randomUUID(), session_id: sessionId, state, updated_at: at, total: "2" });
  const fake = { query: async (sql: string) => {
    if (/FROM instance_drain WHERE/.test(sql)) return { rows: [{ state: "draining", version: 2, actor_id: "m", reason: "r", changed_at: at }] };
    if (/FROM runtime_run\s+WHERE state IN/.test(sql)) return { rows: [rows("running"), rows("unknown")] };
    if (/FROM session_message_processing/.test(sql)) return { rows: [] };
    if (/state='requested'/.test(sql)) return { rows: [{ n: "4" }] };
    return { rows: [{ n: "0" }] };
  } } as unknown as pg.Pool;
  const status = await new DrainControl(fake, { cacheMs: 0 }).status();
  assert.deepEqual([status.state, status.inFlight.counts, status.queued.runs], ["draining", { runs: 2, messageTurns: 0, total: 2 }, 4]);
  assert.deepEqual(status.inFlight.runs.map(run => run.state), ["running", "unknown"]);
});
