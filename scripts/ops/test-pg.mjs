#!/usr/bin/env node
// The convention for a developer's test PostgreSQL instance, so it can be found and reclaimed instead of guessed at:
//   location  EVOLOOP_TEST_PG_ROOT/<name>/        (one directory per instance; the root is a private path)
//   name      the worktree directory's name (lowercase letters, digits, - and _), e.g. wt-effort
//   marker    <dir>/.evoloop-test-pg.json  { name, worktree, branch, port, createdAt } — written at start; the reclaim job reads it.
//             `branch` lets `disk-reclaim --branch NAME` still find the instance after its worktree has been reclaimed.
//   database  evoloop_<name with _ for ->_test    (matches the integration-test guard)
//   stop      `test-pg.mjs stop --name NAME`; the reclaim job also stops it once its worktree is merged and gone
// Binaries come from EVOLOOP_PG_BIN_DIR (a PostgreSQL 18 bin directory), as in the backup documentation.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MARKER = ".evoloop-test-pg.json";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function instanceName(value) {
  const name = String(value ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) throw new Error(`instance name must be lowercase letters, digits, - or _ (got "${value}")`);
  return name;
}
export const databaseName = name => `evoloop_${instanceName(name).replaceAll("-", "_")}_test`;

/** The instance directory, which must be a direct child of the configured root (never the root, never outside it). */
export function instancePath(root, name) {
  if (!root || !isAbsolute(root)) throw new Error("EVOLOOP_TEST_PG_ROOT must be an absolute path");
  const realRoot = (() => { try { return realpathSync(root); } catch { return resolve(root); } })();
  if (realRoot === repoRoot || realRoot.startsWith(repoRoot + sep)) throw new Error("EVOLOOP_TEST_PG_ROOT must be outside the repository");
  return join(realRoot, instanceName(name));
}

const freePort = () => new Promise((resolvePort, reject) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); }); server.on("error", reject); });

/** The branch checked out in `worktree`, or null (detached HEAD, not a git worktree, git missing). */
export function currentBranch(worktree, exec = execFileSync) {
  if (!worktree) return null;
  try { const name = String(exec("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim(); return name && name !== "HEAD" ? name : null; } catch { return null; }
}

export async function start({ root, name, worktree, branch, binDir, exec = execFileSync }) {
  const dir = instancePath(root, name);
  const bin = file => join(binDir, file);
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const data = join(dir, "data");
  exec(bin("initdb"), ["-D", data, "-U", "evoloop", "-A", "trust", "--no-sync"], { stdio: "ignore" });
  exec(bin("pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, "-l", join(dir, "log"), "start", "-w"], { stdio: "ignore" });
  const database = databaseName(name);
  exec(bin("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "evoloop", "-d", "postgres", "-c", `CREATE DATABASE ${database}`], { stdio: "ignore" });
  writeFileSync(join(dir, MARKER), JSON.stringify({ name: instanceName(name), worktree: worktree ? resolve(worktree) : null, branch: branch ?? currentBranch(worktree, exec), port, createdAt: new Date().toISOString() }, null, 2));
  return { dir, port, url: `postgres://evoloop@127.0.0.1:${port}/${database}` };
}

export function stop({ root, name, binDir, exec = execFileSync }) {
  const dir = instancePath(root, name);
  try { exec(join(binDir, "pg_ctl"), ["-D", join(dir, "data"), "stop", "-m", "fast", "-w"], { stdio: "ignore" }); } catch { /* not running */ }
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

export function list(root) {
  const base = instancePath(root, "x").replace(/x$/, "");
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    try { return { dir: join(base, entry.name), ...JSON.parse(readFileSync(join(base, entry.name, MARKER), "utf8")) }; } catch { return { dir: join(base, entry.name), name: entry.name, worktree: null, unmarked: true }; }
  });
}

const isMainModule = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMainModule()) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, worktree: { type: "string" }, branch: { type: "string" } } });
  const root = process.env.EVOLOOP_TEST_PG_ROOT, binDir = process.env.EVOLOOP_PG_BIN_DIR;
  const command = positionals[0];
  try {
    if (command === "list") console.log(JSON.stringify(list(root), null, 2));
    else if (command === "start" || command === "stop") {
      if (!binDir) throw new Error("EVOLOOP_PG_BIN_DIR must point at a PostgreSQL 18 bin directory");
      const name = values.name ?? basename(values.worktree ?? process.cwd());
      if (command === "start") { const result = await start({ root, name, worktree: values.worktree ?? process.cwd(), branch: values.branch, binDir }); console.log(`export TEST_DATABASE_URL=${result.url}   # ${result.dir}`); }
      else console.log(`stopped and removed ${stop({ root, name, binDir })}`);
    } else { console.error("usage: test-pg.mjs start|stop [--name NAME] [--worktree PATH] [--branch NAME] | list\nenv: EVOLOOP_TEST_PG_ROOT (private absolute path), EVOLOOP_PG_BIN_DIR"); process.exit(2); }
  } catch (error) { console.error(error.message); process.exit(1); }
}
