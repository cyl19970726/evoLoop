#!/usr/bin/env node
// Merge entry that refuses to merge a Task's PR without an acceptance pass for its CURRENT head, and
// lists PRs that are accepted and waiting to be merged. Read-only unless `merge --execute` is given.
//
// How a PR is tied to an acceptance (the Delivery record has no PR or commit field, so this is explicit):
//   PR -> Task:     Task ids written in the PR description (8+ hex or a full UUID), resolved against the project.
//   PR head -> Delivery: the Delivery text (technicalEvidence/reason) must name "#<PR number> <head commit prefix>",
//                   e.g. "#339 bb46b90a". A later push changes the head, so an older Delivery no longer matches.
//   Acceptance:     the latest Observation on that Delivery must be `used`, signed by the Task's designated
//                   consumer, and not by the Delivery's own submitter.
// Private values (CLI wrapper path, project id) come from a config file OUTSIDE the repository:
// EVOLOOP_MERGE_CONFIG = {"cli": ["/abs/path/evoloop"], "project": "UUID", "baseBranch": "main", "mergeMethod": "merge"}.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function loadConfig(text, path) {
  const real = (() => { try { return realpathSync(path); } catch { return resolve(path); } })();
  if (!isAbsolute(path) || real.startsWith(repoRoot + sep)) throw new Error("Merge config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  if (!Array.isArray(config.cli) || !config.cli.length || config.cli.some(part => typeof part !== "string") || !isAbsolute(config.cli[0])) throw new Error("config.cli must be an argv array starting with an absolute path");
  if (!/^[0-9a-f-]{36}$/i.test(config.project ?? "")) throw new Error("config.project must be the project UUID");
  return { baseBranch: "main", mergeMethod: "merge", ...config };
}

const HEX = "[0-9a-fA-F]";
/** Task id candidates written in a PR description: full UUIDs and 8-hex prefixes after a "Task" word. */
export function taskReferences(body = "") {
  const found = new Set();
  for (const match of body.matchAll(new RegExp(`\\b(${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12})\\b`, "g"))) found.add(match[1].toLowerCase());
  for (const match of body.matchAll(new RegExp(`task[^0-9a-zA-Z]{0,12}(${HEX}{8})\\b(?!-)`, "gi"))) found.add(match[1].toLowerCase());
  return [...found];
}

/** Resolve references to project Task ids (a reference may be a Document id or a prefix of nothing). */
export function resolveTasks(references, taskIds) {
  const ids = taskIds.map(id => id.toLowerCase());
  return [...new Set(references.flatMap(ref => ids.filter(id => id === ref || (ref.length === 8 && id.startsWith(ref)))))];
}

