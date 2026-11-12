#!/usr/bin/env node
// Reusable release runner. It contains only generic steps; every host, path, service name and
// identity file comes from a private config file outside the repository (EVOLOOP_RELEASE_CONFIG).
// Default is a dry run that prints the plan. Nothing is executed without --execute.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, symlink, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STEPS = ["prepare", "build", "test", "preflight", "wait-idle", "stop", "backup", "migrate", "switch", "repoint-cli", "start", "post-check"];
// Steps from "stop" on change what is running; a failure there must restore the old service.
const FIRST_DISRUPTIVE = STEPS.indexOf("stop");
// Hook steps have no default: the host-specific action must be named in the private config.
const HOOKS = new Set(["wait-idle", "stop", "repoint-cli", "start", "post-check"]);
const OPTIONAL_HOOKS = new Set(["repoint-cli"]);
// optional: data-counts prints a stable text snapshot of row counts (run while the service is stopped);
// post-migrate runs project-specific checks right after the migration, still before the switch.
const EXTRA_HOOKS = new Set(["data-counts", "post-migrate"]);
const fromRepo = path => resolve(path).startsWith(repoRoot + sep) || resolve(path) === repoRoot;

export function loadConfig(text, path) {
  if (!isAbsolute(path) || fromRepo(path)) throw new Error("Release config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  for (const key of ["releaseRoot", "currentLink", "stateDir"]) {
    if (!config[key] || !isAbsolute(config[key])) throw new Error(`config.${key} must be an absolute path`);
    if (fromRepo(config[key])) throw new Error(`config.${key} must be outside the repository`);
  }
  for (const [name, argv] of Object.entries(config.hooks ?? {})) {
    if (!HOOKS.has(name) && !EXTRA_HOOKS.has(name)) throw new Error(`Unknown hook: ${name}`);
    if (!Array.isArray(argv) || !argv.length || argv.some(part => typeof part !== "string")) throw new Error(`hooks.${name} must be a non-empty argv array`);
  }
  for (const name of HOOKS) if (!OPTIONAL_HOOKS.has(name) && !config.hooks?.[name]) throw new Error(`config.hooks.${name} is required`);
  if (!config.backup?.out || !isAbsolute(config.backup.out) || !config.backup.blobRoot) throw new Error("config.backup.out (absolute) and config.backup.blobRoot are required");
  // Where the source tree sits inside a release directory: "" (default) = the release directory itself is the checkout;
  // "source" = a layout of <release>/source plus sibling directories (runtime, artifacts) that hooks fill in.
  if (config.sourceSubdir !== undefined && (typeof config.sourceSubdir !== "string" || isAbsolute(config.sourceSubdir) || config.sourceSubdir.split(/[\\/]/).includes("..") || /[\0]/.test(config.sourceSubdir))) throw new Error("config.sourceSubdir must be a relative path without ..");
  if (!config.database?.name) throw new Error("config.database.name is required: the release refuses a database other than the one it expects");
  return config;
}

// The live database named by EVOLOOP_DATABASE_URL must be exactly the one the private config expects.
export function checkDatabaseTarget(config, env = process.env) {
  const url = env.EVOLOOP_DATABASE_URL;
  if (!url) throw new Error("EVOLOOP_DATABASE_URL is not set");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("EVOLOOP_DATABASE_URL is not a valid PostgreSQL URL"); }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  const expected = config.database;
  const problems = [];
  if (name !== expected.name) problems.push(`database name "${name}" does not match the expected "${expected.name}"`);
  if (expected.host && parsed.hostname !== expected.host) problems.push(`database host does not match the expected host`);
  if (expected.port && String(parsed.port || "5432") !== String(expected.port)) problems.push(`database port does not match the expected port`);
  if (problems.length) throw new Error(`Refusing to release: ${problems.join("; ")}`);
}

