import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const leaseKey = 731209842;
export const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const absent = async path => { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } };

export async function externalPath(path) {
  if (!path || !isAbsolute(path)) throw new Error("Backup paths must be absolute");
  let ancestor = path;
  while (await absent(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(await realpath(ancestor), relative(ancestor, path));
  const root = await realpath(repoRoot);
  if (canonical === root || canonical.startsWith(root + sep)) throw new Error("Backup data must stay outside the repository");
  return canonical;
}

export function pgEnvironment(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("A PostgreSQL database URL with a database name is required");
  }
  const env = { ...process.env, PGHOST: parsed.hostname, PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGUSER: decodeURIComponent(parsed.username), PGPORT: parsed.port || "5432", PGPASSWORD: decodeURIComponent(parsed.password) };
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export function safeErrorMessage(error, databaseUrl = "") {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [databaseUrl, process.env.PGPASSWORD]) if (secret) message = message.replaceAll(secret, "[redacted]");
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password) message = message.replaceAll(password, "[redacted]");
  } catch { /* malformed URL is already handled by connection validation */ }
  return message;
}

export async function runPg(executable, args, databaseUrl) {
  const binDir = process.env.EVOLOOP_PG_BIN_DIR;
  if (binDir && !isAbsolute(binDir)) throw new Error("EVOLOOP_PG_BIN_DIR must be absolute");
  const command = binDir ? join(binDir, executable) : executable;
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env: pgEnvironment(databaseUrl), stdio: ["ignore", "ignore", "pipe"] });
    // Never echo connection strings or server diagnostics that may contain private content.
    child.stderr.resume();
    child.once("error", () => rejectRun(new Error(`${executable} could not start`)));
    child.once("close", code => code === 0 ? resolveRun() : rejectRun(new Error(`${executable} failed (exit ${code ?? "unknown"})`)));
  });
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { digest.update(chunk); size += chunk.length; }
  return { sha256: digest.digest("hex"), size };
}

export async function listFiles(root) {
  const found = [];
  async function visit(folder, prefix) {
    for (const name of (await readdir(folder)).sort()) {
      const source = join(folder, name), path = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Backup source contains a link or special file");
      if (stat.isDirectory()) await visit(source, path);
      else found.push(path);
    }
  }
  await visit(root, "");
  return found;
}

export async function copyTree(source, destination, prefix, records) {
  await mkdir(destination, { mode: 0o700 });
  for (const path of await listFiles(source)) {
    const from = join(source, path), to = join(destination, path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const before = await sha256File(from);
    await copyFile(from, to);
    const after = await sha256File(to);
    if (before.sha256 !== after.sha256 || before.size !== after.size ||
      (await sha256File(from)).sha256 !== before.sha256) throw new Error("Source changed during backup; stop all writers and retry into a new archive");
    records.push({ path: `${prefix}/${path}`, ...after });
  }
}

export async function backup({ databaseUrl, out, blobRoot, wikiSnapshot = null, wikiDisabled = false, integrationsFile = null }) {
  if (!databaseUrl) throw new Error("EVOLOOP_DATABASE_URL is required");
  if (!!wikiSnapshot === !!wikiDisabled) throw new Error("Specify exactly one of --wiki-snapshot or --wiki-disabled");
  const destination = await externalPath(out);
  const blobs = await externalPath(blobRoot);
  const wiki = wikiSnapshot ? await externalPath(wikiSnapshot) : null;
  if (overlaps(destination, blobs) || wiki && (overlaps(destination, wiki) || overlaps(blobs, wiki))) {
    throw new Error("Backup destination and data sources must be separate directories");
  }
  if (!(await absent(destination))) throw new Error("Backup destination already exists");
  for (const source of [blobs, wiki].filter(Boolean)) {
    if (!(await lstat(source)).isDirectory()) throw new Error("Backup source must be a directory");
  }
  if (integrationsFile) {
    const configuration = JSON.parse(await readFile(integrationsFile, "utf8"));
    if (configuration.knowledge?.enabled && !wiki) throw new Error("Enabled Wiki requires a separate external snapshot");
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let stage = null;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS held", [leaseKey]);
    if (lock.rows[0]?.held !== true) throw new Error("Coordinator is still writing; stop it before backup");
    const version = await client.query("SHOW server_version_num");
    if (Number(version.rows[0]?.server_version_num) < 180000 || Number(version.rows[0]?.server_version_num) >= 190000) {
      throw new Error("This backup procedure is validated for PostgreSQL 18 only");
    }
    stage = await mkdtemp(`${destination}.partial-`);
    const files = [];
    await runPg("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--file=${join(stage, "db.dump")}`], databaseUrl);
    files.push({ path: "db.dump", ...await sha256File(join(stage, "db.dump")) });
    await copyTree(blobs, join(stage, "blobs"), "blobs", files);
    if (wiki) await copyTree(wiki, join(stage, "wiki"), "wiki", files);
    const manifest = { formatVersion: 1, createdAtUtc: new Date().toISOString(), postgresMajor: 18,
      database: pgEnvironment(databaseUrl).PGDATABASE, wiki: { mode: wiki ? "external-snapshot" : "disabled" },
      consistency: "Coordinator lease held during pg_dump and file copy; external Wiki writers must be stopped separately. Cross-store atomicity is not claimed.",
      files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (!(await absent(destination))) throw new Error("Backup destination appeared while copying");
    await rename(stage, destination);
    stage = null;
    return { destination, fileCount: files.length, wikiMode: manifest.wiki.mode };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await client.end(); // releases the same advisory lease that excludes a coordinator restart
  }
}

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--wiki-disabled") { options.wikiDisabled = true; continue; }
    if (!["--out", "--blob-root", "--wiki-snapshot", "--integrations"].includes(name) || !argv[i + 1]) throw new Error("Unknown or incomplete backup option");
    options[{ "--out": "out", "--blob-root": "blobRoot", "--wiki-snapshot": "wikiSnapshot", "--integrations": "integrationsFile" }[name]] = argv[++i];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await backup({ ...argumentsFrom(process.argv.slice(2)), databaseUrl: process.env.EVOLOOP_DATABASE_URL });
    console.log(`Backup verified at ${result.destination} (${result.fileCount} files; Wiki ${result.wikiMode}).`);
  } catch (error) { console.error(`Backup failed: ${safeErrorMessage(error, process.env.EVOLOOP_DATABASE_URL)}`); process.exitCode = 1; }
}
