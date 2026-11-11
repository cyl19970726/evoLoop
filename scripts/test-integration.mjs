import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { assertDevelopmentDatabase } from "./lib/database-target.mjs";
import { lockSafeConcurrency, nominalLockSlots } from "./lib/lock-budget.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = process.env.TEST_DATABASE_URL;
if (!input) throw new Error("TEST_DATABASE_URL must point to a dedicated evoloop_*_test database");

let base;
try { base = new URL(input); } catch { throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL"); }
const baseName = decodeURIComponent(base.pathname.slice(1));
if (!/^evoloop(?:_[a-z0-9]+)*_test$/.test(baseName) || !["postgres:", "postgresql:"].includes(base.protocol)) {
  throw new Error("TEST_DATABASE_URL must use PostgreSQL and a dedicated evoloop_*_test database name");
}
// The runner creates databases: it must never do so on the live server, whatever the database name says.
await assertDevelopmentDatabase(input);
const requestedConcurrency = process.env.EVOLOOP_INTEGRATION_CONCURRENCY;
let concurrency = requestedConcurrency === undefined ? Math.min(4, availableParallelism()) : Number(requestedConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("EVOLOOP_INTEGRATION_CONCURRENCY must be a positive integer");
}

const fileTimeoutSeconds = Number(process.env.EVOLOOP_INTEGRATION_FILE_TIMEOUT_SECONDS ?? 600);
if (!Number.isFinite(fileTimeoutSeconds) || fileTimeoutSeconds < 1) throw new Error("EVOLOOP_INTEGRATION_FILE_TIMEOUT_SECONDS must be a positive number");

const requiredDatabase = new Map([
  ["document-payloads.test.ts", "evoloop_document_test"],
  ["document-routes.test.ts", "evoloop_document_test"],
  ["facade.test.ts", "evoloop_facade_test"],
  ["scheduling-retired.test.ts", "evoloop_facade_test"],
  ["references.test.ts", "evoloop_references_test"],
  ["runtime.test.ts", "evoloop_runtime_test"],
  ["runtime-abandon.test.ts", "evoloop_runtime_abandon_test"],
  ["runtime-handoff.test.ts", "evoloop_runtime_handoff_test"],
  ["worker-cli-http.test.ts", "evoloop_journey_eval_test"],
  ["work-status.test.ts", "evoloop_journey_eval_test"],
  ["planning-sources.test.ts", "evoloop_journey_eval_test"],
  ["schedule-managed-bridge.test.ts", "evoloop_schedule_bridge_test"],
]);
// Older integration fixtures allow only letters/underscores in their dedicated
// database name; the caller's base may contain digits (for example, v1).
const generalDatabase = "evoloop_integration_test";
const urlFor = name => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};
const discovered = [
  ...(await readdir(resolve(root, "packages/adapter-postgres/test"))).filter(name => name.endsWith(".test.ts")).sort()
    .map(name => ({ path: `packages/adapter-postgres/test/${name}`, database: baseName })),
  ...(await readdir(resolve(root, "tests/integration"))).filter(name => name.endsWith(".test.ts")).sort()
    .map(name => ({ path: `tests/integration/${name}`, database: requiredDatabase.get(name) ?? generalDatabase })),
];
// A long serial group is the critical path, so large groups are spread over extra databases of
// at most `shardSize` files each. Only the two bulk groups are split; named databases stay as configured.
const shardSize = Number(process.env.EVOLOOP_INTEGRATION_SHARD_SIZE ?? 4);
if (!Number.isInteger(shardSize) || shardSize < 1) throw new Error("EVOLOOP_INTEGRATION_SHARD_SIZE must be a positive integer");
const bulkDatabases = new Set([baseName, generalDatabase]);
const shardLetters = "abcdefghijklmnopqrstuvwxyz";
const files = [];
for (const database of new Set(discovered.map(file => file.database))) {
  const group = discovered.filter(file => file.database === database);
  const shards = bulkDatabases.has(database) ? Math.min(shardLetters.length, Math.ceil(group.length / shardSize)) : 1;
  group.forEach((file, index) => {
    const shard = index % shards;
    // Shard 0 keeps the original name so a single-shard run behaves exactly as before.
    files.push({ ...file, database: shard === 0 ? database : database.replace(/_test$/, `_shard_${shardLetters[shard]}_test`) });
  });
}
if (!files.length) throw new Error("No integration tests found");