const testDatabaseEnv = env => {
  const test = env.EVOLOOP_RELEASE_TEST_DATABASE_URL;
  if (!test) throw new Error("The test step needs EVOLOOP_RELEASE_TEST_DATABASE_URL (a dedicated evoloop_*_test database) or config.skipTests");
  if (test === env.EVOLOOP_DATABASE_URL) throw new Error("EVOLOOP_RELEASE_TEST_DATABASE_URL must not be the live database");
  return { TEST_DATABASE_URL: test };
};

// Argv for each step; null means the step is a built-in action (prepare, switch) or skipped.
export function commandFor(step, config, ctx) {
  if (HOOKS.has(step)) return config.hooks?.[step] ?? null;
  switch (step) {
    case "build": return ["sh", "-c", "npm ci && npm run build"];
    case "test": return config.skipTests ? null : ["npm", "run", "test:unit"];
    case "preflight": return ["node", "scripts/release/preflight.mjs", "--backup-out", ctx.backupDir];
    case "backup": return ["node", "scripts/backup.mjs", "--out", ctx.backupDir, "--blob-root", config.backup.blobRoot,
      ...(config.backup.wikiSnapshot ? ["--wiki-snapshot", config.backup.wikiSnapshot] : ["--wiki-disabled"]),
      ...(config.backup.integrations ? ["--integrations", config.backup.integrations] : [])];
    case "migrate": return ["npm", "run", "db:migrate"];
    default: return null;
  }
}

// A runner executes argv and resolves with captured stdout when `capture` is set.
const exec = (argv, { cwd, env, capture = false }) => new Promise((resolvePromise, reject) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  let out = "";
  child.stdout?.on("data", chunk => { out += chunk; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolvePromise(out) : reject(new Error(`${argv[0]} exited with ${code}`)));
});

