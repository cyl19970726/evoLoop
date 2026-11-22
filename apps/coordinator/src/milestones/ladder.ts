// The verification ladder of one project (`GET /api/projects/:id/ladder`, Task f6debf43; design: docs/frontend/milestones-design.md §3).
// The roadmap is read from the repositories the project registered, with plain read-only `git` (no network, no fetch), never from the deployed checkout:
// a second project must not see evoLoop's own M0 to M4. "No roadmap" is an answer (`available:false`); a repository that cannot be read is an error.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LadderView } from "@evoloop/contracts/milestones";
import { parseRoadmapPhases } from "./index.js";

const run = promisify(execFile);
const mainRefs = ["refs/remotes/origin/main", "refs/heads/main"] as const;
const roadmapPath = "docs/roadmap.md";

export interface LadderEvidence { id: string; shortName: string; ladderKeys: string[] }

/** The repository cannot be read (no main ref, git failed). Different from "there is no roadmap". */
export class LadderUnreadable extends Error {}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  return stdout;
}

/** The commit of the default branch (`refs/remotes/origin/main`, else `refs/heads/main`) and the roadmap text there; text null when the file is not in that commit. */
export async function readRoadmapAt(root: string): Promise<{ commit: string; text: string | null }> {
  let commit: string | null = null;
  for (const ref of mainRefs) {
    try { const out = (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim(); if (out) { commit = out; break; } } catch { /* ref absent: try the next */ }
  }
  if (!commit) throw new LadderUnreadable("阶梯读不到：登记的仓库里没有 main 分支（refs/remotes/origin/main 或 refs/heads/main）");
  try {
    if (!(await git(root, ["ls-tree", commit, "--", roadmapPath])).trim()) return { commit, text: null };
    return { commit, text: await git(root, ["show", `${commit}:${roadmapPath}`]) };
  } catch { throw new LadderUnreadable("阶梯读不到：登记的仓库读路线图时出错（权限或读写）"); }
}

/** First sentence of a status cell: up to and including the first full stop. */
export function firstSentence(text: string): string {
  const stripped = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "").trim();
  const end = stripped.indexOf("。");
  return end < 0 ? stripped : stripped.slice(0, end + 1);
}

/** Status per phase from the "| 阶段 | 现在的状态 |" table. */
export function parseStatuses(markdown: string): Map<string, string> {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => /^\|\s*阶段\s*\|\s*现在的状态/.test(line));
  const out = new Map<string, string>();
  if (start < 0) return out;
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
    const key = /^(M[0-9]+(?:\.[0-9]+)?)\b/.exec(cells[0] ?? "")?.[1];
    if (key && cells.length >= 2) out.set(key, firstSentence(cells.slice(1).join("|")));
  }
  return out;
}

export function buildLadder(markdown: string, commit: string, evidence: LadderEvidence[]): LadderView | null {
  const phases = parseRoadmapPhases(markdown);
  if (!phases.length) return null;
  const statuses = parseStatuses(markdown);
  return { available: true, source: { commit }, levels: phases.map(phase => ({
    key: phase.id, name: phase.title, status: statuses.get(phase.id) || null,
    evidenceStages: evidence.filter(stage => stage.ladderKeys.includes(phase.id)).map(stage => ({ id: stage.id, shortName: stage.shortName })),
  })) };
}

/** The first registered repository (in registration order) whose default branch has a roadmap with the phase table decides. */
export async function readLadder(roots: string[], evidence: LadderEvidence[]): Promise<LadderView> {
  let unreadable: LadderUnreadable | null = null;
  for (const root of roots) {
    try {
      const { commit, text } = await readRoadmapAt(root);
      const view = text === null ? null : buildLadder(text, commit, evidence);
      if (view) return view;
    } catch (error) {
      if (!(error instanceof LadderUnreadable)) throw error;
      unreadable ??= error;
    }
  }
  if (unreadable) throw unreadable;
  return { available: false, source: { commit: null }, levels: [] };
}
