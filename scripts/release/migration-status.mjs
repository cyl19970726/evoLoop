#!/usr/bin/env node
// Prints the names of the migrations already applied to EVOLOOP_DATABASE_URL, one per line (read-only).
// The release runner calls it before and after the migrate step to record what this release applied.
import pg from "pg";

const url = process.env.EVOLOOP_DATABASE_URL;
if (!url) { console.error("EVOLOOP_DATABASE_URL is not set"); process.exit(1); }
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const exists = await client.query("SELECT to_regclass('public.pgmigrations') AS table_name");
  const rows = exists.rows[0].table_name ? (await client.query("SELECT name FROM pgmigrations ORDER BY id")).rows : [];
  process.stdout.write(rows.map(row => row.name).join("\n") + (rows.length ? "\n" : ""));
} catch (error) {
  console.error(`migration-status: ${error.message.replaceAll(url, "[redacted]")}`);
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
