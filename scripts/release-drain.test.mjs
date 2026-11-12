import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinatorLockQuery, waitForDrained, waitForLockRelease } from "./lib/release-drain.mjs";

const status = (state, runs, turns) => ({ state, safeToStop: state === "drained", inFlight: { counts: { runs, messageTurns: turns, total: runs + turns } }, queued: { messages: 8, runs: 0 } });

test("waiting for the drain returns only once the instance reports drained, never releases it, and gives up with the state it saw", async () => {
  let clock = 0; const seen = []; const sleeps = [];
  const sequence = [status("draining", 3, 2), status("draining", 1, 0), status("drained", 0, 0)];
  const done = await waitForDrained({ status: async () => sequence.shift(), sleep: async ms => { sleeps.push(ms); clock += ms; }, now: () => clock, timeoutMs: 60_000, pollMs: 5000, log: line => seen.push(line) });
  assert.equal(done.safeToStop, true);
  assert.deepEqual(sleeps, [5000, 5000], "polls until drained, no longer");
  assert.match(seen[0], /draining: 3 Run\(s\), 2 message Turn\(s\) in flight; 8 message\(s\) and 0 Run\(s\) queued/);
  clock = 0;
  await assert.rejects(waitForDrained({ status: async () => status("draining", 2, 1), sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 20_000, pollMs: 5000 }),
    error => /Not drained after 20s: draining: 2 Run\(s\), 1 message Turn\(s\)/.test(error.message) && /still on/.test(error.message) && error.status.state === "draining");
  await assert.rejects(waitForDrained({ status: async () => status("active", 0, 0), sleep: async () => {}, timeoutMs: 1000 }), /not draining/);
});

test("after the stop, the backup waits for the coordinator's database lock to be really released, not just the port", async () => {
  let clock = 0; const seen = [];
  const answers = [[4242], [4242], []];
  await waitForLockRelease({ holders: async () => answers.shift(), sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 30_000, log: line => seen.push(line) });
  assert.equal(answers.length, 0);
  assert.match(seen[0], /still held by backend 4242/);
  clock = 0;
  await assert.rejects(waitForLockRelease({ holders: async () => [4242], sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 5000, pollMs: 1000 }), /still held by backend 4242 after 5s; do not back up yet/);
  assert.match(coordinatorLockQuery, /classid=0 AND objid=731209842 AND objsubid=1/, "the same key the coordinator takes in lease.ts");
});
