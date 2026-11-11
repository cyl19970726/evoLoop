#!/usr/bin/env node
// Read-only CI timing report from GitHub Actions: per-run and per-step durations,
// queue time, failures and re-run attempts. Uses the authenticated `gh` CLI only.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);

export function percentile(values, p) {
  const sorted = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function summarize(runs) {
  const durations = runs.map(run => run.wallMs);
  const steps = new Map();
  for (const run of runs) for (const step of run.steps) {
    if (!steps.has(step.name)) steps.set(step.name, []);
    steps.get(step.name).push(step.ms);
  }
  return {
    runs: runs.length,
    failed: runs.filter(run => run.conclusion === "failure").length,
    rerun: runs.filter(run => run.attempt > 1).length,
    wallSeconds: { median: sec(percentile(durations, 50)), p90: sec(percentile(durations, 90)), max: sec(Math.max(...durations)) },
    queueSecondsMedian: sec(percentile(runs.map(run => run.queueMs), 50)),
    totalHours: Number((durations.reduce((a, b) => a + b, 0) / 3.6e6).toFixed(2)),
    steps: [...steps].map(([name, values]) => ({ name, medianSeconds: sec(percentile(values, 50)), p90Seconds: sec(percentile(values, 90)) }))
      .sort((a, b) => b.medianSeconds - a.medianSeconds),
  };
}
const sec = v => (v === null || !Number.isFinite(v) ? null : Math.round(v / 100) / 10);

// Run wall time is the sum of job spans from first start to last completion (all jobs, parallel included).
export function runFromJobs(run, jobs) {
  const started = jobs.map(job => job.started_at).filter(Boolean).sort()[0] ?? run.run_started_at;
  const completed = jobs.map(job => job.completed_at).filter(Boolean).sort().at(-1) ?? run.updated_at;
  const created = jobs.map(job => job.created_at).filter(Boolean).sort()[0] ?? run.created_at;
  return {
    id: run.id, branch: run.head_branch, sha: run.head_sha, conclusion: run.conclusion, attempt: run.run_attempt,
    queueMs: ms(created, started), wallMs: ms(started, completed),
    steps: jobs.flatMap(job => job.steps.map(step => ({ name: `${job.name} / ${step.name}`, ms: ms(step.started_at, step.completed_at) })))
      .filter(step => step.ms !== null),
  };
}

function gh(path) { return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 })); }

// Pages through the workflow's completed runs (newest first) until `limit` runs pass `keep`, GitHub has no more
// pages, or the window start (`after`) is passed. Runs newer than `before` are skipped but paging CONTINUES: an
// "earlier than" window can start many pages down. A short sample is always an error, never a silent short result:
// it would change the median and p90 that a before/after comparison depends on.
export function collectRuns(fetchPage, { limit, keep = () => true, before = null, after = null, maxPages = 30 }) {
  const wanted = [];
  const seen = [];
  let reason = "GitHub 没有更多的运行";
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = fetchPage(page); // raw page: never filtered here, an empty FILTERED page must not end paging
    if (!batch.length) break;
    let reachedStart = false;
    for (const run of batch) {
      if (run.conclusion === "cancelled") continue;
      if (before && run.created_at >= before) continue;
      if (after && run.created_at < after) { reachedStart = true; break; }
      seen.push(run);
      if (keep(run) && wanted.length < limit) wanted.push(run);
    }
    if (wanted.length >= limit) return { wanted, seen };
    if (reachedStart) { reason = `已翻到窗口起点 ${after}`; break; }
    if (page === maxPages) reason = `已翻了 ${maxPages} 页(${maxPages * 100} 次运行)`;
  }
  throw new Error(`only ${wanted.length} matching runs found, ${limit} requested (${reason}${before ? `;截止 ${before}` : ""}${after ? `;起点 ${after}` : ""}); widen the window or lower --limit`);
}

// Failure rate must come from every finished run in the same window, not only the successes kept for timing.
export function failureRate(seen) {
  const finished = seen.filter(run => run.conclusion === "success" || run.conclusion === "failure");
  return { finished: finished.length, failed: finished.filter(run => run.conclusion === "failure").length,
    rate: finished.length ? Number((finished.filter(run => run.conclusion === "failure").length / finished.length).toFixed(3)) : null };
}

export const isMain = (metaUrl, argv1) => {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1); } catch { return false; }
};

if (isMain(import.meta.url, process.argv[1])) {
  const { values } = parseArgs({ options: {
    workflow: { type: "string", default: "Application slice" },
    limit: { type: "string", default: "20" },
    branch: { type: "string" },
    event: { type: "string" },
    before: { type: "string" }, after: { type: "string" },
    "success-only": { type: "boolean", default: false },
  } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const slug = JSON.parse(execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], { encoding: "utf8" })).nameWithOwner;
  const flow = gh(`repos/${slug}/actions/workflows`).workflows.find(item => item.name === values.workflow);
  if (!flow) throw new Error(`workflow not found: ${values.workflow}`);
  const fetchPage = page => {
    const query = new URLSearchParams({ per_page: "100", status: "completed", page: String(page) });
    if (values.branch) query.set("branch", values.branch);
    if (values.event) query.set("event", values.event);
    return gh(`repos/${slug}/actions/workflows/${flow.id}/runs?${query}`).workflow_runs;
  };
  const { wanted, seen } = collectRuns(fetchPage, { limit, before: values.before, after: values.after,
    keep: run => !values["success-only"] || run.conclusion === "success" });
  const runs = wanted.map(run => runFromJobs(run, gh(`repos/${slug}/actions/runs/${run.id}/jobs?per_page=100`).jobs));
  process.stdout.write(`${JSON.stringify({ workflow: values.workflow, window: { successOnly: values["success-only"], failures: failureRate(seen) },
    summary: summarize(runs), runs: runs.map(({ steps, ...rest }) => rest) }, null, 2)}\n`);
}
