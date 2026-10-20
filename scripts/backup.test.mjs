import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { migrate } from "@evoloop/adapter-postgres";
import { backup } from "./backup.mjs";
import { restore, verifyArchive } from "./restore.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || new URL(adminUrl).pathname !== "/evoloop_backup_test") {
  throw new Error("Use dedicated evoloop_backup_test database as the test admin connection");
}
const databaseUrl = name => { const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString(); };

test("stopped-writer PostgreSQL 18, blob and Wiki snapshot backup restores into empty targets only", async t => {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
  const sourceDb = `evoloop_backup_source_${nonce}_test`, targetDb = `evoloop_backup_target_${nonce}_test`;
  const root = await mkdtemp(join(tmpdir(), "evoloop-backup-test-"));
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  t.after(async () => {
    for (const name of [sourceDb, targetDb]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });
  await admin.query(`CREATE DATABASE ${sourceDb}`);
  await admin.query(`CREATE DATABASE ${targetDb}`);
  await migrate(databaseUrl(sourceDb));
  const projectId = randomUUID();
  const source = new pg.Client({ connectionString: databaseUrl(sourceDb) });
  await source.connect();
  await source.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Backup fixture',now())", [projectId]);
  const blobs = join(root, "blobs"), wiki = join(root, "wiki-export"), archive = join(root, "archive");
  await mkdir(join(blobs, "objects"), { recursive: true });
  await mkdir(wiki);
  await writeFile(join(blobs, "objects", "artifact"), "fixed artifact bytes");
  await writeFile(join(wiki, "living.md"), "external Wiki content");

  const lock = await source.query("SELECT pg_try_advisory_lock(731209842) AS held");
  assert.equal(lock.rows[0]?.held, true);
  await assert.rejects(() => backup({ databaseUrl: databaseUrl(sourceDb), out: archive, blobRoot: blobs, wikiSnapshot: wiki }),
    /Coordinator is still writing/);
  await source.query("SELECT pg_advisory_unlock(731209842)");
  await source.end();

  const saved = await backup({ databaseUrl: databaseUrl(sourceDb), out: archive, blobRoot: blobs, wikiSnapshot: wiki });
  assert.equal(saved.wikiMode, "external-snapshot");
  assert.equal((await verifyArchive(archive)).manifest.files.length, 3);
  await assert.rejects(() => backup({ databaseUrl: databaseUrl(sourceDb), out: archive, blobRoot: blobs, wikiSnapshot: wiki }),
    /already exists/);
  const restoredBlobs = join(root, "restored-blobs"), restoredWiki = join(root, "restored-wiki-export");
  const result = await restore({ databaseUrl: databaseUrl(targetDb), from: archive,
    blobRoot: restoredBlobs, wikiSnapshotOut: restoredWiki });
  assert.equal(result.wikiRemoteImportRequired, true);
  assert.equal(await readFile(join(restoredBlobs, "objects", "artifact"), "utf8"), "fixed artifact bytes");
  assert.equal(await readFile(join(restoredWiki, "living.md"), "utf8"), "external Wiki content");
  const target = new pg.Client({ connectionString: databaseUrl(targetDb) });
  await target.connect();
  assert.equal((await target.query("SELECT title FROM project WHERE project_id=$1", [projectId])).rows[0]?.title, "Backup fixture");
  await target.end();
  await assert.rejects(() => restore({ databaseUrl: databaseUrl(targetDb), from: archive,
    blobRoot: restoredBlobs, wikiSnapshotOut: restoredWiki }), /already exist/);
  await assert.rejects(() => restore({ databaseUrl: databaseUrl(targetDb), from: archive,
    blobRoot: join(root, "another-blob-target"), wikiSnapshotOut: join(root, "another-wiki-target") }),
    /Target database is not empty/);
  await writeFile(join(archive, "wiki", "living.md"), "tampered");
  await assert.rejects(() => verifyArchive(archive), /checksum mismatch/);
});
