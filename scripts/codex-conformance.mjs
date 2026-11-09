#!/usr/bin/env node
// Codex App Server conformance check (plan V3): compares an installed Codex CLI with what evoLoop uses.
// It runs only `--version` and `app-server generate-json-schema`; it never starts the App Server,
// signs in, or sends a model request. Build packages first (`npm run build:packages`).
//
//   npm run codex:conformance -- --bin /path/to/codex [--expected 0.166.0-alpha.5.1] [--json]
//
// Exit codes: 0 the used surface is covered; 1 surface problems; 2 usage or probe failure.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const run = promisify(execFile);
const SCHEMA_FILE = "codex_app_server_protocol.v2.schemas.json";
const ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"];

export async function conformance({ bin, expected = null, timeoutMs = 30_000, surface }) {
  const env = Object.fromEntries(ENV_KEYS.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const { stdout } = await run(bin, ["--version"], { timeout: timeoutMs, maxBuffer: 4096, env });
  const version = stdout.trim();
  const report = { version, expected: expected ? `codex-cli ${expected}` : null, schemas: {}, ok: true };
  for (const mode of ["standard", "experimental"]) {
    const directory = await mkdtemp(join(tmpdir(), "evoloop-codex-conformance-"));
    try {
      await run(bin, ["app-server", "generate-json-schema", ...(mode === "experimental" ? ["--experimental"] : []), "--out", directory],
        { timeout: timeoutMs, maxBuffer: 64 * 1024, env });
      const bytes = await readFile(join(directory, SCHEMA_FILE));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const pinned = surface.pinnedSchemaHashes(version);
      let parsed = null;
      try { parsed = JSON.parse(bytes.toString("utf8")); } catch { /* reported below */ }
      const checked = parsed ? surface.checkUsedSurface(parsed) : { problems: ["schema is not JSON"], features: null };
      report.schemas[mode] = { sha256, pinnedMatch: pinned ? pinned[mode] === sha256 : null,
        problems: checked.problems, detectedFeatures: checked.features };
      if (checked.problems.length) report.ok = false;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  report.pinnedFeatures = surface.pinnedFeatures(version);
  if (report.expected) {
    report.versionOrder = surface.compareCodexVersions(version, report.expected);
    report.exactVersionMatch = version === report.expected;
  }
  return report;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { bin: { type: "string" }, expected: { type: "string" }, json: { type: "boolean" } } }));
  } catch (error) { console.error(String(error.message)); process.exit(2); }
  if (!values.bin || !isAbsolute(values.bin)) { console.error("usage: codex-conformance --bin <absolute path> [--expected X.Y.Z] [--json]"); process.exit(2); }
  const surface = await import(new URL("../packages/adapter-codex-app-server/dist/index.js", import.meta.url).href);
  let report;
  try { report = await conformance({ bin: values.bin, expected: values.expected ?? null, surface }); }
  catch (error) { console.error(`probe failed: ${error.code ?? error.message}`); process.exit(2); }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Codex CLI: ${report.version}${report.expected ? ` (expected ${report.expected}${report.exactVersionMatch ? ", exact" : ""})` : ""}`);
    for (const [mode, schema] of Object.entries(report.schemas)) {
      console.log(`${mode}: sha256 ${schema.sha256.slice(0, 16)}… pinned=${schema.pinnedMatch ?? "not pinned"} features=${JSON.stringify(schema.detectedFeatures)}`);
      for (const problem of schema.problems) console.log(`  problem: ${problem}`);
    }
    console.log(report.ok ? "used surface covered" : "used surface NOT covered");
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
