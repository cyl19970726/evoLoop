import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeOpenPrConflicts, openPrMigrationConflicts } from "./lib/migration-numbers.mjs";
import { readOpenPrState } from "./check-open-pr-migrations.mjs";

const M = "packages/adapter-postgres/migrations", S = "packages/adapter-postgres/schema";
const pr = (number, title, files, isDraft = false) => ({ number, title, isDraft, files: files.map(path => ({ path })) });
const pair = (n, name) => [`${M}/${n}_${name}.mjs`, `${S}/${n}_${name}.sql`];
const MAIN = [...pair("109", "relay"), ...pair("110", "ops_alert")];

test("O1. two open PRs that take the same number are reported with both PRs named, whatever the names are", () => {
  const prs = [pr(442, "session unusable ready", [...pair("111", "session_unusable"), "docs/x.md"]), pr(448, "ops alert", pair("111", "ops_alert_again")), pr(450, "other", pair("112", "other"))];
  const { conflicts, next } = openPrMigrationConflicts({ prs, mainFiles: MAIN });
  assert.deepEqual(conflicts.map(item => [item.number, item.prs.map(p => p.number)]), [["111", [442, 448]]]);
  assert.deepEqual(conflicts[0].prs[0].files.sort(), ["migrations/111_session_unusable.mjs", "schema/111_session_unusable.sql"]);
  assert.equal(next, "113", "a number nobody holds: past main and past every open PR");
  const text = describeOpenPrConflicts({ conflicts, next });
  assert.match(text, /迁移号 111 同时被多个开放 PR 使用/);
  assert.match(text, /PR #442 session unusable ready/); assert.match(text, /PR #448 ops alert/);
  assert.match(text, /下一个没人用的号:113/);
});

test("O2. one PR alone on a number is not reported, nor is a PR that edits a migration main already has, nor the PR's own two files (.mjs + .sql)", () => {
  const prs = [pr(1, "a", pair("111", "a")), pr(2, "b", pair("112", "b")), pr(3, "edit", [`${M}/110_ops_alert.mjs`, `${S}/110_ops_alert.sql`]), pr(4, "no migration", ["apps/x.ts"])];
  assert.deepEqual(openPrMigrationConflicts({ prs, mainFiles: MAIN }).conflicts, []);
  assert.deepEqual(openPrMigrationConflicts({ prs: [], mainFiles: MAIN }).conflicts, []);
});

test("O3. a number that main already holds is not a conflict between PRs (that is check:migrations' job); only open PR against open PR", () => {
  const prs = [pr(1, "a", pair("110", "late_a")), pr(2, "b", pair("110", "late_b"))];
  const { conflicts } = openPrMigrationConflicts({ prs, mainFiles: [...MAIN, `${M}/110_ops_alert.mjs`] });
  assert.equal(conflicts.length, 1, "both PRs take 110 with files main does not have: still a conflict between them");
  const onlyMain = openPrMigrationConflicts({ prs: [pr(1, "a", [`${M}/110_ops_alert.mjs`])], mainFiles: MAIN });
  assert.deepEqual(onlyMain.conflicts, []);
});

test("O4. --pr limits the answer to the conflicts that involve that PR; drafts count and are marked; three PRs on one number are all named", () => {
  const prs = [pr(1, "a", pair("111", "a")), pr(2, "b", pair("111", "b"), true), pr(3, "c", pair("111", "c")), pr(7, "x", pair("115", "x")), pr(8, "y", pair("115", "y"))];
  const all = openPrMigrationConflicts({ prs, mainFiles: MAIN });
  assert.deepEqual(all.conflicts.map(item => [item.number, item.prs.map(p => p.number)]), [["111", [1, 2, 3]], ["115", [7, 8]]]);
  const mine = openPrMigrationConflicts({ prs, mainFiles: MAIN, only: 8 });
  assert.deepEqual(mine.conflicts.map(item => item.number), ["115"]);
  assert.deepEqual(openPrMigrationConflicts({ prs, mainFiles: MAIN, only: 99 }).conflicts, []);
  assert.match(describeOpenPrConflicts(all), /PR #2（草稿）|PR #2\(草稿\)/);
});

test("O5. readOpenPrState asks gh for the open PRs with their files and git for the base branch's migration files", () => {
  const calls = [];
  const exec = (file, args) => { calls.push([file, ...args]); return file === "gh" ? JSON.stringify([pr(1, "a", pair("111", "a"))]) : `${MAIN.join("\n")}\n`; };
  const state = readOpenPrState({ repo: "o/r", exec });
  assert.deepEqual(state.mainFiles, MAIN); assert.equal(state.prs.length, 1);
  assert.deepEqual(calls[0].slice(0, 7), ["gh", "pr", "list", "--repo", "o/r", "--state", "open"]);
  assert.ok(calls[0].includes("number,title,isDraft,files"));
  assert.deepEqual(calls[1].slice(0, 5), ["git", "ls-tree", "-r", "--name-only", "origin/main"]);
});

test("O6. the command: exit 1 naming both PRs for a clash that involves --pr, exit 0 when only other PRs clash, exit 2 when gh cannot answer", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-")), data = join(bin, "prs.json");
  const prs = [pr(442, "mine", pair("111", "mine")), pr(448, "theirs", pair("111", "theirs")), pr(500, "alone", pair("120", "alone")), pr(600, "p", pair("130", "p")), pr(601, "q", pair("130", "q"))];
  writeFileSync(data, JSON.stringify(prs));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n[ -f "${join(bin, "broken")}" ] && { echo boom >&2; exit 1; }\ncat "${data}"\n`); chmodSync(join(bin, "gh"), 0o755);
  const run = (...args) => spawnSync(process.execPath, ["scripts/check-open-pr-migrations.mjs", "--base", "HEAD", ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const clash = run("--pr", "442");
  assert.equal(clash.status, 1); assert.match(clash.stderr, /PR #442 mine/); assert.match(clash.stderr, /PR #448 theirs/);
  const other = run("--pr", "500");
  assert.equal(other.status, 0); assert.match(other.stdout, /No open pull request shares a migration number with #500/);
  assert.equal(run().status, 1, "without --pr every clash counts");
  writeFileSync(join(bin, "broken"), "");
  const broken = run("--pr", "442");
  assert.equal(broken.status, 2); assert.match(broken.stderr, /could not run/);
});