/** "(#339, bb46b90a)" pairs written in Delivery text: a PR number followed shortly by a commit prefix. */
export function deliveryClaims(text = "") {
  return [...text.matchAll(/#(\d+)[^#\n]{0,40}?\b([0-9a-f]{7,40})\b/g)].map(match => ({ pr: Number(match[1]), commit: match[2] }));
}

const docsOnly = files => files.length > 0 && files.every(file => file.startsWith("docs/") || /\.md$/i.test(file));
const nonDocs = files => files.filter(file => !(file.startsWith("docs/") || /\.md$/i.test(file)));

export function checksProblem(rollup = []) {
  const bad = rollup.filter(check => {
    const state = (check.conclusion ?? check.state ?? check.status ?? "").toUpperCase();
    return !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state);
  });
  return bad.map(check => `${check.name ?? check.context}: ${(check.conclusion ?? check.state ?? check.status ?? "unknown").toLowerCase()}`);
}

/**
 * Decide whether `pr` may be merged. `tasks` maps Task id -> the Task read (task, deliveries, observations, proposal).
 * Returns { verdict: "allow"|"refuse", via: "task"|"no-task", reasons: [...], warnings: [...], accepted?: {...} }.
 */
export function evaluatePr({ pr, files, tasks, taskIds, options = {}, baseBranch = "main" }) {
  const reasons = [], warnings = [];
  if (pr.state !== "OPEN") reasons.push(`PR #${pr.number} 不是打开状态(${pr.state})`);
  if (pr.isDraft) reasons.push(`PR #${pr.number} 是草稿`);
  if (pr.baseRefName !== baseBranch) reasons.push(`PR #${pr.number} 的目标分支是 ${pr.baseRefName},不是 ${baseBranch}`);
  const checks = checksProblem(pr.statusCheckRollup);
  if (checks.length) reasons.push(`检查没有全部通过: ${checks.join("; ")}`);

  const linked = resolveTasks(taskReferences(pr.body), taskIds);
  const head = (pr.headRefOid ?? "").toLowerCase();
  let accepted = null;
  const taskNotes = [];
  for (const id of linked) {
    const data = tasks.get(id);
    if (!data) { taskNotes.push(`Task ${id.slice(0, 8)} 读取失败`); continue; }
    const consumer = data.proposal?.consumer;
    const claimed = [];
    for (const delivery of [...data.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const claims = deliveryClaims(`${delivery.technicalEvidence ?? ""}\n${delivery.reason ?? ""}`).filter(claim => claim.pr === pr.number);
      claimed.push(...claims.map(claim => claim.commit));
      if (!claims.some(claim => head.startsWith(claim.commit.toLowerCase()))) continue;
      const observations = data.observations.filter(item => item.deliveryId === delivery.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = observations.at(-1);
      const where = `Task ${id.slice(0, 8)} 的交付 ${delivery.id.slice(0, 8)}`;
      if (!latest) { taskNotes.push(`${where}对应当前头 ${head.slice(0, 8)},但还没有验收观察(应由 ${consumer ?? "约定验收者"} 签 used)`); continue; }
      if (latest.result !== "used") { taskNotes.push(`${where}的最新观察是 ${latest.result}(${latest.observer}, ${latest.createdAt}),不是 used`); continue; }
      if (consumer && latest.observer !== consumer) { taskNotes.push(`${where}的 used 由 ${latest.observer} 签,约定验收者是 ${consumer}`); continue; }
      if (latest.observer === delivery.submittedByActorId) { taskNotes.push(`${where}的 used 与提交者同为 ${latest.observer},不是独立验收`); continue; }
      accepted = { taskId: id, deliveryId: delivery.id, observer: latest.observer, observerKind: latest.observerKind, passedAt: latest.createdAt, title: data.task.title };
      break;
    }
    if (accepted) break;
    if (!taskNotes.some(note => note.startsWith(`Task ${id.slice(0, 8)} 的交付`)))
      taskNotes.push(`Task ${id.slice(0, 8)}(${data.task.title.slice(0, 30)})没有交付写明 "#${pr.number} ${head.slice(0, 8)}"` + (claimed.length ? `;交付里写的是 ${[...new Set(claimed)].map(c => c.slice(0, 8)).join(", ")}(PR 头已变或写错)` : ""));
  }

  if (accepted) return reasons.length ? { verdict: "refuse", via: "task", reasons, warnings, accepted } : { verdict: "allow", via: "task", reasons, warnings, accepted };

  // No acceptance for this head. Only a documentation-only PR may go in on an explicit declaration.
  if (options.noTaskReason) {
    const code = nonDocs(files);
    if (code.length) reasons.push(`--no-task-reason 只用于文档/决定 PR,但这个 PR 改了非文档文件: ${code.slice(0, 5).join(", ")}${code.length > 5 ? " …" : ""}${linked.length ? `;它还关联 Task ${linked.map(i => i.slice(0, 8)).join(", ")}(是否输错了 PR 号?)` : ""}`);
    else if (!docsOnly(files)) reasons.push("PR 没有改动文件,无法按文档 PR 放行");
    else {
      warnings.push(`按“无 Task 文档/决定 PR”放行: ${options.noTaskReason}。这一步没有验收记录,请确认号码和内容(PR #${pr.number} ${pr.title})。`);
      if (linked.length) warnings.push(`它的描述里提到 Task ${linked.map(i => i.slice(0, 8)).join(", ")},这些 Task 对本头没有通过的验收。`);
      return reasons.length ? { verdict: "refuse", via: "no-task", reasons, warnings } : { verdict: "allow", via: "no-task", reasons, warnings };
    }
  } else if (linked.length) {
    reasons.push(...taskNotes);
  } else {
    reasons.push(`PR #${pr.number} 没有关联到项目里的 Task(描述里没有可解析的 Task ID)。若它是文档/决定 PR,加 --no-task-reason "原因" 放行`);
  }
  return { verdict: "refuse", via: linked.length ? "task" : "no-task", reasons, warnings };
}

// ---- adapters (thin; tests inject fakes) ----

export function makeAdapters(config, exec = execFileSync) {
  const run = (file, args) => exec(file, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const cli = (...args) => JSON.parse(run(config.cli[0], [...config.cli.slice(1), ...args]));
  const gh = (...args) => run("gh", args);
  const repoArgs = config.repo ? ["--repo", config.repo] : [];
  return {
    prView: number => JSON.parse(gh("pr", "view", String(number), ...repoArgs, "--json", "number,title,state,isDraft,baseRefName,headRefName,headRefOid,body,files,statusCheckRollup,url")),
    prOpen: () => JSON.parse(gh("pr", "list", ...repoArgs, "--state", "open", "--limit", "200", "--json", "number,title,state,isDraft,baseRefName,headRefName,headRefOid,body,statusCheckRollup,url")),
    prFiles: number => JSON.parse(gh("pr", "view", String(number), ...repoArgs, "--json", "files")).files.map(file => file.path),
    taskIds: () => { const ids = []; let cursor = null; do { const page = cli("list", "tasks", "--project", config.project, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? null; } while (cursor); return ids; },
    task: id => cli("task", id, "--project", config.project),
    merge: (number, head) => gh("pr", "merge", String(number), ...repoArgs, `--${config.mergeMethod}`, "--match-head-commit", head),
  };
}

async function loadTasks(adapter, pr, taskIds) {
  const linked = resolveTasks(taskReferences(pr.body), taskIds);
  const tasks = new Map();
  for (const id of linked) { try { tasks.set(id, adapter.task(id)); } catch { /* reported as unreadable */ } }
  return tasks;
}

export async function checkPr({ adapter, number, options = {}, baseBranch = "main", taskIds }) {
  const pr = adapter.prView(number);
  const files = (pr.files ?? []).map(file => file.path);
  const ids = taskIds ?? adapter.taskIds();
  const tasks = await loadTasks(adapter, pr, ids);
  return { pr, files, result: evaluatePr({ pr, files, tasks, taskIds: ids, options, baseBranch }) };
}

const hours = ms => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`; };

/** Open PRs that are accepted for their current head, with how long each has been waiting since the pass. */
export async function pendingMerges({ adapter, baseBranch = "main", now = Date.now(), all = false }) {
  const ids = adapter.taskIds();
  const rows = [];
  for (const pr of adapter.prOpen()) {
    const tasks = await loadTasks(adapter, pr, ids);
    const result = evaluatePr({ pr, files: [], tasks, taskIds: ids, options: {}, baseBranch });
    const accepted = result.accepted;
    if (accepted || all) rows.push({ pr: pr.number, title: pr.title, branch: pr.headRefName, head: (pr.headRefOid ?? "").slice(0, 8), ready: result.verdict === "allow",
      blockedBy: result.verdict === "allow" ? [] : result.reasons, task: accepted?.taskId ?? null, taskTitle: accepted?.title ?? null, acceptedBy: accepted?.observer ?? null,
      passedAt: accepted?.passedAt ?? null, waitedMs: accepted ? now - new Date(accepted.passedAt).getTime() : null });
  }
  return rows.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1));
}

export function formatPending(rows, { all = false } = {}) {
  if (!rows.length) return "没有“已验收、PR 仍打开”的项目。";
  return rows.map(row => `#${row.pr} ${row.head} ${row.ready ? "可合并" : row.task ? "已验收但受阻" : "未验收"}` +
    (row.passedAt ? ` · 已等 ${hours(row.waitedMs)}(${row.acceptedBy} 于 ${row.passedAt} 签 used)` : "") + ` · ${row.title}` +
    (row.blockedBy.length ? `\n    受阻: ${row.blockedBy.join("; ")}` : "")).join("\n");
}

export async function mergePr({ adapter, number, options = {}, baseBranch = "main", execute = false, log = console.log, taskIds }) {
  const { pr, result } = await checkPr({ adapter, number, options, baseBranch, taskIds });
  log(`PR #${pr.number} ${pr.headRefName} @ ${pr.headRefOid.slice(0, 8)} — ${pr.title}`);
  if (options.expectTitle && !pr.title.includes(options.expectTitle)) result.reasons.push(`标题不含 "${options.expectTitle}",实际是 "${pr.title}"(号码输错了吗?)`), result.verdict = "refuse";
  for (const warning of result.warnings) log(`提醒: ${warning}`);
  if (result.verdict !== "allow") { log(`拒绝合并 PR #${pr.number}:\n${result.reasons.map(reason => `  - ${reason}`).join("\n")}`); return { merged: false, result }; }
  if (result.accepted) log(`验收: ${result.accepted.observer} 对 Task ${result.accepted.taskId.slice(0, 8)} 的交付 ${result.accepted.deliveryId.slice(0, 8)} 签了 used(${result.accepted.passedAt})`);
  if (!execute) { log("核对通过。加 --execute 才会真正合并(这是预演)。"); return { merged: false, result }; }
  // Re-read the head right before merging, and ask GitHub to merge only that exact commit.
  const fresh = adapter.prView(number);
  if (fresh.headRefOid !== pr.headRefOid) { log(`拒绝合并:核对之后 PR 头从 ${pr.headRefOid.slice(0, 8)} 变成 ${fresh.headRefOid.slice(0, 8)},请重新核对`); return { merged: false, result, headMoved: true }; }
  adapter.merge(number, pr.headRefOid);
  log(`已合并 PR #${number}(${pr.headRefOid.slice(0, 8)})`);
  return { merged: true, result };
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    pr: { type: "string" }, execute: { type: "boolean", default: false }, "no-task-reason": { type: "string" }, "expect-title": { type: "string" },
    json: { type: "boolean", default: false }, all: { type: "boolean", default: false }, config: { type: "string" },
  } });
  const command = positionals[0];
  const path = values.config ?? process.env.EVOLOOP_MERGE_CONFIG;
  if (!["check", "merge", "pending"].includes(command) || !path || (command !== "pending" && !/^\d+$/.test(values.pr ?? ""))) {
    console.error("usage: merge-gate.mjs pending [--all] [--json]\n       merge-gate.mjs check --pr N [--no-task-reason TEXT]\n       merge-gate.mjs merge --pr N [--no-task-reason TEXT] [--expect-title TEXT] [--execute]\nconfig: --config PATH or EVOLOOP_MERGE_CONFIG (outside the repository)");
    process.exit(2);
  }
  try {
    const config = loadConfig(readFileSync(path, "utf8"), resolve(path));
    const adapter = makeAdapters(config);
    const options = { noTaskReason: values["no-task-reason"], expectTitle: values["expect-title"] };
    if (command === "pending") {
      const rows = await pendingMerges({ adapter, baseBranch: config.baseBranch, all: values.all });
      console.log(values.json ? JSON.stringify(rows, null, 2) : formatPending(rows));
    } else {
      const outcome = await mergePr({ adapter, number: Number(values.pr), options, baseBranch: config.baseBranch, execute: command === "merge" && values.execute });
      if (outcome.result.verdict !== "allow" || outcome.headMoved) process.exit(1);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
