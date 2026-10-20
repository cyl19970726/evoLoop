import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitDocumentSource } from "../src/index.ts";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("fixed commits, allowed paths, permissions and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "evoloop-git-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "first");
    await writeFile(join(root, "private.md"), "secret");
    await symlink("../private.md", join(root, "docs", "link.md"));
    git(root, "add", "."); git(root, "commit", "-qm", "first");
    const commit = git(root, "rev-parse", "HEAD");
    let authorized = true;
    const source = new GitDocumentSource([{ projectId: "p", repositoryId: "repo", root, allowedPaths: ["docs/"] }], async () => authorized);
    const ref = { projectId: "p", repositoryId: "repo", path: "docs/guide.md", commit, contentHash: sha("first") };
    assert.equal((await source.read(ref)).status, "available");
    await writeFile(join(root, "docs", "guide.md"), "second");
    git(root, "add", "."); git(root, "commit", "-qm", "second");
    const old = await source.read(ref);
    assert.equal(old.status, "available");
    if (old.status === "available") assert.equal(Buffer.from(old.bytes).toString(), "first");
    assert.equal((await source.read({ ...ref, contentHash: sha("second") })).status, "unavailable");
    assert.equal((await source.read({ ...ref, path: "private.md" })).status, "unavailable");
    assert.equal((await source.read({ ...ref, path: "docs/../private.md" })).status, "unavailable");
    assert.equal((await source.read({ ...ref, path: "docs/link.md" })).status, "unavailable");
    assert.equal((await source.read({ ...ref, commit: "--help" })).status, "unavailable");
    authorized = false;
    assert.deepEqual((await source.read(ref)).status, "unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
