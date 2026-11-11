import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectRuns, failureRate, isMain, percentile, runFromJobs, summarize } from "./ci-metrics.mjs";

test("percentile uses nearest rank", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), null);
});

test("run time spans parallel jobs and records queue and steps", () => {
  const run = { id: 1, head_branch: "b", head_sha: "s", conclusion: "success", run_attempt: 2 };
  const jobs = [
    { name: "a", created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:10Z", completed_at: "2026-01-01T00:01:00Z",
      steps: [{ name: "x", started_at: "2026-01-01T00:00:10Z", completed_at: "2026-01-01T00:00:40Z" }] },
    { name: "b", created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:20Z", completed_at: "2026-01-01T00:02:10Z", steps: [] },
  ];
  const result = runFromJobs(run, jobs);
  assert.equal(result.queueMs, 10_000);
  assert.equal(result.wallMs, 120_000);
  assert.deepEqual(result.steps, [{ name: "a / x", ms: 30_000 }]);
  const summary = summarize([result]);
  assert.equal(summary.rerun, 1);
  assert.equal(summary.wallSeconds.median, 120);
});

const mk = (n, conclusion = "success") => ({ id: n, conclusion, created_at: `2026-01-01T00:00:${String(60 - n).padStart(2, "0")}Z` });

test("collectRuns pages until enough kept runs and errors when the window cannot fill the sample", () => {
  const pages = [[mk(1), mk(2, "failure"), mk(3)], [mk(4), mk(5), mk(6, "cancelled")], []];
  const fetched = [];
  const { wanted, seen } = collectRuns(page => { fetched.push(page); return pages[page - 1] ?? []; }, { limit: 4, keep: run => run.conclusion === "success" });
  assert.deepEqual(wanted.map(run => run.id), [1, 3, 4, 5]);
  assert.equal(fetched.length, 2);
  assert.throws(() => collectRuns(page => pages[page - 1] ?? [], { limit: 10, keep: run => run.conclusion === "success" }), /only 4 matching runs found, 10 requested/);
  assert.deepEqual(failureRate(seen), { finished: 5, failed: 1, rate: 0.2 });
});

test("an entry path with spaces or a symlink is still recognised as the script being run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci m "));
  const real = join(dir, "real script.mjs");
  writeFileSync(real, "export {}");
  const link = join(dir, "link.mjs");
  symlinkSync(real, link);
  assert.equal(isMain(new URL(`file://${encodeURI(real)}`).href, link), true);
  assert.equal(isMain(new URL(`file://${encodeURI(real)}`).href, join(dir, "other.mjs")), false);
});

test("the CLI starts when invoked through a symlink with a space in its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci m "));
  const link = join(dir, "link.mjs");
  symlinkSync(join(import.meta.dirname, "ci-metrics.mjs"), link);
  assert.throws(() => execFileSync(process.execPath, [link, "--limit", "0"], { stdio: "pipe" }), error => /--limit must be a positive integer/.test(String(error.stderr)));
});

const day = (index, n) => ({ id: n, conclusion: "success", created_at: new Date(Date.UTC(2026, 10, 11, 0, 0, 0) - index * 60_000).toISOString() });

test("--before keeps paging past pages that are entirely newer than the cutoff (100+ newer runs)", () => {
  const all = Array.from({ length: 260 }, (_, index) => day(index, index)); // newest first, one per minute
  const pages = [];
  for (let start = 0; start < all.length; start += 100) pages.push(all.slice(start, start + 100));
  const cutoff = all[149].created_at; // runs 0..149 are newer than or equal to the cutoff (150 of them, > 1 page)
  const fetched = [];
  const { wanted } = collectRuns(page => { fetched.push(page); return pages[page - 1] ?? []; }, { limit: 20, before: cutoff });
  assert.equal(wanted.length, 20);
  assert.equal(wanted[0].id, 150); // the cutoff run itself is excluded
  assert.equal(wanted.at(-1).id, 169);
  assert.deepEqual(fetched, [1, 2]);
});

test("a window with too few runs is an error, not a short sample: --before and --after both", () => {
  const all = Array.from({ length: 30 }, (_, index) => day(index, index));
  const pages = page => (page === 1 ? all : []);
  assert.throws(() => collectRuns(pages, { limit: 20, before: all[20].created_at }), /only 9 matching runs found, 20 requested.*截止/);
  assert.throws(() => collectRuns(pages, { limit: 20, after: all[9].created_at }), /only 10 matching runs found, 20 requested.*窗口起点/);
  assert.equal(collectRuns(pages, { limit: 10, after: all[9].created_at }).wanted.length, 10);
});

test("a window that has the runs but only under max pages still errors when paging is capped", () => {
  const endless = page => Array.from({ length: 100 }, (_, index) => ({ id: page * 1000 + index, conclusion: "failure", created_at: "2026-01-01T00:00:00Z" }));
  assert.throws(() => collectRuns(endless, { limit: 5, keep: run => run.conclusion === "success", maxPages: 3 }), /已翻了 3 页/);
});
