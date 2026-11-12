import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MARKER, currentBranch, databaseName, instanceName, instancePath, list, start, stop } from "./test-pg.mjs";
import { repoRoot } from "./disk-reclaim.mjs";

test("instance names map to the worktree and to a database name the integration guard accepts", () => {
  assert.equal(instanceName("wt-Effort"), "wt-effort");
  assert.equal(databaseName("wt-effort"), "evoloop_wt_effort_test");
  assert.match(databaseName("q1b"), /^evoloop(?:_[a-z0-9]+)*_test$/);
  for (const bad of ["", "../x", "a b", "-x", "a/b", "x".repeat(60)]) assert.throws(() => instanceName(bad), /instance name/);
});

test("the instance directory is a direct child of an absolute root outside the repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tp-")));
  assert.equal(instancePath(root, "wt-a"), join(root, "wt-a"));
  assert.throws(() => instancePath("relative", "a"), /absolute/);
  assert.throws(() => instancePath(undefined, "a"), /absolute/);
  assert.throws(() => instancePath(join(repoRoot, "pg"), "a"), /outside the repository/);
  assert.throws(() => instancePath(root, "../escape"), /instance name/);
});

test("start writes the owner marker and returns the URL; stop and list work on the same directory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tp-")));
  const calls = [];
  const exec = (file, args) => { calls.push(`${file.split("/").pop()} ${args.slice(0, 2).join(" ")}`); return ""; };
  const result = await start({ root, name: "wt-a", worktree: "/work/wt-a", binDir: "/pg/bin", exec });
  assert.match(result.url, /^postgres:\/\/evoloop@127\.0\.0\.1:\d+\/evoloop_wt_a_test$/);
  const marker = JSON.parse(readFileSync(join(result.dir, MARKER), "utf8"));
  assert.deepEqual([marker.name, marker.worktree, marker.port], ["wt-a", "/work/wt-a", result.port]);
  assert.deepEqual(list(root).map(item => [item.name, item.worktree]), [["wt-a", "/work/wt-a"]]);
  mkdirSync(join(root, "unmarked"));
  assert.ok(list(root).some(item => item.unmarked));
  assert.equal(stop({ root, name: "wt-a", binDir: "/pg/bin", exec }), result.dir);
  assert.ok(!existsSync(result.dir));
  assert.ok(calls[0].startsWith("initdb") && calls.some(call => call.startsWith("pg_ctl")));
});

test("the owner marker records the branch of the worktree, or an explicit one, so a scoped reclaim can find the instance after the worktree is gone", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tp-")));
  const exec = (file, args) => (file === "git" ? "feat/some-branch\n" : "");
  const detected = await start({ root, name: "wt-b", worktree: "/work/wt-b", binDir: "/pg/bin", exec });
  assert.equal(JSON.parse(readFileSync(join(detected.dir, MARKER), "utf8")).branch, "feat/some-branch");
  const explicit = await start({ root, name: "wt-c", worktree: "/work/wt-c", branch: "explicit", binDir: "/pg/bin", exec });
  assert.equal(JSON.parse(readFileSync(join(explicit.dir, MARKER), "utf8")).branch, "explicit");
  // detached HEAD, no worktree, or git failing give null rather than a made-up name
  assert.equal(currentBranch("/work/x", () => "HEAD\n"), null);
  assert.equal(currentBranch(null, () => "x"), null);
  assert.equal(currentBranch("/work/x", () => { throw new Error("not a repo"); }), null);
  assert.equal(currentBranch("/work/x", () => "main\n"), "main");
});
