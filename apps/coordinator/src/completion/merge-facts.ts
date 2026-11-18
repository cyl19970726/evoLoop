// The merge fact behind a Task's `merged` completion boundary (Task b5993311): did the PR a Delivery names land on the main line? Read from the project's registered
// local repository with plain `git` (no network, no fetch): the repository the coordinator already reads fixed sources from. The closer's own statement is not an input.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { MergeFact, MergeFactReader } from "@evoloop/contracts";

const run = promisify(execFile);
const mainRefs = ["refs/remotes/origin/main", "refs/heads/main"] as const;

async function git(root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return { ok: true, out: stdout.trim() };
  } catch { return { ok: false, out: "" }; }
}

/** The patch-id of a diff (the same change gives the same id wherever it was applied), or null. */
function patchId(root: string, diff: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn("git", ["-C", root, "patch-id", "--stable"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 10_000);
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", () => { clearTimeout(timer); resolve(out.trim().split(/\s+/)[0] || null); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(diff);
  });
}

/**
 * The merge fact for one repository root, or null when this repository is not one that can tell (no main line at all).
 * The fact is bound to the HEAD the Delivery names, not to the PR number alone (a PR number on main says that some head of that PR landed, not this one):
 * - the head is on the main line (an ancestor of main): merged, whatever commit made it so;
 * - the head is in the repository but not on main, and a squash commit `(#N)` on main carries exactly the head's change (same patch-id as `merge-base..head`): merged by squash;
 * - the head is in the repository, not on main and no such squash matches: not merged (a reworked head that never landed is not merged, whatever its PR number's older head did);
 * - the head is not in the repository: unreadable (nothing can be matched to it), never decided by the PR number.
 */
export async function mergeFactIn(root: string, pullRequest: number, head: string): Promise<MergeFact | null> {
  let mainCommit: string | null = null;
  for (const ref of mainRefs) {
    const resolved = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (resolved.ok && resolved.out) { mainCommit = resolved.out; break; }
  }
  if (!mainCommit) return null;
  if (!(await git(root, ["cat-file", "-e", `${head}^{commit}`])).ok)
    return { state: "unreadable", detail: `仓库里没有头提交 ${head.slice(0, 8)}，没有东西能和它对上（PR 号 #${pullRequest} 不能替代头提交）；仓库可能还没有同步（fetch）` };
  if ((await git(root, ["merge-base", "--is-ancestor", head, mainCommit])).ok)
    return { state: "merged", mainCommit, via: "ancestor", detail: `头提交 ${head.slice(0, 8)} 已在主干 ${mainCommit.slice(0, 8)} 上` };
  // A squash merge leaves no ancestry: the PR number is in the subject, and the head is matched by its change, not by the number.
  const found = await git(root, ["log", mainCommit, "--fixed-strings", `--grep=#${pullRequest}`, "--format=%H%x09%s", "-n", "200"]);
  for (const line of found.out.split("\n")) {
    const [sha, ...rest] = line.split("\t"), subject = rest.join("\t");
    if (!sha || !new RegExp(`\\(#${pullRequest}\\)\\s*$`).test(subject)) continue;
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", sha])).out.split(" ").slice(1);
    if (parents.length !== 1) continue;
    const base = (await git(root, ["merge-base", head, parents[0]!])).out;
    if (!base) continue;
    const [fromHead, fromSquash] = await Promise.all([git(root, ["diff", base, head]), git(root, ["diff", parents[0]!, sha])]);
    if (!fromHead.ok || !fromHead.out || !fromSquash.ok) continue;
    const [headId, squashId] = await Promise.all([patchId(root, `${fromHead.out}\n`), patchId(root, `${fromSquash.out}\n`)]);
    if (headId && headId === squashId)
      return { state: "merged", mainCommit, via: "merge_commit", detail: `主干上的合并提交 ${sha.slice(0, 8)}（${subject.slice(0, 80)}）带的改动与头提交 ${head.slice(0, 8)} 的改动一致` };
  }
  return { state: "not_merged", mainCommit, detail: `头提交 ${head.slice(0, 8)} 在仓库里，但不在主干 ${mainCommit.slice(0, 8)} 上，主干上也没有带着它的改动的 PR #${pullRequest} 合并提交；PR 号在主干上出现过不等于这个头合并了` };
}

/** Reads the merge fact from the repositories registered for the project; the first repository that settles it decides. */
export function gitMergeFacts(repositories: () => ReadonlyArray<{ projectId: string; root: string }>): MergeFactReader {
  return async ({ projectId, pullRequest, head }) => {
    const roots = [...new Set(repositories().filter(item => item.projectId === projectId).map(item => item.root))];
    if (!roots.length) return { state: "unreadable", detail: "这个项目没有登记仓库，系统读不到合并事实" };
    let last = null as MergeFact | null;
    for (const root of roots) {
      const fact = await mergeFactIn(root, pullRequest, head);
      if (!fact) continue;
      if (fact.state === "merged") return fact;
      last = last?.state === "not_merged" ? last : fact;
    }
    return last ?? { state: "unreadable", detail: "登记的仓库里没有 main 分支（refs/remotes/origin/main 或 refs/heads/main），系统读不到合并事实" };
  };
}
