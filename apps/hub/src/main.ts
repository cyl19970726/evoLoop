import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHubConfig } from "./config.js";
import { buildHubApp } from "./server.js";
import { HubService } from "./service.js";
import { HubStore } from "./store.js";

const config = loadHubConfig();
// The built workbench next to the Hub in a checkout; HUB_WEB_ROOT names another place. Without index.html the Hub serves only its API and plain pages.
if (!config.webRoot) {
  const bundled = fileURLToPath(new URL("../../workbench/dist/", import.meta.url));
  if (existsSync(`${bundled}index.html`)) config.webRoot = bundled;
}
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
});
pool.on("error", () => {
  // The request path returns explicit errors; never print the connection string or credentials.
});

const schema = await pool.query("SELECT to_regclass('hub_account') AS table");
if (!schema.rows[0]?.table) {
  await pool.end();
  throw new Error("Hub schema is missing. Run `npm run migrate --workspace @evoloop/hub` first.");
}

const store = new HubStore(pool);
const service = new HubService(store, config);
const app = buildHubApp({ config, store, service, logger: { level: "info" } });

const close = async () => {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
process.stdout.write(`evoLoop Hub listening on ${config.host}:${config.port} (public origin ${config.publicOrigin})\n`);
