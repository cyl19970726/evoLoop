import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalDataDirectory, checkPilotStorage, connectionTarget, localPostmaster,
  temporaryPath } from "./pilot-storage-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = "postgres://pilot:private-secret@127.0.0.1:55461/evoloop_pilot_test";
const rejected = code => error => error?.code === code && error.message === code;

test("only explicit numeric loopback PostgreSQL targets pass URL preflight", () => {
  assert.deepEqual(connectionTarget(databaseUrl), { host: "127.0.0.1", port: 55461, database: "evoloop_pilot_test" });
  for (const url of ["postgres://pilot@db.example:55461/evoloop_pilot_test",
    "postgres://pilot@localhost:55461/evoloop_pilot_test", "postgres://pilot@127.0.0.1/evoloop_pilot_test",
    "postgres://pilot@127.0.0.1:55461/evoloop_pilot_test?host=db.example", "not-a-url"]) {
    assert.throws(() => connectionTarget(url), error => error.code === "LOCAL_PG_URL_REQUIRED" || error.code === "DATABASE_URL_INVALID");
  }
});

test("temporary roots, symlinks into them, repository data and mismatched expectations fail closed", async t => {
  const safe = await mkdtemp(join(homedir(), ".evoloop-storage-test-"));
  const temp = await mkdtemp(join(tmpdir(), "evoloop-storage-test-"));
  t.after(async () => { await rm(safe, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }); });
  const good = join(safe, "data"), other = join(safe, "other"), alias = join(safe, "temp-alias");
  await mkdir(good, { mode: 0o700 }); await mkdir(other, { mode: 0o700 }); await symlink(temp, alias);
  for (const path of ["/tmp/cluster", "/private/tmp/cluster", "/var/tmp/cluster",
    "/private/var/folders/ab/cd/T/cluster", join(homedir(), "Library", "Caches", "cluster")])
    assert.equal(temporaryPath(path), true, path);
  await assert.rejects(canonicalDataDirectory(temp, temp), rejected("TEMPORARY_DATA_DIRECTORY"));
  await assert.rejects(canonicalDataDirectory(alias, alias), rejected("TEMPORARY_DATA_DIRECTORY"));
  await assert.rejects(canonicalDataDirectory(repoRoot, repoRoot), rejected("REPOSITORY_DATA_DIRECTORY"));
  await assert.rejects(canonicalDataDirectory(good, other), rejected("DATA_DIRECTORY_MISMATCH"));
  await chmod(good, 0o755);
  await assert.rejects(canonicalDataDirectory(good, good), rejected("DATA_DIRECTORY_MODE"));
});

test("safe errors never expose PG diagnostics or credentials", async t => {
  const safe = await mkdtemp(join(homedir(), ".evoloop-storage-test-"));
  t.after(() => rm(safe, { recursive: true, force: true }));
  const data = join(safe, "data"); await mkdir(data, { mode: 0o700 });
  const evidenceOut = join(safe, "evidence.json");
  await assert.rejects(checkPilotStorage({ databaseUrl, expectedDataDirectory: data, evidenceOut,
    clientFactory: () => ({ connect: async () => { throw new Error(`password private-secret ${databaseUrl}`); } }) }),
  rejected("PG_CONNECT_FAILED"));
  await assert.rejects(lstat(evidenceOut), { code: "ENOENT" });
});

test("read-only local PG18 facts produce one private immutable evidence JSON", async t => {
  const safe = await mkdtemp(join(homedir(), ".evoloop-storage-test-"));
  t.after(() => rm(safe, { recursive: true, force: true }));
  const data = join(safe, "data"), evidenceOut = join(safe, "evidence.json");
  await mkdir(data, { mode: 0o700 });
  const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  await writeFile(join(data, "postmaster.pid"), `${process.pid}\n${data}\n${Math.floor(Date.parse(startedAt) / 1000)}\n55461\n\n127.0.0.1\n`, { mode: 0o600 });
  const queries = new Map([
    ["SHOW data_directory", { rows: [{ data_directory: data }] }],
    ["SHOW server_version_num", { rows: [{ server_version_num: "180006" }] }],
    ["SHOW server_version", { rows: [{ server_version: "18.6" }] }],
    ["SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, pg_postmaster_start_time() AS started_at",
      { rows: [{ database: "evoloop_pilot_test", address: "127.0.0.1", port: 55461, started_at: startedAt }] }],
  ]);
  let connected = false, ended = false;
  const clientFactory = () => ({ connect: async () => { connected = true; },
    query: async sql => { assert.equal(connected, true); assert.ok(queries.has(sql), sql); return queries.get(sql); },
    end: async () => { ended = true; } });
  const result = await checkPilotStorage({ databaseUrl, expectedDataDirectory: data, evidenceOut, clientFactory });
  assert.equal(ended, true);
  assert.equal(result.connection.database, "evoloop_pilot_test");
  assert.equal(result.connection.serverVersion, "18.6");
  assert.equal(result.storage.canonical, await (await import("node:fs/promises")).realpath(data));
  assert.equal(result.storage.mode, "0700");
  assert.equal(result.storage.uid, process.getuid());
  assert.equal((await lstat(evidenceOut)).mode & 0o777, 0o600);
  const bytes = await readFile(evidenceOut, "utf8");
  assert.deepEqual(JSON.parse(bytes), result);
  assert.equal(bytes.includes("private-secret"), false);
  assert.equal(bytes.includes("postgres://"), false);
  await assert.rejects(checkPilotStorage({ databaseUrl, expectedDataDirectory: data, evidenceOut, clientFactory }), rejected("EVIDENCE_EXISTS"));
});

test("local pid/start/port and server identity mismatches cannot pass", async t => {
  const safe = await mkdtemp(join(homedir(), ".evoloop-storage-test-"));
  t.after(() => rm(safe, { recursive: true, force: true }));
  const data = join(safe, "data"); await mkdir(data, { mode: 0o700 });
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  assert.throws(() => localPostmaster(`${process.pid}\n${data}\n1\n55461\n`, { port: 55461, startedAt: now }), rejected("LOCAL_POSTMASTER_UNVERIFIED"));
  await writeFile(join(data, "postmaster.pid"), `${process.pid}\n${data}\n${Math.floor(Date.parse(now) / 1000)}\n55461\n`);
  const clientFactory = () => ({ connect: async () => {}, end: async () => {}, query: async sql => {
    if (sql === "SHOW data_directory") return { rows: [{ data_directory: data }] };
    if (sql === "SHOW server_version_num") return { rows: [{ server_version_num: "180006" }] };
    if (sql === "SHOW server_version") return { rows: [{ server_version: "18.6" }] };
    return { rows: [{ database: "evoloop_pilot_test", address: "127.0.0.2", port: 55461, started_at: now }] };
  } });
  await assert.rejects(checkPilotStorage({ databaseUrl, expectedDataDirectory: data,
    evidenceOut: join(safe, `no-${randomUUID()}.json`), clientFactory }), rejected("LOCAL_SERVER_IDENTITY_MISMATCH"));
});
