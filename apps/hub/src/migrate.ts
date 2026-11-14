import pg from "pg";
import { loadHubDatabaseUrl } from "./config.js";
import { applyHubMigrations } from "./migrations.js";

const url = loadHubDatabaseUrl();
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const applied = await applyHubMigrations(pool);
  process.stdout.write(applied.length ? `Applied Hub migrations: ${applied.join(", ")}\n` : "Hub migrations already current.\n");
} finally {
  await pool.end();
}
