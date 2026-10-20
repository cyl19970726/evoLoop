import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { authConfigSchema } from "./auth.js";
import { buildServer } from "./server.js";
import { acquireCoordinatorLease } from "./lease.js";

const databaseUrl = process.env.EVOLOOP_DATABASE_URL;
const authFile = process.env.EVOLOOP_AUTH_FILE;
if (!databaseUrl || !authFile) throw new Error("Set EVOLOOP_DATABASE_URL and EVOLOOP_AUTH_FILE. Run migrations separately before starting.");
const credentials = authConfigSchema.parse(JSON.parse(await readFile(authFile, "utf8")));
const port = Number(process.env.EVOLOOP_PORT ?? "4318");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EVOLOOP_PORT.");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, query_timeout: 15000 });
pool.on("error", () => { /* Requests receive explicit unavailable responses; credentials are never logged. */ });
const lease = await acquireCoordinatorLease(pool);
const service = new WorkflowService({
  uow: new PostgresUnitOfWork(pool),
  clock: { now: () => new Date().toISOString() },
  ids: { next: randomUUID },
  hasher: { hash: value => createHash("sha256").update(value, "utf8").digest("hex") },
});
const app = await buildServer({ service, credentials, canWrite: lease.canWrite, webRoot: fileURLToPath(new URL("../../workbench/dist/", import.meta.url)) });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  await app.close(); await lease.release(); await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try { await app.listen({ host: "127.0.0.1", port }); console.log(`evoLoop local workbench: http://127.0.0.1:${port}`); }
catch (error) { await shutdown(); throw error; }
