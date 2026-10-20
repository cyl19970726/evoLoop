import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { DocumentSource, GitSourceRead, GitSourceRef, SourceUnavailableReason } from "@evoloop/contracts/sources";

const execute = promisify(execFile);
const maxBytes = 16 * 1024 * 1024;
const hexHash = /^[a-f0-9]{64}$/;
const commitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface RegisteredRepository {
  projectId: string;
  repositoryId: string;
  root: string;
  allowedPaths: readonly string[];
}

function safePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("\0") && !value.includes(":") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("-"));
}
function allowed(path: string, entries: readonly string[]): boolean {
  return entries.some((entry) => path === entry || (entry.endsWith("/") && path.startsWith(entry)));
}
async function git(root: string, args: string[], limit = maxBytes + 4096): Promise<Buffer> {
  const { stdout } = await execute("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: limit, timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } });
  return stdout as Buffer;
}

/** Reads Git objects only. A caller must register repos and supply current access decisions. */
export class GitDocumentSource implements DocumentSource {
  private readonly repos = new Map<string, RegisteredRepository>();
  constructor(repositories: readonly RegisteredRepository[], private readonly mayRead: (ref: GitSourceRef) => Promise<boolean>) {
    for (const repo of repositories) {
      if (!repo.projectId || !repo.repositoryId || !repo.root || repo.allowedPaths.length === 0 ||
        repo.allowedPaths.some((p) => !safePath(p.endsWith("/") ? p.slice(0, -1) : p))) throw new Error("invalid repository registration");
      const key = `${repo.projectId}\0${repo.repositoryId}`;
      if (this.repos.has(key)) throw new Error("duplicate repository registration");
      this.repos.set(key, { ...repo, allowedPaths: [...repo.allowedPaths] });
    }
  }

  async read(ref: GitSourceRef): Promise<GitSourceRead> {
    const unavailable = (reason: SourceUnavailableReason): GitSourceRead => ({ status: "unavailable", ref, reason, observedAt: new Date().toISOString() });
    const repo = this.repos.get(`${ref.projectId}\0${ref.repositoryId}`);
    if (!repo) return unavailable("repository");
    if (!safePath(ref.path) || !allowed(ref.path, repo.allowedPaths) || !commitHash.test(ref.commit) || !hexHash.test(ref.contentHash)) return unavailable("path");
    if (!(await this.mayRead(ref))) return unavailable("permission");
    let root: string;
    try { root = await realpath(repo.root); } catch { return unavailable("repository"); }
    // A registration cannot silently start pointing at a different checkout.
    if ((await lstat(repo.root)).isSymbolicLink()) return unavailable("repository");
    try {
      const resolved = (await git(root, ["rev-parse", "--verify", `${ref.commit}^{commit}`])).toString("utf8").trim();
      if (resolved !== ref.commit) return unavailable("commit");
      const listing = await git(root, ["ls-tree", "-z", ref.commit, "--", ref.path], 4096);
      const records = listing.toString("utf8").split("\0").filter(Boolean);
      const exact = records.find((record) => record.endsWith(`\t${ref.path}`));
      if (!exact) return unavailable("path");
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(exact);
      if (!match) return unavailable("path"); // Reject symlinks, submodules and trees.
      const bytes = await git(root, ["cat-file", "blob", match[2]!]);
      if (bytes.length > maxBytes) return unavailable("path");
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== ref.contentHash) return unavailable("hash_mismatch");
      return { status: "available", ref, bytes, observedAt: new Date().toISOString() };
    } catch { return unavailable("commit"); }
  }
}
