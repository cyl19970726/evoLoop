import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SKILLS_DIR, checkSkillSync, differences, hashTree, processesIn, syncSkills, syncWorkspace } from "./sync-skills.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (root, path, text) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
const none = async () => [];

/** A repository with two commits: c1 (skills v1) and c2 (one skill file changed, one added, a business file changed). Returns the paths and both hashes. */
function origin() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-")));
  const repo = join(root, "origin");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, `${SKILLS_DIR}/a/SKILL.md`, "a v1\n"); write(repo, `${SKILLS_DIR}/b/SKILL.md`, "b v1\n"); write(repo, "app.txt", "app v1\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c1");
  const c1 = git(repo, "rev-parse", "HEAD");
  write(repo, `${SKILLS_DIR}/a/SKILL.md`, "a v2\n"); write(repo, `${SKILLS_DIR}/c/SKILL.md`, "c v2\n"); write(repo, "app.txt", "app v2\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c2");
  const c2 = git(repo, "rev-parse", "HEAD");
  return { root, repo, c1, c2 };
}
const clone = (root, repo, name, at) => { const dir = join(root, name); git(root, "clone", "-q", repo, dir); if (at) git(dir, "checkout", "-q", at); return dir; };
const skillHashes = dir => hashTree(join(dir, SKILLS_DIR));

test("S1. a clean idle workspace on main is fast-forwarded, a clean idle one on a detached old commit is checked out: both end with the release's skills, file by file", async () => {
  const { root, repo, c1, c2 } = origin();
  const onMain = clone(root, repo, "on-main"), detached = clone(root, repo, "detached", c1);
  git(onMain, "reset", "-q", "--hard", c1); git(detached, "checkout", "-q", "--detach", c1);
  assert.equal(git(onMain, "branch", "--show-current"), "main");
  const want = await skillHashes(repo);
  const a = await syncWorkspace({ path: onMain, sha: c2, want, lister: none });
  const b = await syncWorkspace({ path: detached, sha: c2, want, lister: none });
  assert.equal(a.result, "updated"); assert.match(a.mode, /main 快进到发布提交/); assert.equal(a.changed, 2, "a changed, c added, b equal: 2 files differ");
  assert.equal(b.result, "updated"); assert.match(b.mode, /游离提交/);
  for (const dir of [onMain, detached]) { assert.deepEqual(differences(want, await skillHashes(dir)), []); assert.equal(git(dir, "rev-parse", "HEAD"), c2); }
  assert.equal(git(onMain, "branch", "--show-current"), "main", "the branch is still main"); assert.equal(git(detached, "branch", "--show-current"), "", "a detached workspace stays detached");
});

test("S2. a workspace with local changes under the skills, or in use, or on a business branch, or not there, is not touched and says why", async () => {
  const { root, repo, c1, c2 } = origin();
  const want = await skillHashes(repo);
  const edited = clone(root, repo, "edited", c1); write(edited, `${SKILLS_DIR}/a/SKILL.md`, "my own change\n"); write(edited, `${SKILLS_DIR}/mine/SKILL.md`, "new skill\n");
  const busy = clone(root, repo, "busy", c1);
  const feature = clone(root, repo, "feature", c1); git(feature, "checkout", "-q", "-b", "feat/x"); write(feature, "own.txt", "unmerged work\n"); git(feature, "add", "-A"); git(feature, "commit", "-q", "-m", "own work"); const featureHead = git(feature, "rev-parse", "HEAD");
  const notRepo = join(root, "plain"); mkdirSync(notRepo);
  const before = { edited: await skillHashes(edited), busy: await skillHashes(busy), feature: await skillHashes(feature) };
  const using = async () => [{ pid: 4242, command: "codex", cwd: join(busy, "apps") }];
  const results = {
    edited: await syncWorkspace({ path: edited, sha: c2, want, lister: none }),
    busy: await syncWorkspace({ path: busy, sha: c2, want, lister: using }),
    feature: await syncWorkspace({ path: feature, sha: c2, want, lister: none }),
    missing: await syncWorkspace({ path: join(root, "nowhere"), sha: c2, want, lister: none }),
    plain: await syncWorkspace({ path: notRepo, sha: c2, want, lister: none }),
  };
  assert.equal(results.edited.result, "unsynced"); assert.match(results.edited.reason, /技能目录有本地改动（\d+ 项.*），未动/);
  assert.equal(results.busy.result, "unsynced"); assert.match(results.busy.reason, /正被使用（codex\[4242\].*未切换/);
  assert.equal(results.feature.result, "unsynced"); assert.match(results.feature.reason, /在业务分支 feat\/x 上，有 1 个提交不在发布提交里（未合并），不切换分支也不移动它/);
  assert.equal(results.missing.reason, "目录不存在"); assert.equal(results.plain.reason, "不是 git 工作区");
  assert.deepEqual(await skillHashes(edited), before.edited, "the local change is still there, byte for byte");
  assert.equal(readFileSync(join(edited, SKILLS_DIR, "a", "SKILL.md"), "utf8"), "my own change\n");
  assert.deepEqual(await skillHashes(busy), before.busy); assert.equal(git(busy, "rev-parse", "HEAD"), c1, "a workspace in use is not switched");
  assert.deepEqual(await skillHashes(feature), before.feature); assert.equal(git(feature, "branch", "--show-current"), "feat/x"); assert.equal(git(feature, "rev-parse", "HEAD"), featureHead);
  const unlisted = await syncWorkspace({ path: busy, sha: c2, want, lister: async () => { throw new Error("no lsof"); } });
  assert.match(unlisted.reason, /无法列出进程工作目录.*未动/, "when processes cannot be listed nothing is assumed idle");
});

