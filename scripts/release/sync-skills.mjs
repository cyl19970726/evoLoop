// After a release: make the `.agents/skills/` every managed Session workspace reads the same as this release's, or say in the release record why not.
// The workspaces come from the private release config (`skillSync.workspaces`, absolute paths outside the repository). Nothing here fails the release:
// a workspace that cannot be synced is listed with the reason and tried again at the next release.
//   per workspace:   missing / not a git work tree      -> unsynced, with the reason
//                    skills already identical (SHA-256 of every file) -> consistent, untouched
//                    local changes under .agents/skills/ -> unsynced, never touched, never discarded
//                    a process has its working directory there (a Run or a message turn) -> unsynced, never switched while in use
//                    idle and clean, on the base branch  -> fast-forwarded to the release commit
//                    idle and clean, on a detached commit -> detached checkout of the release commit
//                    idle and clean, on any other branch  -> unsynced: a business branch is not switched or moved
//   afterwards every updated workspace is read back and compared file by file with the release; one that still differs is unsynced.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

export const SKILLS_DIR = ".agents/skills";

const run = (argv, { cwd, capture = true } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  child.on("error", reject);
  child.on("close", code => (code === 0 ? resolvePromise(capture ? out : "") : reject(new Error(`${argv.join(" ")} exited ${code}: ${err.trim().slice(0, 300)}`))));
});

