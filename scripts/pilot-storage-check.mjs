import { constants } from "node:fs";
import { open, lstat, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inside = (path, root) => path === root || path.startsWith(root + sep);
export class StorageCheckError extends Error {
  constructor(code) { super(code); this.name = "StorageCheckError"; this.code = code; }
}
const fail = code => { throw new StorageCheckError(code); };

export function connectionTarget(databaseUrl) {
  if (!databaseUrl) fail("DATABASE_URL_REQUIRED");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { fail("DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) || !parsed.port ||
    !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535 ||
    !parsed.pathname || parsed.pathname === "/" || parsed.search || parsed.hash) fail("LOCAL_PG_URL_REQUIRED");
  let database;
  try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { fail("DATABASE_URL_INVALID"); }
  if (!database || database.includes("/")) fail("DATABASE_URL_INVALID");
  return { host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port: Number(parsed.port), database };
}

export function temporaryPath(path, osTemporary = tmpdir(), userHome = homedir()) {
  const normalized = resolve(path);
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", osTemporary,
    join(userHome, "Library", "Caches")].map(root => resolve(root));
  if (roots.some(root => inside(normalized, root))) return true;
  return /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/[TC](?:\/|$)/.test(normalized) ||
    /\/Library\/Caches(?:\/|$)/.test(normalized);
}

async function gitCheckoutAncestor(path) {
  for (let at = path; ; at = dirname(at)) {
    try { await lstat(join(at, ".git")); return true; }
    catch (error) { if (error?.code !== "ENOENT") fail("PATH_INACCESSIBLE"); }
    if (at === dirname(at)) return false;
  }
}

export async function canonicalDataDirectory(path, expected, { repository = repoRoot } = {}) {
  if (!path || !expected || !isAbsolute(path) || !isAbsolute(expected)) fail("ABSOLUTE_DATA_PATH_REQUIRED");
  let actual, intended, project;
  try { [actual, intended, project] = await Promise.all([realpath(path), realpath(expected), realpath(repository)]); }
  catch { fail("PATH_INACCESSIBLE"); }
  if (temporaryPath(path) || temporaryPath(actual) || temporaryPath(expected) || temporaryPath(intended))
    fail("TEMPORARY_DATA_DIRECTORY");
  if (inside(actual, project) || inside(intended, project) || await gitCheckoutAncestor(actual))
    fail("REPOSITORY_DATA_DIRECTORY");
  if (actual !== intended) fail("DATA_DIRECTORY_MISMATCH");
  let details;
  try { details = await stat(actual); } catch { fail("PATH_INACCESSIBLE"); }
  if (!details.isDirectory()) fail("DATA_DIRECTORY_NOT_DIRECTORY");
  if (typeof process.getuid !== "function" || details.uid !== process.getuid()) fail("DATA_DIRECTORY_OWNER");
  const mode = details.mode & 0o7777;
  if ((mode & 0o700) !== 0o700 || (mode & 0o027) !== 0 || (mode & 0o7000) !== 0)
    fail("DATA_DIRECTORY_MODE");
  return { reported: path, canonical: actual, expected, expectedCanonical: intended,
    uid: details.uid, gid: details.gid, mode: mode.toString(8).padStart(4, "0") };
}

export function localPostmaster(pidFile, { port, startedAt }) {
  const lines = pidFile.trimEnd().split(/\r?\n/);
  const pid = Number(lines[0]), epoch = Number(lines[2]), filePort = Number(lines[3]);
  const timestamp = Date.parse(startedAt);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(epoch) || epoch < 1 ||
    filePort !== port || !Number.isFinite(timestamp) || Math.abs(epoch - Math.floor(timestamp / 1000)) > 1)
    fail("LOCAL_POSTMASTER_UNVERIFIED");
  return pid;
}

async function evidenceTarget(out) {
  if (!out || !isAbsolute(out)) fail("ABSOLUTE_EVIDENCE_PATH_REQUIRED");
  let parent, project, details;
  try { [parent, project] = await Promise.all([realpath(dirname(out)), realpath(repoRoot)]); details = await stat(parent); }
  catch { fail("EVIDENCE_PARENT_INACCESSIBLE"); }
  if (inside(parent, project) || await gitCheckoutAncestor(parent)) fail("EVIDENCE_MUST_BE_EXTERNAL");
  if (temporaryPath(dirname(out)) || temporaryPath(parent)) fail("TEMPORARY_EVIDENCE_DIRECTORY");
  if (!details.isDirectory() || typeof process.getuid !== "function" || details.uid !== process.getuid() ||
    (details.mode & 0o007) !== 0 || (details.mode & 0o020) !== 0)
    fail("EVIDENCE_PARENT_NOT_PRIVATE");
  try { await lstat(out); fail("EVIDENCE_EXISTS"); }
  catch (error) {
    if (error instanceof StorageCheckError) throw error;
    if (error?.code !== "ENOENT") fail("EVIDENCE_PATH_INACCESSIBLE");
  }
  return out;
}