test("S3. the summary line and the list: counts of consistent and unsynced, a missing directory does not fail, the second run changes nothing", async () => {
  const { root, repo, c1, c2 } = origin();
  const sourceDir = clone(root, repo, "release-source", c2);
  const idleMain = clone(root, repo, "idle-main", c1), idleDetached = clone(root, repo, "idle-detached", c1); git(idleDetached, "checkout", "-q", "--detach", c1);
  const already = clone(root, repo, "already", c2), edited = clone(root, repo, "edited", c1); write(edited, `${SKILLS_DIR}/b/SKILL.md`, "local\n");
  const workspaces = [idleMain, idleDetached, already, edited, join(root, "gone")];
  const first = await syncSkills({ workspaces, sourceDir, sha: c2, lister: none });
  assert.equal(first.summary, "技能同步：5 个工作区，3 个一致（其中本次更新 2 个），2 个未同步，下次发布再试");
  assert.deepEqual(first.unsynced.map(item => [item.path.split("/").pop(), item.reason.slice(0, 9)]), [["edited", "技能目录有本地改动"], ["gone", "目录不存在"]]);
  assert.equal(first.consistent, 3); assert.equal(first.updated.length, 2); assert.equal(first.commit, c2);
  // the same release again: the two updated ones are consistent now, nothing else moves
  const heads = Object.fromEntries(workspaces.slice(0, 4).map(dir => [dir, git(dir, "rev-parse", "HEAD")]));
  const second = await syncSkills({ workspaces, sourceDir, sha: c2, lister: none });
  assert.equal(second.summary, "技能同步：5 个工作区，3 个一致（其中本次更新 0 个），2 个未同步，下次发布再试");
  assert.deepEqual(second.updated, []);
  for (const dir of workspaces.slice(0, 4)) assert.equal(git(dir, "rev-parse", "HEAD"), heads[dir], `${dir} did not move`);
  assert.equal(git(edited, "status", "--porcelain", "--", SKILLS_DIR), "M .agents/skills/b/SKILL.md", "the local change is untouched and still the only change");
});

test("S4. a release without skills to compare, and the config check: absolute paths only", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-empty-")));
  const none1 = await syncSkills({ workspaces: [join(root, "x")], sourceDir: root, sha: "a".repeat(40), lister: none });
  assert.match(none1.summary, /没有核对（发布里没有 \.agents\/skills）/); assert.equal(none1.unsynced.length, 0);
  assert.equal(checkSkillSync(undefined), null); assert.equal(checkSkillSync(false), null);
  assert.deepEqual(checkSkillSync({ workspaces: ["/srv/a"] }).workspaces, ["/srv/a"]);
  assert.throws(() => checkSkillSync({ workspaces: ["relative/dir"] }), /list of absolute paths/);
  assert.throws(() => checkSkillSync({ workspaces: "/srv/a" }), /list of absolute paths/);
  assert.throws(() => checkSkillSync({ workspaces: [], baseBranch: "" }), /baseBranch/);
});

test("S5. processes: only those whose working directory is the workspace or inside it count", async () => {
  const lister = async () => [{ pid: 1, command: "a", cwd: "/w/one" }, { pid: 2, command: "b", cwd: "/w/one/sub" }, { pid: 3, command: "c", cwd: "/w/one-other" }, { pid: 4, command: "d", cwd: "/w" }];
  assert.deepEqual((await processesIn("/w/one", { lister })).map(item => item.pid), [1, 2]);
  assert.equal(await processesIn("/w/one", { lister: async () => { throw new Error("x"); } }), null);
});

test("S6. a workspace written through a symlink is still seen as in use: the process list is compared by real path (the /tmp -> /private/tmp case)", async () => {
  const { root, repo, c1, c2 } = origin();
  const want = await skillHashes(repo);
  const busy = clone(root, repo, "busy-real", c1);
  const link = join(root, "busy-link");
  symlinkSync(busy, link); // the configured path goes through a symlink, the process's working directory is the real one
  // 1. a process list that reports the real path (what lsof does), and a workspace configured through the link
  const fake = async () => [{ pid: 7, command: "codex", cwd: join(busy, "apps") }];
  assert.deepEqual((await processesIn(link, { lister: fake })).map(item => item.pid), [7]);
  const viaLink = await syncWorkspace({ path: link, sha: c2, want, lister: fake });
  assert.equal(viaLink.result, "unsynced"); assert.match(viaLink.reason, /正被使用（codex\[7\]/);
  assert.equal(git(busy, "rev-parse", "HEAD"), c1, "not switched");
  // 2. the other direction: a process list that reports the link, a workspace configured by its real path
  assert.deepEqual((await processesIn(busy, { lister: async () => [{ pid: 8, command: "claude", cwd: link }] })).map(item => item.pid), [8]);
  // 3. a real process and the default lsof lister, a workspace configured through the link
  const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
  try {
    await new Promise(done => setTimeout(done, 300));
    const real = await syncWorkspace({ path: link, sha: c2, want });
    assert.equal(real.result, "unsynced", "a live process in the workspace is found through the link"); assert.match(real.reason, /正被使用（sleep\[\d+\]/);
    assert.equal(git(busy, "rev-parse", "HEAD"), c1);
  } finally { child.kill(); }
  // a directory that is only similarly named is not inside it
  assert.deepEqual(await processesIn(busy, { lister: async () => [{ pid: 9, command: "x", cwd: `${busy}-other` }] }), []);
});

