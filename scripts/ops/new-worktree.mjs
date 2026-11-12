#!/usr/bin/env node
// Creates a git worktree for a branch and gives it its dependencies without a second 758 MB copy:
// when a seed clone with installed dependencies has the same package-lock.json, its node_modules is cloned
// copy-on-write (APFS `cp -c`, which shares disk blocks until a file changes). Otherwise it runs `npm ci`.
// The seed path comes from --seed or EVOLOOP_DEPS_SEED (a private path, never written into the repository).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");

/** How to give a new worktree its dependencies. Pure, so the choice and its reason can be tested. */
export function planDeps({ platform, seed, seedLock, targetLock, seedHasModules }) {
  if (!seed) return { mode: "install", reason: "没有指定 seed 克隆(--seed 或 EVOLOOP_DEPS_SEED)" };
  if (platform !== "darwin") return { mode: "install", reason: `${platform} 上没有 APFS 写时复制克隆` };
  if (!seedHasModules) return { mode: "install", reason: "seed 克隆里没有安装好的 node_modules" };
  if (!seedLock || !targetLock) return { mode: "install", reason: "缺少 package-lock.json,无法确认依赖一致" };
  if (seedLock !== targetLock) return { mode: "install", reason: "seed 与新工作树的 package-lock.json 不一致,克隆出的依赖会和锁文件对不上" };
  return { mode: "clone", reason: "package-lock.json 一致,按写时复制克隆 seed 的 node_modules" };
}

export async function addWorktree({ repo, path, branch, base = "origin/main", seed = null, platform = process.platform, exec = execFileSync, log = console.log, free = p => { const s = statfsSync(p); return s.bavail * s.bsize; } }) {
  if (!isAbsolute(path)) throw new Error("--path must be absolute");
  const run = (file, args, cwd) => exec(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const before = free(dirname(path));
  run("git", ["-C", repo, "worktree", "add", "-b", branch, path, base]);
  const seedLock = seed && existsSync(join(seed, "package-lock.json")) ? sha(join(seed, "package-lock.json")) : null;
  const targetLock = existsSync(join(path, "package-lock.json")) ? sha(join(path, "package-lock.json")) : null;
  const plan = planDeps({ platform, seed, seedLock, targetLock, seedHasModules: Boolean(seed) && existsSync(join(seed, "node_modules")) });
  log(`deps: ${plan.mode} — ${plan.reason}`);
  if (plan.mode === "clone") {
    try { run("cp", ["-c", "-R", join(seed, "node_modules"), join(path, "node_modules")]); }
    catch (error) { log(`clone failed (${error.message.split("\n")[0]}); falling back to npm ci`); plan.mode = "install"; plan.reason = "克隆失败"; }
  }
  if (plan.mode === "install") run("npm", ["ci", "--no-audit", "--no-fund"], path);
  const after = free(dirname(path));
  const result = { path, branch, deps: plan.mode, reason: plan.reason, freeSpaceUsedBytes: before - after };
  log(`worktree ${path} (${branch}); disk used by creating it: ${(result.freeSpaceUsedBytes / 1024 ** 2).toFixed(0)} MB`);
  return result;
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values } = parseArgs({ options: { path: { type: "string" }, branch: { type: "string" }, base: { type: "string", default: "origin/main" }, seed: { type: "string" }, repo: { type: "string" } } });
  if (!values.path || !values.branch) { console.error("usage: new-worktree.mjs --path ABS_PATH --branch NAME [--base origin/main] [--seed CLONE_WITH_DEPS] [--repo CLONE]\n--seed defaults to EVOLOOP_DEPS_SEED; --repo defaults to the clone containing this script"); process.exit(2); }
  try { await addWorktree({ repo: values.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."), path: values.path, branch: values.branch, base: values.base, seed: values.seed ?? process.env.EVOLOOP_DEPS_SEED ?? null }); }
  catch (error) { console.error(error.message); process.exit(1); }
}