/** Every file under `dir` (relative posix path -> SHA-256), or null when the directory does not exist. */
export async function hashTree(dir) {
  const out = new Map();
  const walk = async (current, prefix) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(current, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) out.set(name, createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  };
  try { await walk(dir, ""); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
  return out;
}

/** The names that differ between two hash maps: missing on either side or a different hash. */
export const differences = (want, have) => {
  const names = new Set([...want.keys(), ...(have?.keys() ?? [])]);
  return [...names].filter(name => want.get(name) !== have?.get(name)).sort();
};

/**
 * Processes whose working directory is inside `dir` (a Session or a Run that works there): [{ pid, command }]. null when the list cannot be read.
 * Both sides are compared as real paths: `lsof` reports the real directory (on macOS /private/tmp/…), while the configured workspace may be written through a
 * symlink (/tmp/…), and comparing the two as plain strings would call a workspace in use idle.
 */
export async function processesIn(dir, { lister = defaultLister } = {}) {
  let all; try { all = await lister(); } catch { return null; }
  const real = async path => { try { return await realpath(path); } catch { return path; } };
  const roots = new Set([dir, await real(dir)]);
  const inside = cwd => [...roots].some(root => cwd === root || cwd.startsWith(root + sep));
  const out = [], seen = new Map();
  for (const item of all) {
    if (inside(item.cwd)) { out.push(item); continue; }
    if (!seen.has(item.cwd)) seen.set(item.cwd, await real(item.cwd));
    if (inside(seen.get(item.cwd))) out.push(item);
  }
  return out;
}
async function defaultLister() {
  const out = (await run(["lsof", "-a", "-d", "cwd", "-Fpcn"])).split("\n"), list = [];
  let current = null;
  for (const line of out) {
    if (line[0] === "p") current = { pid: Number(line.slice(1)), command: "", cwd: "" };
    else if (line[0] === "c" && current) current.command = line.slice(1);
    else if (line[0] === "n" && current) { current.cwd = line.slice(1); list.push(current); }
  }
  return list;
}

export function checkSkillSync(skillSync) {
  if (skillSync === undefined || skillSync === false) return null;
  if (typeof skillSync !== "object" || !Array.isArray(skillSync.workspaces) || skillSync.workspaces.some(path => typeof path !== "string" || !isAbsolute(path))) throw new Error("config.skillSync.workspaces must be a list of absolute paths");
  if (skillSync.baseBranch !== undefined && (typeof skillSync.baseBranch !== "string" || !skillSync.baseBranch)) throw new Error("config.skillSync.baseBranch must be a branch name");
  if (skillSync.remote !== undefined && (typeof skillSync.remote !== "string" || !skillSync.remote)) throw new Error("config.skillSync.remote must be a remote name");
  return skillSync;
}

/**
 * Sync one workspace to the release commit `sha`, whose skills are `want` (the hashes of the release's .agents/skills).
 * Returns { path, result: "consistent" | "updated" | "unsynced", reason?, from?, mode? }; never throws.
 */
export async function syncWorkspace({ path, sha, want, baseBranch = "main", remote = "origin", git = (cwd, ...args) => run(["git", "-C", cwd, ...args]), lister }) {
  const skills = join(path, SKILLS_DIR);
  try {
    if (!(await stat(path).then(item => item.isDirectory(), () => false))) return { path, result: "unsynced", reason: "目录不存在" };
    try { await git(path, "rev-parse", "--is-inside-work-tree"); } catch { return { path, result: "unsynced", reason: "不是 git 工作区" }; }
    const before = await hashTree(skills);
    const diffBefore = differences(want, before);
    if (!diffBefore.length) return { path, result: "consistent" };
    const dirty = (await git(path, "status", "--porcelain", "--untracked-files=all", "--", SKILLS_DIR)).split("\n").filter(Boolean);
    if (dirty.length) return { path, result: "unsynced", reason: `技能目录有本地改动（${dirty.length} 项，如 ${dirty[0].trim()}），未动`, differing: diffBefore.length };
    const using = await processesIn(path, { lister });
    if (using === null) return { path, result: "unsynced", reason: "无法列出进程工作目录，不能确认没有在使用，未动", differing: diffBefore.length };
    if (using.length) return { path, result: "unsynced", reason: `正被使用（${using.slice(0, 3).map(item => `${item.command}[${item.pid}]`).join("、")} 的工作目录在这里），未切换`, differing: diffBefore.length };
    const branch = (await git(path, "branch", "--show-current")).trim();
    const head = (await git(path, "rev-parse", "HEAD")).trim();
    try { await git(path, "cat-file", "-e", `${sha}^{commit}`); } catch {
      try { await git(path, "fetch", "--quiet", remote, sha); } catch (error) { return { path, result: "unsynced", reason: `取不到发布提交 ${sha.slice(0, 8)}（${error.message.slice(0, 120)}）`, differing: diffBefore.length }; }
    }
    let mode;
    if (branch === "") { await git(path, "checkout", "--quiet", "--detach", sha); mode = "游离提交，改到发布提交"; }
    else if (branch === baseBranch) {
      try { await git(path, "merge", "--ff-only", "--quiet", sha); } catch (error) { return { path, result: "unsynced", reason: `${baseBranch} 不能快进到发布提交（${error.message.slice(0, 120)}）`, differing: diffBefore.length }; }
      mode = `${baseBranch} 快进到发布提交`;
    } else return { path, result: "unsynced", reason: `在业务分支 ${branch} 上，不切换分支也不移动它`, differing: diffBefore.length };
    const diffAfter = differences(want, await hashTree(skills));
    if (diffAfter.length) return { path, result: "unsynced", reason: `更新后仍有 ${diffAfter.length} 个文件不一致（如 ${diffAfter[0]}）`, from: head.slice(0, 8), differing: diffAfter.length };
    return { path, result: "updated", mode, from: head.slice(0, 8), changed: diffBefore.length };
  } catch (error) { return { path, result: "unsynced", reason: `核对时出错：${error.message.slice(0, 160)}` }; }
}

/** Sync every workspace in the list against the release source tree; returns the facts for the release record, with the one-line summary. */
export async function syncSkills({ workspaces, sourceDir, sha, baseBranch, remote, git, lister }) {
  const want = await hashTree(join(sourceDir, SKILLS_DIR));
  if (!want || !want.size) return { checkedAt: new Date().toISOString(), commit: sha, error: `发布的源码目录里没有 ${SKILLS_DIR}，没有核对`, consistent: 0, updated: 0, unsynced: [], summary: `技能同步：没有核对（发布里没有 ${SKILLS_DIR}）` };
  const results = [];
  for (const path of workspaces) results.push(await syncWorkspace({ path, sha, want, baseBranch, remote, git, lister }));
  const consistent = results.filter(item => item.result === "consistent").length, updated = results.filter(item => item.result === "updated");
  const unsynced = results.filter(item => item.result === "unsynced").map(({ path, reason, differing }) => ({ path, reason, ...(differing ? { differingFiles: differing } : {}) }));
  const total = consistent + updated.length;
  return { checkedAt: new Date().toISOString(), commit: sha, files: want.size, consistent: total, updated: updated.map(({ path, mode, from, changed }) => ({ path, mode, from, changedFiles: changed })), unsynced,
    summary: `技能同步：${workspaces.length} 个工作区，${total} 个一致（其中本次更新 ${updated.length} 个），${unsynced.length} 个未同步${unsynced.length ? "，下次发布再试" : ""}` };
}
