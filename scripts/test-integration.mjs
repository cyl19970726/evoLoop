import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = process.env.TEST_DATABASE_URL;
if (!input) throw new Error("TEST_DATABASE_URL must point to a dedicated evoloop_*_test database");

let base;
try { base = new URL(input); } catch { throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL"); }
const baseName = decodeURIComponent(base.pathname.slice(1));
if (!/^evoloop(?:_[a-z0-9]+)*_test$/.test(baseName) || !["postgres:", "postgresql:"].includes(base.protocol)) {
  throw new Error("TEST_DATABASE_URL must use PostgreSQL and a dedicated evoloop_*_test database name");
}

const requiredDatabase = new Map([
  ["document-payloads.test.ts", "evoloop_document_test"],
  ["document-routes.test.ts", "evoloop_document_test"],
  ["facade.test.ts", "evoloop_facade_test"],
  ["scheduling-retired.test.ts", "evoloop_facade_test"],
  ["references.test.ts", "evoloop_references_test"],
  ["runtime.test.ts", "evoloop_runtime_test"],
  ["runtime-abandon.test.ts", "evoloop_runtime_abandon_test"],
  ["runtime-handoff.test.ts", "evoloop_runtime_handoff_test"],
  ["worker-cli-http.test.ts", "evoloop_journey_eval_test"],
  ["work-status.test.ts", "evoloop_journey_eval_test"],
  ["planning-sources.test.ts", "evoloop_journey_eval_test"],
]);
// Older integration fixtures allow only letters/underscores in their dedicated
// database name; the caller's base may contain digits (for example, v1).
const generalDatabase = "evoloop_integration_test";
const urlFor = name => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};
const files = [
  ...(await readdir(resolve(root, "packages/adapter-postgres/test"))).filter(name => name.endsWith(".test.ts")).sort()
    .map(name => ({ path: `packages/adapter-postgres/test/${name}`, database: baseName })),
  ...(await readdir(resolve(root, "tests/integration"))).filter(name => name.endsWith(".test.ts")).sort()
    .map(name => ({ path: `tests/integration/${name}`, database: requiredDatabase.get(name) ?? generalDatabase })),
];
if (!files.length) throw new Error("No integration tests found");

const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
try {
  await admin.connect();
  for (const name of new Set(files.map(file => file.database))) {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (existing.rowCount) continue;
    try {
      // PostgreSQL does not support CREATE DATABASE parameters or IF NOT EXISTS.
      // The strict identifier allowlist above makes quoting this fixed name safe.
      if (!/^evoloop(?:_[a-z0-9]+)*_test$/.test(name)) throw new Error("Unsafe test database name");
      await admin.query(`CREATE DATABASE "${name}"`);
      process.stdout.write(`Created isolated test database ${name}\n`);
    } catch (error) {
      if (error?.code === "42P04") continue; // another test launcher created it
      throw new Error(`Cannot create test database ${name}; grant CREATEDB to the configured PostgreSQL role or create it explicitly. PostgreSQL code: ${error?.code ?? "unknown"}`);
    }
  }
} finally {
  await admin.end();
}

const failed = [];
for (const file of files) {
  process.stdout.write(`\nRunning ${file.path} on ${file.database}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file.path], {
    cwd: root, stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: urlFor(file.database) },
  });
  if (result.status !== 0) failed.push(file.path);
}
if (failed.length) {
  process.stderr.write(`\nIntegration test failures: ${failed.join(", ")}\n`);
  process.exitCode = 1;
}