test("S7. a clean idle workspace on a business branch already merged into the release (0 ahead) is checked out detached at the release commit, the branch is kept, the record says from which branch", async () => {
  const { root, repo, c1, c2 } = origin();
  const want = await skillHashes(repo);
  const merged = clone(root, repo, "merged", c1); git(merged, "checkout", "-q", "-b", "feat/done");
  const result = await syncWorkspace({ path: merged, sha: c2, want, lister: none, runActive: async () => null });
  assert.equal(result.result, "updated"); assert.equal(result.fromBranch, "feat/done"); assert.match(result.mode, /从已合并分支 feat\/done 切到发布提交/);
  assert.equal(git(merged, "rev-parse", "HEAD"), c2); assert.equal(git(merged, "branch", "--show-current"), "", "detached now");
  assert.equal(git(merged, "rev-parse", "feat/done"), c1, "the branch itself is not moved or deleted");
  assert.deepEqual(differences(want, await skillHashes(merged)), []);
  // through syncSkills: the list for the release record carries the branch, the count says updated
  const again = clone(root, repo, "merged2", c1); git(again, "checkout", "-q", "-b", "feat/old");
  const all = await syncSkills({ workspaces: [again], sourceDir: repo, sha: c2, lister: none });
  assert.equal(all.updated[0].fromBranch, "feat/old"); assert.match(all.summary, /1 个一致（其中本次更新 1 个），0 个未同步/);
});

test("S8. a merged branch is still left alone when it has commits ahead, a changed work tree (tracked or untracked, outside the skills too), a process in it, or a Session with a Run in progress; the reason names which", async () => {
  const { root, repo, c1, c2 } = origin();
  const want = await skillHashes(repo);
  const branchAt = name => { const dir = clone(root, repo, name, c1); git(dir, "checkout", "-q", "-b", `feat/${name}`); return dir; };
  const ahead = branchAt("ahead"); write(ahead, "own.txt", "x\n"); git(ahead, "add", "-A"); git(ahead, "commit", "-q", "-m", "own");
  const tracked = branchAt("tracked"); write(tracked, "app.txt", "edited\n");
  const untracked = branchAt("untracked"); write(untracked, "notes.txt", "scratch\n");
  const process_ = branchAt("process");
  const running = branchAt("running");
  const heads = Object.fromEntries([ahead, tracked, untracked, process_, running].map(dir => [dir, git(dir, "rev-parse", "HEAD")]));
  const r = {
    ahead: await syncWorkspace({ path: ahead, sha: c2, want, lister: none }),
    tracked: await syncWorkspace({ path: tracked, sha: c2, want, lister: none }),
    untracked: await syncWorkspace({ path: untracked, sha: c2, want, lister: none }),
    process: await syncWorkspace({ path: process_, sha: c2, want, lister: async () => [{ pid: 55, command: "claude", cwd: process_ }] }),
    running: await syncWorkspace({ path: running, sha: c2, want, lister: none, runActive: async () => "Run 199e7f08" }),
  };
  for (const [name, item] of Object.entries(r)) assert.equal(item.result, "unsynced", name);
  assert.match(r.ahead.reason, /有 1 个提交不在发布提交里（未合并）/);
  assert.match(r.tracked.reason, /分支 feat\/tracked 已合并，但工作树有改动（1 项，如 M app\.txt），未动/);
  assert.match(r.untracked.reason, /分支 feat\/untracked 已合并，但工作树有改动（1 项，如 \?\? notes\.txt）/);
  assert.match(r.process.reason, /正被使用（claude\[55\]/);
  assert.match(r.running.reason, /它的 Session 有进行中的 Run（Run 199e7f08），未切换/);
  for (const dir of Object.keys(heads)) { assert.equal(git(dir, "rev-parse", "HEAD"), heads[dir], `${dir} did not move`); assert.match(git(dir, "branch", "--show-current"), /^feat\//, `${dir} is still on its branch`); }
  assert.equal(readFileSync(join(tracked, "app.txt"), "utf8"), "edited\n", "the change is still there");
  const unknown = await syncWorkspace({ path: running, sha: c2, want, lister: none, runActive: async () => { throw new Error("service down"); } });
  assert.match(unknown.reason, /无法确认它的 Session 有没有进行中的 Run（service down），未动/);
});