/** Where the current link points, as an absolute path (a relative link is resolved against the link's directory). */
async function currentTarget(link) {
  try { return resolve(dirname(link), await readlink(link)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Atomic switch: create a temporary link next to the real one and rename over it.
export async function switchLink(link, target) {
  const temp = `${link}.new-${process.pid}`;
  await rm(temp, { force: true });
  await symlink(target, temp);
  await rename(temp, link);
}

const stateFileFor = (config, id) => join(config.stateDir, `release-${id}.json`);
const readState = async (config, id) => { try { return JSON.parse(await readFile(stateFileFor(config, id), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

export function selectSteps({ from = null, only = null }) {
  for (const name of [from, ...(only ?? [])]) if (name && !STEPS.includes(name)) throw new Error(`Unknown step: ${name}. Steps: ${STEPS.join(", ")}`);
  return STEPS.slice(from ? STEPS.indexOf(from) : 0).filter(step => !only || only.includes(step));
}

// Steps from here on are undone when the old service is restored: the wait for idle, the stop, the backup and
// everything after are no longer true of a running system, so a resume must start again from wait-idle.
const FIRST_UNDONE = STEPS.indexOf("wait-idle");
const RESUME_AFTER_RECOVERY = "wait-idle";

async function gitFacts({ runner, env, releaseDir, ref, remote, branch }) {
  const out = async (argv, cwd) => String(await runner(argv, { cwd, env, capture: true })).trim();
  const sha = await out(["git", "-C", releaseDir, "rev-parse", "HEAD"], releaseDir);
  await runner(["git", "-C", repoRoot, "fetch", "--quiet", remote, branch], { cwd: repoRoot, env });
  const remoteHead = await out(["git", "-C", repoRoot, "rev-parse", `${remote}/${branch}`], repoRoot);
  let onRemote = true;
  try { await runner(["git", "-C", repoRoot, "merge-base", "--is-ancestor", sha, `${remote}/${branch}`], { cwd: repoRoot, env }); } catch { onRemote = false; }
  return { sha, ref, remote: `${remote}/${branch}`, remoteHead, onRemote, equalsRemoteHead: sha === remoteHead, checkedAt: new Date().toISOString() };
}

export async function run({ config, id, ref = "HEAD", execute = false, from = null, only = null, allowNoPrevious = false, allowOffMain = false, acknowledgeManualRecovery = false,
  env: processEnv = process.env, log = console.log, runner = exec, readManifest = path => readFile(path, "utf8") }) {
  const steps = selectSteps({ from, only });
  const releaseDir = join(config.releaseRoot, id);
  const sourceDir = config.sourceSubdir ? join(releaseDir, config.sourceSubdir) : releaseDir;
  const prior = await readState(config, id);
  // A resumed run keeps the original `previous`: the link may already point at this release. Always absolute.
  const previous = prior ? prior.previous : await currentTarget(config.currentLink);
  const state = prior ?? { id, ref, previous, releaseDir, startedAt: new Date().toISOString(), steps: [], backupAttempts: 0 };
  state.releaseDir ??= releaseDir;
  // Each backup attempt gets its own target: a retry after a failed or undone attempt must not trip over the earlier directory.
  const attempt = (state.backupAttempts ?? 0) + 1;
  const ctx = { id, ref, releaseDir, previous, backupDir: join(config.backup.out, `${id}-${attempt}`) };
  const env = { EVOLOOP_RELEASE_ID: id, EVOLOOP_RELEASE_DIR: releaseDir, EVOLOOP_RELEASE_SOURCE: sourceDir, EVOLOOP_RELEASE_PREVIOUS: previous ?? "", EVOLOOP_RELEASE_CURRENT_LINK: config.currentLink };
  const done = new Set(state.steps.filter(entry => entry.result === "ok" || entry.result === "skipped").map(entry => entry.step));
  const first = STEPS.indexOf(steps[0]);
  const reachesDisruptive = steps.some(step => STEPS.indexOf(step) >= FIRST_DISRUPTIVE);
  if (execute) {
    checkDatabaseTarget(config, processEnv);
    if (state.recovery?.result === "failed" && !acknowledgeManualRecovery) throw new Error(`The automatic restore of the old service failed earlier (${state.recovery.error}). Restore it by hand, then run again with --acknowledge-manual-recovery --from ${RESUME_AFTER_RECOVERY}.`);
    // Resuming at a step requires every earlier step to have succeeded (and not been undone) for this same release.
    const missing = STEPS.slice(0, first).filter(step => !done.has(step));
    if (missing.length && !only) {
      const undone = state.steps.some(entry => entry.result === "undone");
      throw new Error(`Cannot start at ${steps[0]}: earlier steps not completed for ${id}: ${missing.join(", ")}.${undone ? ` The old service was restored after a failure, so the stop, backup and later steps were undone: resume with --from ${RESUME_AFTER_RECOVERY}.` : ""}`);
    }
    if (reachesDisruptive && !previous && !allowNoPrevious) throw new Error("No current release link exists, so there is nothing to restore after a failure. Pass --allow-no-previous for a first release.");
    if (reachesDisruptive && previous && !(await exists(previous))) throw new Error(`The previous release directory ${previous} no longer exists, so a failed release could not be restored.`);
    if (steps.includes("test") && !config.skipTests) testDatabaseEnv(processEnv);
    await mkdir(config.stateDir, { recursive: true });
  }
  state.resumedAt = prior ? new Date().toISOString() : undefined;
  const save = () => execute ? writeFile(stateFileFor(config, id), JSON.stringify(state, null, 2)) : Promise.resolve();
  const acceptance = state.acceptance ??= {};
  // Recording hooks never fail the release: a count or status that cannot be read is written down, not acted on.
  const record = async (label, argv) => {
    try { return String(await runner(argv, { cwd: sourceDir, env, capture: true })).trim(); }
    catch (error) { acceptance[`${label}Error`] = error.message; log(`WARN ${label} could not be recorded: ${error.message} (the release continues)`); return null; }
  };
  const counts = async label => { if (config.hooks?.["data-counts"]) { const text = await record(label, config.hooks["data-counts"]); if (text !== null) acceptance[label] = text; } };
  let stopAt = null;
  for (const step of steps) {
    const argv = commandFor(step, config, ctx);
    const action = step === "prepare" ? `git worktree add --detach ${sourceDir} ${ref}` : step === "switch" ? `link ${config.currentLink} -> ${releaseDir}` : argv ? argv.join(" ") : "(skipped)";
    log(`${execute ? "RUN " : "PLAN"} ${step}: ${action}`);
    if (!execute) continue;
    const entry = { step, startedAt: new Date().toISOString() };
    state.steps = state.steps.filter(old => old.step !== step).concat(entry);
    try {
      if (step === "prepare") {
        await mkdir(config.releaseRoot, { recursive: true });
        if (await exists(sourceDir)) {
          // A rerun without --from: reuse the working tree only when it is exactly the commit asked for.
          const have = String(await runner(["git", "-C", sourceDir, "rev-parse", "HEAD"], { cwd: repoRoot, env, capture: true })).trim();
          const want = String(await runner(["git", "-C", repoRoot, "rev-parse", `${ref}^{commit}`], { cwd: repoRoot, env, capture: true })).trim();
          if (have !== want) throw new Error(`${sourceDir} already exists at ${have.slice(0, 8)}, not ${want.slice(0, 8)} (${ref}); remove it or use a new release id`);
          log(`reusing the existing working tree ${sourceDir} at ${have.slice(0, 8)}`);
        } else { await mkdir(dirname(sourceDir), { recursive: true }); await runner(["git", "-C", repoRoot, "worktree", "add", "--detach", sourceDir, ref], { cwd: repoRoot, env }); }
      } else if (step === "switch") await switchLink(config.currentLink, releaseDir);
      else if (step === "backup") { state.backupAttempts = attempt; await save(); await runner(argv, { cwd: sourceDir, env }); }
      else if (argv) await runner(argv, { cwd: sourceDir, env: { ...env, ...(step === "test" ? testDatabaseEnv(processEnv) : {}) } });
      if (step === "preflight") {
        // Record what is being released and how it relates to the remote main; an unmerged commit is refused unless allowed.
        state.commit = await gitFacts({ runner, env, releaseDir: sourceDir, ref, remote: config.remote ?? "origin", branch: config.baseBranch ?? "main" });
        if (!state.commit.onRemote && !allowOffMain) throw new Error(`Release commit ${state.commit.sha.slice(0, 8)} is not on ${state.commit.remote} (${state.commit.remoteHead.slice(0, 8)}); merge it first or pass --allow-off-main for a rehearsal`);
      }
      entry.result = argv || step === "prepare" || step === "switch" ? "ok" : "skipped";
      if (step === "stop") { stopAt = Date.now(); acceptance.stopCompletedAt = new Date().toISOString(); }
      if (step === "migrate") {
        if (config.hooks?.["post-migrate"]) await runner(config.hooks["post-migrate"], { cwd: sourceDir, env });
        acceptance.postMigrateCheck = config.hooks?.["post-migrate"] ? "passed" : "not configured";
      }
    } catch (error) {
      entry.result = "failed"; entry.error = error.message; entry.endedAt = new Date().toISOString();
      state.failedAt = step;
      (state.failures ??= []).push({ step, error: error.message, at: entry.endedAt });
      if (STEPS.indexOf(step) < FIRST_DISRUPTIVE) {
        await save();
        log(`FAILED ${step} before anything was stopped: nothing changed. Fix the cause and run again (resume with --from ${step}).`);
      } else {
        // Past the stop the service is down: stop whatever is running, bring the old version back automatically.
        state.recovery = await recoverOldService({ config, state, execute, env, log, runner, switched: state.steps.some(item => item.step === "switch" && item.result === "ok") });
        if (step === "post-check") acceptance.postCheck = "failed";
        acceptance.dataMayBeChanged = STEPS.indexOf(step) >= STEPS.indexOf("migrate");
        if (state.recovery.result === "restored") {
          // The system is back to the old version: the stop-and-after steps no longer describe it.
          for (const item of state.steps) if (STEPS.indexOf(item.step) >= FIRST_UNDONE && item !== entry && (item.result === "ok" || item.result === "skipped")) { item.result = "undone"; item.undoneAt = state.recovery.at; }
        }
        await save();
        log(`FAILED ${step} after the stop. Old service restore: ${state.recovery.result}.${acceptance.dataMayBeChanged ? " The database may already be migrated; check it before trusting the old version." : ""}`);
        log(state.recovery.result === "restored"
          ? `The stop, backup and later steps are marked undone. Resume with --from ${RESUME_AFTER_RECOVERY} (a fresh backup is taken; migrate is NOT safe to resume on its own).`
          : `The old service was not restored. Restore it by hand, then run again with --acknowledge-manual-recovery --from ${RESUME_AFTER_RECOVERY}.`);
      }
      throw error;
    }
    entry.endedAt = new Date().toISOString(); await save();
    // Everything below is recorded, never acted on: a failure here does not trigger a restore.
    if (step === "stop") await counts("countsBefore");
    if (step === "backup") {
      state.backup = { dir: ctx.backupDir, attempt };
      try { const text = await readManifest(join(ctx.backupDir, "manifest.json")); const parsed = JSON.parse(text); state.backup.manifestSha256 = createHash("sha256").update(text).digest("hex"); state.backup.files = Array.isArray(parsed.files) ? parsed.files.length : Object.keys(parsed.files ?? {}).length; }
      catch (error) { state.backup.manifestError = error.message; log(`WARN the backup manifest could not be read: ${error.message}`); }
      const status = await record("migrationsBefore", ["node", "scripts/release/migration-status.mjs"]);
      if (status !== null) acceptance.migrationsBefore = status.split("\n").filter(Boolean);
    }
    if (step === "migrate") {
      const status = await record("migrationsAfter", ["node", "scripts/release/migration-status.mjs"]);
      if (status !== null) { acceptance.migrationsAfter = status.split("\n").filter(Boolean); if (acceptance.migrationsBefore) acceptance.migrationsApplied = acceptance.migrationsAfter.filter(name => !acceptance.migrationsBefore.includes(name)); }
      await counts("countsAfter"); // still stopped: before and after differ only by what the migration did
    }
    await save();
  }
  if (execute && stopAt) { acceptance.downtimeSeconds = Math.round((Date.now() - stopAt) / 1000); log(`downtime (stop to last step): ${acceptance.downtimeSeconds}s`); }
  if (execute && typeof acceptance.countsBefore === "string" && typeof acceptance.countsAfter === "string") acceptance.countsEqual = acceptance.countsBefore === acceptance.countsAfter;
  if (execute && steps.includes("post-check")) {
    // A successful run clears the failure that was being resumed; the history stays in `failures`.
    delete state.failedAt; delete state.recovery; acceptance.postCheck = "passed"; delete acceptance.dataMayBeChanged;
  }
  state.endedAt = new Date().toISOString(); await save();
  return state;
}

// Stop whatever is running first (the new version may be up after a failed post-check or a half-finished start),
// then point the link back, re-point the CLI wrapper and start the previous version. Never throws:
// the outcome is recorded so the operator sees whether the old service is really up.
async function recoverOldService({ config, state, execute, env, log, runner, switched }) {
  if (!execute) return { result: "not attempted (dry run)" };
  if (!state.previous) return { result: "not possible: no previous release was recorded" };
  const prevEnv = { ...env, EVOLOOP_RELEASE_DIR: state.previous, EVOLOOP_RELEASE_SOURCE: config.sourceSubdir ? join(state.previous, config.sourceSubdir) : state.previous };
  const steps = [];
  try {
    await runner(config.hooks.stop, { cwd: state.previous, env }); steps.push("stop");
    if (switched) { await switchLink(config.currentLink, state.previous); steps.push("switch"); }
    if (config.hooks["repoint-cli"]) { await runner(config.hooks["repoint-cli"], { cwd: state.previous, env: prevEnv }); steps.push("repoint-cli"); }
    await runner(config.hooks.start, { cwd: state.previous, env: prevEnv }); steps.push("start");
    await runner(config.hooks["post-check"], { cwd: state.previous, env: prevEnv }); steps.push("post-check");
    return { result: "restored", steps, at: new Date().toISOString() };
  } catch (error) {
    log(`RECOVERY FAILED after ${steps.join(", ") || "no step"}: ${error.message}. The service may be down or the new version may still be running; restore it by hand.`);
    return { result: "failed", steps, error: error.message, at: new Date().toISOString() };
  }
}

// Rollback restores CODE only: stop, point the link at the previous release, start, check.
// Data written under the new schema is never undone here; restore the backup into a new empty
// database as described in docs/architecture/deployment.md.
export async function rollback({ config, id, execute = false, log = console.log, runner = exec }) {
  const state = await readState(config, id);
  if (!state) throw new Error(`No release record for ${id}`);
  if (!state.previous) throw new Error("No previous release recorded (first release); there is no code to roll back to");
  // Before anything is stopped: the link must still be this release (not already rolled back or replaced) and the
  // previous release directory must still exist; otherwise stopping the service could leave nothing to start.
  const current = await currentTarget(config.currentLink);
  const releaseDir = state.releaseDir ?? join(config.releaseRoot, id);
  if (current !== resolve(releaseDir)) throw new Error(`Cannot roll back ${id}: the current link points at ${current ?? "nothing"}, not at this release (${releaseDir}). It may already have been rolled back or replaced by a later release.`);
  if (!(await exists(state.previous))) throw new Error(`Cannot roll back ${id}: the previous release directory ${state.previous} no longer exists.`);
  const env = { EVOLOOP_RELEASE_ID: id, EVOLOOP_RELEASE_DIR: state.previous, EVOLOOP_RELEASE_SOURCE: config.sourceSubdir ? join(state.previous, config.sourceSubdir) : state.previous, EVOLOOP_RELEASE_PREVIOUS: state.previous, EVOLOOP_RELEASE_CURRENT_LINK: config.currentLink };
  const startedAt = new Date().toISOString();
  for (const step of ["stop", "switch", "repoint-cli", "start", "post-check"]) {
    const argv = commandFor(step, config, { id, releaseDir: state.previous });
    log(`${execute ? "RUN " : "PLAN"} rollback ${step}: ${step === "switch" ? `link ${config.currentLink} -> ${state.previous}` : argv ? argv.join(" ") : "(skipped)"}`);
    if (!execute) continue;
    if (step === "switch") await switchLink(config.currentLink, state.previous);
    else if (argv) await runner(argv, { cwd: state.previous, env });
  }
  if (execute) {
    (state.rollbacks ??= []).push({ startedAt, endedAt: new Date().toISOString(), to: state.previous });
    await writeFile(stateFileFor(config, id), JSON.stringify(state, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    id: { type: "string" }, ref: { type: "string", default: "HEAD" }, execute: { type: "boolean", default: false },
    from: { type: "string" }, only: { type: "string" }, config: { type: "string" }, "allow-no-previous": { type: "boolean", default: false },
    "allow-off-main": { type: "boolean", default: false }, "acknowledge-manual-recovery": { type: "boolean", default: false },
  } });
  const command = positionals[0] ?? "plan";
  const path = values.config ?? process.env.EVOLOOP_RELEASE_CONFIG;
  if (!["plan", "run", "rollback"].includes(command) || !path || !values.id || !/^[A-Za-z0-9._-]+$/.test(values.id)) {
    console.error("usage: release.mjs [plan|run|rollback] --id RELEASE_ID [--ref GIT_REF] [--from STEP] [--only A,B] [--allow-no-previous] [--allow-off-main] [--acknowledge-manual-recovery] [--execute]\nconfig: --config PATH or EVOLOOP_RELEASE_CONFIG (outside the repository)");
    process.exit(2);
  }
  try {
    const config = loadConfig(await readFile(path, "utf8"), resolve(path));
    if (command === "rollback") await rollback({ config, id: values.id, execute: values.execute });
    else await run({ config, id: values.id, ref: values.ref, execute: values.execute && command === "run", from: values.from, only: values.only?.split(","), allowNoPrevious: values["allow-no-previous"], allowOffMain: values["allow-off-main"], acknowledgeManualRecovery: values["acknowledge-manual-recovery"] });
  } catch (error) { console.error(error.message); process.exit(1); }
}