export async function writeEvidence(out, evidence) {
  const path = await evidenceTarget(out);
  let file, created = false;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await file.writeFile(JSON.stringify(evidence, null, 2) + "\n");
    await file.sync();
    await file.close(); file = null;
  } catch (error) {
    if (file) { try { await file.close(); } catch { /* preserve the safe error code */ } file = null; }
    if (created) { try { await unlink(path); } catch { /* leave failed evidence for operator inspection */ } }
    if (error?.code === "EEXIST") fail("EVIDENCE_EXISTS");
    fail("EVIDENCE_WRITE_FAILED");
  }
}

export async function checkPilotStorage({ databaseUrl, expectedDataDirectory, evidenceOut, clientFactory = url => new pg.Client({ connectionString: url }) }) {
  if (!["darwin", "linux"].includes(process.platform)) fail("LOCAL_PREFLIGHT_UNSUPPORTED_OS");
  const target = connectionTarget(databaseUrl);
  if (!expectedDataDirectory || !isAbsolute(expectedDataDirectory)) fail("ABSOLUTE_DATA_PATH_REQUIRED");
  await evidenceTarget(evidenceOut);
  const client = clientFactory(databaseUrl);
  let connected = false;
  try {
    await client.connect(); connected = true;
    const directory = await client.query("SHOW data_directory");
    const versionNumber = await client.query("SHOW server_version_num");
    const version = await client.query("SHOW server_version");
    const identity = await client.query("SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, pg_postmaster_start_time() AS started_at");
    const major = Number(versionNumber.rows[0]?.server_version_num);
    if (major < 180000 || major >= 190000 || !Number.isInteger(major)) fail("POSTGRES_18_REQUIRED");
    if (typeof version.rows[0]?.server_version !== "string" || !version.rows[0].server_version)
      fail("PG_READ_FAILED");
    const server = identity.rows[0];
    if (server?.database !== target.database || server?.address !== target.host || Number(server?.port) !== target.port)
      fail("LOCAL_SERVER_IDENTITY_MISMATCH");
    const storage = await canonicalDataDirectory(directory.rows[0]?.data_directory, expectedDataDirectory);
    let pidFile;
    try { pidFile = await readFile(join(storage.canonical, "postmaster.pid"), "utf8"); }
    catch { fail("LOCAL_POSTMASTER_UNVERIFIED"); }
    const postmasterPid = localPostmaster(pidFile, { port: target.port, startedAt: server.started_at });
    let postmasterDataDirectory;
    try { postmasterDataDirectory = await realpath(pidFile.split(/\r?\n/)[1] ?? ""); }
    catch { fail("LOCAL_POSTMASTER_UNVERIFIED"); }
    if (postmasterDataDirectory !== storage.canonical) fail("LOCAL_POSTMASTER_UNVERIFIED");
    try { process.kill(postmasterPid, 0); }
    catch { fail("LOCAL_POSTMASTER_UNVERIFIED"); }
    const evidence = { formatVersion: 1, checkedAtUtc: new Date().toISOString(),
      connection: { host: target.host, port: target.port, database: server.database,
        serverVersion: version.rows[0]?.server_version, serverVersionNumber: major },
      storage: { ...storage, postmasterPid },
      confirmation: "Read-only local PostgreSQL 18 preflight: loopback server identity, reported and canonical data_directory, local postmaster start/port, directory ownership and permissions checked. No backup durability, PITR, future restart, remote host, or application behavior is proven." };
    await writeEvidence(evidenceOut, evidence);
    return evidence;
  } catch (error) {
    if (error instanceof StorageCheckError) throw error;
    fail(connected ? "PG_READ_FAILED" : "PG_CONNECT_FAILED");
  } finally {
    if (connected) { try { await client.end(); } catch { /* do not expose connection diagnostics */ } }
  }
}

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--expected-data-directory", "--evidence-out"].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith("--"))
      fail("INVALID_ARGUMENTS");
    const key = flag === "--expected-data-directory" ? "expectedDataDirectory" : "evidenceOut";
    if (options[key]) fail("INVALID_ARGUMENTS");
    options[key] = argv[++i];
  }
  if (!options.expectedDataDirectory || !options.evidenceOut) fail("INVALID_ARGUMENTS");
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await checkPilotStorage({ ...argumentsFrom(process.argv.slice(2)), databaseUrl: process.env.EVOLOOP_DATABASE_URL });
    console.log(`Pilot storage preflight passed; evidence format ${result.formatVersion} saved.`);
  } catch (error) {
    console.error(`Pilot storage preflight failed: ${error instanceof StorageCheckError ? error.code : "INTERNAL_ERROR"}`);
    process.exitCode = 1;
  }
}
