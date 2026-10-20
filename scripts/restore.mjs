import { lstat, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { copyTree, externalPath, listFiles, overlaps, pgEnvironment, runPg, safeErrorMessage, sha256File } from "./backup.mjs";

const leaseKey = 731209842;
const absent = async path => { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } };
const safeRelative = value => typeof value === "string" && value !== "" && !value.startsWith("/") &&
  value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));

export async function verifyArchive(source) {
  const root = await externalPath(source);
  if (!(await lstat(root)).isDirectory()) throw new Error("Backup archive must be a directory");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.formatVersion !== 1 || manifest.postgresMajor !== 18 ||
    !["disabled", "external-snapshot"].includes(manifest.wiki?.mode) || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported backup manifest");
  }
  const expected = new Map();
  for (const item of manifest.files) {
    if (!safeRelative(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 ||
      !(item.path === "db.dump" || item.path.startsWith("blobs/") || manifest.wiki.mode === "external-snapshot" && item.path.startsWith("wiki/")) ||
      expected.has(item.path)) throw new Error("Unsafe or duplicate backup manifest entry");
    expected.set(item.path, item);
  }
  if (!expected.has("db.dump")) throw new Error("Backup lacks PostgreSQL dump");
  const actual = (await listFiles(root)).filter(path => path !== "manifest.json");
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("Backup file set does not match manifest");
  for (const [path, item] of expected) {
    const digest = await sha256File(join(root, path));
    if (digest.sha256 !== item.sha256 || digest.size !== item.size) throw new Error("Backup checksum mismatch");
  }
  return { root, manifest };
}

export async function restore({ databaseUrl, from, blobRoot, wikiSnapshotOut = null }) {
  if (!databaseUrl) throw new Error("EVOLOOP_DATABASE_URL is required");
  const { root, manifest } = await verifyArchive(from); // no target mutation before full verification
  const blobs = await externalPath(blobRoot);
  const wiki = wikiSnapshotOut ? await externalPath(wikiSnapshotOut) : null;
  if (overlaps(root, blobs) || wiki && (overlaps(root, wiki) || overlaps(blobs, wiki))) {
    throw new Error("Restore targets and archive must be separate directories");
  }
  if (manifest.wiki.mode === "external-snapshot" && !wiki || manifest.wiki.mode === "disabled" && wiki) {
    throw new Error("Wiki snapshot target must match backup manifest");
  }
  if (!(await absent(blobs)) || wiki && !(await absent(wiki))) throw new Error("Restore directories already exist; refusing to overwrite data");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let blobStage = null, wikiStage = null;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS held", [leaseKey]);
    if (lock.rows[0]?.held !== true) throw new Error("Coordinator is still writing; stop it before restore");
    const version = await client.query("SHOW server_version_num");
    if (Number(version.rows[0]?.server_version_num) < 180000 || Number(version.rows[0]?.server_version_num) >= 190000) {
      throw new Error("This restore procedure is validated for PostgreSQL 18 only");
    }
    const relations = await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname NOT IN ('pg_catalog','information_schema') AND s.nspname NOT LIKE 'pg_toast%' AND s.nspname NOT LIKE 'pg_temp%'
      AND c.relkind IN ('r','p','v','m','S','f')`);
    const schemas = await client.query(`SELECT count(*)::int AS n FROM pg_namespace
      WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`);
    if (relations.rows[0]?.n !== 0 || schemas.rows[0]?.n !== 0) throw new Error("Target database is not empty");
    blobStage = await mkdtemp(`${blobs}.partial-`);
    await copyTree(join(root, "blobs"), join(blobStage, "payload"), "blobs", []);
    if (wiki) {
      wikiStage = await mkdtemp(`${wiki}.partial-`);
      await copyTree(join(root, "wiki"), join(wikiStage, "payload"), "wiki", []);
    }
    await runPg("pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl",
      `--dbname=${pgEnvironment(databaseUrl).PGDATABASE}`, join(root, "db.dump")], databaseUrl);
    if (!(await absent(blobs)) || wiki && !(await absent(wiki))) throw new Error("Restore target appeared during database restore");
    await rename(join(blobStage, "payload"), blobs);
    await rm(blobStage, { recursive: true, force: true }); blobStage = null;
    if (wiki) {
      await rename(join(wikiStage, "payload"), wiki);
      await rm(wikiStage, { recursive: true, force: true }); wikiStage = null;
    }
    return { database: pgEnvironment(databaseUrl).PGDATABASE, blobRoot: blobs,
      wikiSnapshotOut: wiki, wikiRemoteImportRequired: manifest.wiki.mode === "external-snapshot" };
  } finally {
    if (blobStage) await rm(blobStage, { recursive: true, force: true });
    if (wikiStage) await rm(wikiStage, { recursive: true, force: true });
    await client.end();
  }
}

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!["--from", "--blob-root", "--wiki-snapshot-out"].includes(name) || !argv[i + 1]) throw new Error("Unknown or incomplete restore option");
    options[{ "--from": "from", "--blob-root": "blobRoot", "--wiki-snapshot-out": "wikiSnapshotOut" }[name]] = argv[++i];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await restore({ ...argumentsFrom(process.argv.slice(2)), databaseUrl: process.env.EVOLOOP_DATABASE_URL });
    console.log(`Restored empty database ${result.database} and blobs at ${result.blobRoot}.`);
    if (result.wikiRemoteImportRequired) console.log(`Wiki export unpacked at ${result.wikiSnapshotOut}; import and validate it in OpenViking before enabling Wiki writes.`);
  } catch (error) { console.error(`Restore failed: ${safeErrorMessage(error, process.env.EVOLOOP_DATABASE_URL)}`); process.exitCode = 1; }
}
