#!/usr/bin/env node
// Release helper around drain mode (docs/architecture/deployment.md §2). Credentials come from the environment, never from arguments:
//   EVOLOOP_API_URL   coordinator origin (default http://127.0.0.1:4318)
//   EVOLOOP_TOKEN     a maintainer credential
//   EVOLOOP_DATABASE_URL   only for wait-stopped (reads pg_locks)
//
//   node scripts/release-drain.mjs start --reason "release 0dd0baa" [--timeout-minutes 120]
//        starts the drain and waits until the instance reports it is drained; exits 0 only then
//   node scripts/release-drain.mjs status
//   node scripts/release-drain.mjs wait-stopped [--timeout-seconds 120]
//        after stopping the coordinator: waits until its database lock is really released (then back up)
//   node scripts/release-drain.mjs release --reason "release done"
import { setTimeout as sleep } from "node:timers/promises";
import { coordinatorLockQuery, waitForDrained, waitForLockRelease } from "./lib/release-drain.mjs";

const [command, ...rest] = process.argv.slice(2);
const option = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const origin = (process.env.EVOLOOP_API_URL || "http://127.0.0.1:4318").replace(/\/$/, "");
const log = text => process.stderr.write(`${text}\n`);
const call = async (method, path, body) => {
  if (!process.env.EVOLOOP_TOKEN) throw new Error("Set EVOLOOP_TOKEN (a maintainer credential) in the environment.");
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${process.env.EVOLOOP_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${value?.message ?? text}`);
  return value;
};
const status = () => call("GET", "/api/instance/drain");

try {
  if (command === "status") process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
  else if (command === "start") {
    const reason = option("reason");
    if (!reason?.trim()) throw new Error("start requires --reason TEXT");
    const started = await call("POST", "/api/instance/drain", { action: "start", reason });
    log(started.changed ? "drain started" : "already draining");
    const final = await waitForDrained({ status, sleep, timeoutMs: Number(option("timeout-minutes") ?? 120) * 60_000, log });
    process.stdout.write(`${JSON.stringify({ drained: true, safeToStop: final.safeToStop, queued: final.queued }, null, 2)}\n`);
  } else if (command === "release") {
    const reason = option("reason");
    if (!reason?.trim()) throw new Error("release requires --reason TEXT");
    const released = await call("POST", "/api/instance/drain", { action: "release", reason });
    process.stdout.write(`${JSON.stringify({ changed: released.changed, state: released.status.state, queued: released.status.queued }, null, 2)}\n`);
  } else if (command === "wait-stopped") {
    const url = process.env.EVOLOOP_DATABASE_URL;
    if (!url) throw new Error("Set EVOLOOP_DATABASE_URL (read access to pg_locks) in the environment.");
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    try { await waitForLockRelease({ holders: async () => (await client.query(coordinatorLockQuery)).rows.map(row => row.pid), sleep, timeoutMs: Number(option("timeout-seconds") ?? 120) * 1000, log }); }
    finally { await client.end(); }
    process.stdout.write(`${JSON.stringify({ lockReleased: true })}\n`);
  } else throw new Error("Use start --reason TEXT | status | wait-stopped | release --reason TEXT");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.status ? 2 : 1;
}