const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const createdShards = [];
try {
  await admin.connect();
  // Unless the caller chose a number, keep concurrency within what the server's lock table can carry.
  if (requestedConcurrency === undefined) {
    const setting = async name => Number((await admin.query(`SELECT current_setting('${name}') AS value`)).rows[0].value);
    const settings = { maxLocksPerTransaction: await setting("max_locks_per_transaction"), maxConnections: await setting("max_connections"),
      maxPreparedTransactions: await setting("max_prepared_transactions") };
    const safe = lockSafeConcurrency(settings);
    if (safe < concurrency) {
      process.stdout.write(`PostgreSQL lock table ${nominalLockSlots(settings)} slots (max_locks_per_transaction ${settings.maxLocksPerTransaction} x ${settings.maxConnections + settings.maxPreparedTransactions} connections) carries ${safe} concurrent test files, not ${concurrency}; running ${safe}. Raise max_locks_per_transaction or set EVOLOOP_INTEGRATION_CONCURRENCY to override.\n`);
      concurrency = safe;
    }
  }
  for (const name of new Set(files.map(file => file.database))) {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (existing.rowCount) continue;
    try {
      // PostgreSQL does not support CREATE DATABASE parameters or IF NOT EXISTS.
      // The strict identifier allowlist above makes quoting this fixed name safe.
      if (!/^evoloop(?:_[a-z0-9]+)*_test$/.test(name)) throw new Error("Unsafe test database name");
      await admin.query(`CREATE DATABASE "${name}"`);
      process.stdout.write(`Created isolated test database ${name}\n`);
      if (name.includes("_shard_")) createdShards.push(name);
    } catch (error) {
      if (error?.code === "42P04") continue; // another test launcher created it
      throw new Error(`Cannot create test database ${name}; grant CREATEDB to the configured PostgreSQL role or create it explicitly. PostgreSQL code: ${error?.code ?? "unknown"}`);
    }
  }
} finally {
  await admin.end();
}

// Files that share a database run one after another, because fixtures reset and inspect their own database.
// Different databases share nothing, so their groups run side by side, the largest group first.
const groups = [...Map.groupBy(files, file => file.database).values()].sort((a, b) => b.length - a.length);
const runFile = file => new Promise(resolvePromise => {
  const started = Date.now();
  const output = [];
  let settled = false;
  const finish = code => {
    if (settled) return;
    settled = true;
    const passed = code === 0;
    // Each file's output is printed whole when it ends, so parallel groups never interleave in the log.
    process.stdout.write(`\nRunning ${file.path} on ${file.database}\n`);
    process.stdout.write(Buffer.concat(output));
    process.stdout.write(`${passed ? "Passed" : "FAILED"} ${file.path} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    resolvePromise(passed);
  };
  const child = spawn(process.execPath, ["--import", "tsx", "--test", file.path], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_DATABASE_URL: urlFor(file.database) },
  });
  // A test whose database call failed can wait forever (seen when the server ran out of lock space);
  // a file that outlives the limit is killed and counted as failed instead of stalling the whole job.
  const timer = setTimeout(() => { output.push(Buffer.from(`\nKilled after ${fileTimeoutSeconds}s without finishing\n`)); child.kill("SIGKILL"); }, fileTimeoutSeconds * 1000);
  child.on("close", () => clearTimeout(timer));
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.on("data", chunk => output.push(chunk));
  child.on("error", error => { output.push(Buffer.from(`${error?.stack ?? error}\n`)); finish(null); });
  child.on("close", code => finish(code));
});

const failed = [];
const durations = [];
const startedAll = Date.now();
const queue = [...groups];
const worker = async () => {
  for (let group = queue.shift(); group; group = queue.shift()) {
    const started = Date.now();
    for (const file of group) {
      process.stdout.write(`Started ${file.path} on ${file.database}\n`);
      if (!(await runFile(file))) failed.push(file.path);
    }
    durations.push({ database: group[0].database, files: group.length, seconds: (Date.now() - started) / 1000 });
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));

process.stdout.write(`\nIntegration groups (${groups.length} databases, concurrency ${concurrency}, wall time ${((Date.now() - startedAll) / 1000).toFixed(0)}s):\n`);
for (const { database, files: count, seconds } of durations.sort((a, b) => b.seconds - a.seconds)) {
  process.stdout.write(`  ${database}: ${count} files, ${seconds.toFixed(0)}s\n`);
}
if (failed.length) {
  process.stderr.write(`\nIntegration test failures: ${failed.join(", ")}\n`);
  process.exitCode = 1;
}

// Shard databases exist only to spread one run; drop the ones this run created once everything passed.
// After a failure they stay for inspection. EVOLOOP_INTEGRATION_KEEP_SHARDS=1 keeps them for faster reruns.
if (!failed.length && process.env.EVOLOOP_INTEGRATION_KEEP_SHARDS !== "1" && createdShards.length) {
  const cleaner = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await cleaner.connect();
    for (const name of createdShards) {
      if (!/^evoloop(?:_[a-z0-9]+)*_shard_[a-z]_test$/.test(name)) continue;
      await cleaner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    process.stdout.write(`Dropped ${createdShards.length} shard databases created by this run\n`);
  } catch (error) {
    process.stderr.write(`Could not drop shard databases: ${error?.message ?? error}\n`);
  } finally { await cleaner.end(); }
}
