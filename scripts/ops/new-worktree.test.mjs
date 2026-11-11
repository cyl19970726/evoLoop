import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addWorktree, planDeps } from "./new-worktree.mjs";

test("dependencies are cloned only on macOS with a seed whose package-lock is identical", () => {
  const ok = { platform: "darwin", seed: "/seed", seedLock: "a", targetLock: "a", seedHasModules: true };
  assert.equal(planDeps(ok).mode, "clone");
  for (const [over, pattern] of [[{ seed: null }, /没有指定 seed/], [{ platform: "linux" }, /linux/], [{ seedHasModules: false }, /没有安装好/], [{ seedLock: null }, /缺少 package-lock/], [{ seedLock: "b" }, /不一致/]]) {
    const plan = planDeps({ ...ok, ...over });
    assert.equal(plan.mode, "install", JSON.stringify(over));
    assert.match(plan.reason, pattern);
  }
});

const fake = ({ lockSeed, lockTarget, failClone = false, free = [100, 99.9] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "nw-"));
  const seed = join(root, "seed"), path = join(root, "wt");
  mkdirSync(join(seed, "node_modules"), { recursive: true });
  writeFileSync(join(seed, "package-lock.json"), lockSeed ?? "lock");
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "git") { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "package-lock.json"), lockTarget ?? "lock"); }
    if (file === "cp" && failClone) throw new Error("clonefile failed");
    return "";
  };
  const queue = [...free];
  return { seed, path, calls, exec, freeFn: () => queue.shift() * 1024 ** 3 };
};

test("a worktree gets a copy-on-write node_modules from a matching seed, and the disk it used is reported", async () => {
  const f = fake();
  const result = await addWorktree({ repo: "/r", path: f.path, branch: "b", seed: f.seed, platform: "darwin", exec: f.exec, log: () => {}, free: f.freeFn });
  assert.equal(result.deps, "clone");
  assert.ok(f.calls.some(call => call.startsWith(`cp -c -R ${f.seed}/node_modules ${f.path}/node_modules`)));
  assert.ok(!f.calls.some(call => call.startsWith("npm ci")));
  assert.ok(Math.abs(result.freeSpaceUsedBytes - 0.1 * 1024 ** 3) < 1024);
});

test("a different lock file, a failed clone and a non-macOS host all fall back to npm ci", async () => {
  for (const setup of [{ lockTarget: "other" }, { failClone: true }]) {
    const f = fake(setup);
    const result = await addWorktree({ repo: "/r", path: f.path, branch: "b", seed: f.seed, platform: "darwin", exec: f.exec, log: () => {}, free: f.freeFn });
    assert.equal(result.deps, "install", JSON.stringify(setup));
    assert.ok(f.calls.some(call => call.startsWith("npm ci")));
  }
  const linux = fake();
  assert.equal((await addWorktree({ repo: "/r", path: linux.path, branch: "b", seed: linux.seed, platform: "linux", exec: linux.exec, log: () => {}, free: linux.freeFn })).deps, "install");
  await assert.rejects(addWorktree({ repo: "/r", path: "relative", branch: "b" }), /must be absolute/);
});
