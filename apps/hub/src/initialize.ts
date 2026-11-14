import { readFile } from "node:fs/promises";
import pg from "pg";
import { loadHubConfig } from "./config.js";
import { applyHubMigrations } from "./migrations.js";
import { HubService } from "./service.js";
import { HubStore } from "./store.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const email = option("--email")?.trim().toLowerCase();
const displayName = option("--name")?.trim();
const passwordFile = option("--password-file");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("Usage: node dist/initialize.js --email EMAIL --name NAME [--password-file PRIVATE_FILE] (or pipe the password on stdin).");
}

const password = passwordFile
  ? (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "")
  : await readStdin();

const config = loadHubConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
try {
  await applyHubMigrations(pool);
  const service = new HubService(new HubStore(pool), config);
  const account = await service.initializeFirstAdmin({
    email,
    displayName: displayName ?? email.split("@")[0] ?? "Hub administrator",
    password,
  });
  process.stdout.write(`${JSON.stringify({ initialized: true, account }, null, 2)}\n`);
} finally {
  await pool.end();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
