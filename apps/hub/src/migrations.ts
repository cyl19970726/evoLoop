import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION_LOCK = 72_834_192_551;

export async function applyHubMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS hub_schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(MIGRATIONS_DIR)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const filename of files) {
      const sql = await readFile(`${MIGRATIONS_DIR}/${filename}`, "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      const previous = await client.query<{ checksum: string }>(
        "SELECT checksum FROM hub_schema_migrations WHERE filename=$1",
        [filename],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) {
          throw new Error(`Hub migration ${filename} changed after it was applied.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO hub_schema_migrations(filename, checksum) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
