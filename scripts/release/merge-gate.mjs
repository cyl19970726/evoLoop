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

/**
 * How far after "#N" a commit prefix still counts as written about that PR. A rebase delivery names main's commit first and the new
 * head after it ("#414 rebased onto main 01cf998f, migration 105 kept, all five CI checks green on head 8c8010f" puts the head
 * 64 characters in), so 40 characters missed it; 120 covers a sentence of that shape and stops well before the next sentence.
 */
export const CLAIM_WINDOW = 120;

/**
 * "(#339, bb46b90a)" pairs written in Delivery text: every commit prefix in the window after a PR number (up to the next "#N", a line
 * end, or CLAIM_WINDOW characters), each one a candidate. Only a candidate that is the PR's head, or on its update chain, is ever used
 * (sameCommit against the lineage), so main's commit in the same sentence never matches and cannot be mistaken for the head.
 */
export function deliveryClaims(text = "") {
  const claims = [];
  for (const match of text.matchAll(/#(\d+)([^#\n]*)/g)) {
    const window = match[2].slice(0, CLAIM_WINDOW);
    for (const commit of window.matchAll(/\b([0-9a-f]{7,40})\b/g)) claims.push({ pr: Number(match[1]), commit: commit[1] });
  }
  return claims;
}

const docsOnly = files => files.length > 0 && files.every(file => file.startsWith("docs/") || /\.md$/i.test(file));
const nonDocs = files => files.filter(file => !(file.startsWith("docs/") || /\.md$/i.test(file)));
const TERMINAL_OK = ["SUCCESS", "SKIPPED", "NEUTRAL"];
const stateOf = check => (check.conclusion || check.state || check.status || "unknown").toUpperCase();
const RUNNING = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"];

export function checksProblem(rollup = []) {
  // A running CheckRun has conclusion "" and a status; a StatusContext has only a state.
  return rollup.filter(check => !TERMINAL_OK.includes(stateOf(check))).map(check => `${check.name ?? check.context}: ${stateOf(check).toLowerCase()}`);
}

/** Checks of a head after an update: still running (or not started yet) versus finished and not successful. */
export function checksProgress(rollup = []) {
  if (!rollup.length) return { running: ["(检查还没有开始)"], failed: [] };
  return {
    running: rollup.filter(check => RUNNING.includes(stateOf(check))).map(check => `${check.name ?? check.context}: ${stateOf(check).toLowerCase()}`),
    failed: rollup.filter(check => !TERMINAL_OK.includes(stateOf(check)) && !RUNNING.includes(stateOf(check))).map(check => `${check.name ?? check.context}: ${stateOf(check).toLowerCase()}`),
  };
}

const short = sha => (sha ?? "").slice(0, 8);

/**
 * Lineage of the PR head, newest first: [{ sha, safe, why }]. An entry is `safe` when that commit is only the
 * result of bringing main into the commit below it: exactly two parents, the second one already on main, and
 * either created by GitHub itself (a verified web-flow commit, which is what "Update branch" produces) or equal to
 * the clean merge of its two parents computed locally. Anything else (an author's own commit, a hand-made merge,
 * a merge whose content differs from the clean merge) is not safe and ends the walk.
 */
export async function buildLineage(adapter, headSha, { maxDepth = 8 } = {}) {
  const lineage = [];
  let current = headSha;
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const commit = await adapter.commit(current);
    let safe = false, why = "";
    if (commit.parents.length !== 2) why = `${short(current)} 不是合并提交(${commit.parents.length} 个父提交),是作者的提交`;
    else if (!(await adapter.onMain(commit.parents[1]))) why = `${short(current)} 的第二个父提交 ${short(commit.parents[1])} 不在 main 上`;
    else if (commit.committerEmail === "noreply@github.com" && commit.verified) safe = true;
    else if (commit.tree && (await adapter.cleanMergeTree(commit.parents[0], commit.parents[1])) === commit.tree) safe = true;
    else why = `${short(current)} 不是 GitHub 生成的更新,也无法证明内容只是把 main 合进来`;
    lineage.push({ sha: current, safe, why });
    if (!safe) break;
    current = commit.parents[0];
  }
  return lineage;
}

const sameCommit = (claim, sha) => (sha ?? "").toLowerCase().startsWith(claim.toLowerCase());

/** Does anything the Deliveries say about this PR need to be located in the head's history? */
export function needsLineage({ pr, tasks, options = {} }) {
  if (options.manual?.anchor) return true;
  const claims = [...tasks.values()].flatMap(data => data.deliveries).flatMap(delivery =>
    deliveryClaims(`${delivery.technicalEvidence ?? ""}\n${delivery.reason ?? ""}`)).filter(claim => claim.pr === pr.number);
  return claims.length > 0 && !claims.some(claim => sameCommit(claim.commit, pr.headRefOid));
}

/**
 * Decide whether `pr` may be merged. `tasks` maps Task id -> the Task read (task, deliveries, observations, proposal).
 * `lineage` is the head's history from buildLineage (index 0 = current head); without it only the head itself counts.
 * Returns { verdict: "allow"|"refuse", via, reasons, warnings, accepted?, needsUpdate? }.
 */
export function evaluatePr({ pr, files, tasks, taskIds, options = {}, baseBranch = "main", lineage }) {
  const reasons = [], warnings = [];
  if (pr.state !== "OPEN") reasons.push(`PR #${pr.number} 不是打开状态(${pr.state})`);
  if (pr.isDraft) reasons.push(`PR #${pr.number} 是草稿`);
  if (pr.baseRefName !== baseBranch) reasons.push(`PR #${pr.number} 的目标分支是 ${pr.baseRefName},不是 ${baseBranch}`);
  const checks = checksProblem(pr.statusCheckRollup);
  if (checks.length) reasons.push(`检查没有全部通过: ${checks.join("; ")}`);

  const linked = resolveTasks(taskReferences(pr.body), taskIds);
  const head = (pr.headRefOid ?? "").toLowerCase();
  const chain = lineage?.length ? lineage : [{ sha: head, safe: false, why: "" }];
  const manual = options.manual;
  const candidates = manual?.taskId ? [manual.taskId.toLowerCase()] : linked;
  let accepted = null;
  const taskNotes = [];

  /** Walk down from the head to index `at`: every commit above it must be a proven update of main. */
  const stopped = chain.at(-1) && !chain.at(-1).safe && chain.at(-1).why ? `;更新链在 ${chain.at(-1).why} 处中断` : "";
  const pathProblem = at => {
    for (let index = 0; index < at; index += 1) if (!chain[index].safe) return `头 ${short(head)} 之上的提交不是只把 main 合进来的更新(${chain[index].why || short(chain[index].sha)}),作者新增了内容,需重新交付和验收`;
    return null;
  };

  const acceptance = (id, data, delivery, at) => {
    const consumer = data.proposal?.consumer;
    const where = `Task ${id.slice(0, 8)} 的交付 ${delivery.id.slice(0, 8)}`;
    const problem = pathProblem(at);
    if (problem) return { note: `${where}对应 ${short(chain[at].sha)},但${problem}` };
    const latest = data.observations.filter(item => item.deliveryId === delivery.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!latest) return { note: `${where}对应 ${short(chain[at].sha)},但还没有验收观察(应由 ${consumer ?? "约定验收者"} 签 used)` };
    if (latest.result !== "used") return { note: `${where}的最新观察是 ${latest.result}(${latest.observer}, ${latest.createdAt}),不是 used` };
    if (consumer && latest.observer !== consumer) return { note: `${where}的 used 由 ${latest.observer} 签,约定验收者是 ${consumer}` };
    if (latest.observer === delivery.submittedByActorId) return { note: `${where}的 used 与提交者同为 ${latest.observer},不是独立验收` };
    return { accepted: { taskId: id, deliveryId: delivery.id, observer: latest.observer, observerKind: latest.observerKind, passedAt: latest.createdAt, title: data.task.title, headSha: chain[at].sha, updated: at > 0 } };
  };

  if (manual) {
    // Transitional hand mapping: the merger names the Delivery; Task ownership, the observation and independence are still checked.
    const holder = candidates.find(id => tasks.get(id)?.deliveries.some(delivery => delivery.id.toLowerCase() === manual.deliveryId.toLowerCase()));
    if (!holder) {
      reasons.push(manual.taskId
        ? `交付 ${manual.deliveryId.slice(0, 8)} 不属于 Task ${manual.taskId.slice(0, 8)}(或该 Task 读取失败)`
        : `交付 ${manual.deliveryId.slice(0, 8)} 不属于 PR 描述里关联的 Task${linked.length ? `(${linked.map(i => i.slice(0, 8)).join(", ")})` : "(描述里没有可解析的 Task ID)"};请加 --task TASK_ID`);
    } else {
      const data = tasks.get(holder);
      const delivery = data.deliveries.find(item => item.id.toLowerCase() === manual.deliveryId.toLowerCase());
      const anchor = (manual.anchor ?? head).toLowerCase();
      const at = chain.findIndex(entry => entry.sha.toLowerCase() === anchor);
      if (at < 0) reasons.push(`人工声明的头 ${short(anchor)} 已不在 PR 的更新链上(作者在其后新增了提交或改写了历史)${stopped},需重新交付和验收`);
      else {
        const outcome = acceptance(holder, data, delivery, at);
        if (outcome.note) reasons.push(outcome.note); else accepted = outcome.accepted;
      }
      const claims = deliveryClaims(`${delivery.technicalEvidence ?? ""}\n${delivery.reason ?? ""}`);
      const verified = claims.some(claim => claim.pr === pr.number && sameCommit(claim.commit, chain[Math.max(at, 0)].sha));
      warnings.push(`【人工声明·仅过渡期】发布负责人声明交付 ${delivery.id.slice(0, 8)}(Task ${holder.slice(0, 8)})覆盖 PR #${pr.number} 的头 ${short(anchor)}。`
        + (verified ? "交付文本里写的 PR 号与头提交与此一致,这一项已自动核对。" : `交付文本里没有写明 "#${pr.number} ${short(anchor)}",PR 与头提交的对应关系**没有被自动核对,由声明者负责**。`));
      if (claims.some(claim => claim.pr === pr.number) && !verified) warnings.push(`注意:交付里写的是 ${[...new Set(claims.filter(claim => claim.pr === pr.number).map(claim => short(claim.commit)))].join(", ")},与声明的头不同。`);
      if (manual.taskId && !linked.includes(manual.taskId.toLowerCase())) warnings.push(`PR 描述里没有 Task ${manual.taskId.slice(0, 8)},这是人工指定的归属。`);
    }
  } else {
    for (const id of candidates) {
      const data = tasks.get(id);
      if (!data) { taskNotes.push(`Task ${id.slice(0, 8)} 读取失败`); continue; }
      const claimed = [];
      for (const delivery of [...data.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const claims = deliveryClaims(`${delivery.technicalEvidence ?? ""}\n${delivery.reason ?? ""}`).filter(claim => claim.pr === pr.number);
        claimed.push(...claims.map(claim => claim.commit));
        const at = chain.findIndex(entry => claims.some(claim => sameCommit(claim.commit, entry.sha)));
        if (at < 0) continue;
        const outcome = acceptance(id, data, delivery, at);
        if (outcome.note) { taskNotes.push(outcome.note); continue; }
        accepted = outcome.accepted;
        break;
      }
      if (accepted) break;
      if (!taskNotes.some(note => note.startsWith(`Task ${id.slice(0, 8)} 的交付`)))
        taskNotes.push(`Task ${id.slice(0, 8)}(${data.task.title.slice(0, 30)})没有交付写明 "#${pr.number} ${head.slice(0, 8)}"` + (claimed.length ? `;交付里写的是 ${[...new Set(claimed)].map(c => c.slice(0, 8)).join(", ")}(PR 头已变或写错;若只是落后 main,脚本只认头上是 GitHub 生成的“把 main 合进来”的更新)${stopped}` : ""));
    }
  }

  if (accepted) {
    let needsUpdate = false;
    if (pr.mergeStateStatus === "BEHIND") { needsUpdate = true; reasons.push(`已验收,但 PR 落后于 ${baseBranch}(BEHIND)。加 --update-branch:脚本请求 GitHub 更新、等检查通过,只接受第一父提交是 ${short(accepted.headSha)}、另一父在 ${baseBranch} 上的更新`); }
    if (pr.mergeStateStatus === "DIRTY") reasons.push("PR 与目标分支有冲突,需要作者解决并重新交付和验收");
    return { verdict: reasons.length ? "refuse" : "allow", via: "task", reasons, warnings, accepted, needsUpdate };
  }
  if (manual) return { verdict: "refuse", via: "task", reasons, warnings };

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
    reasons.push(`PR #${pr.number} 没有关联到项目里的 Task(描述里没有可解析的 Task ID)。若它是文档/决定 PR,加 --no-task-reason "原因" 放行;若是旧交付,用 --delivery 交付ID --task TASK_ID 人工对应`);
  }
  return { verdict: "refuse", via: linked.length ? "task" : "no-task", reasons, warnings };
}

// ---- adapters (thin; tests inject fakes) ----

export function makeAdapters(config, exec = execFileSync) {
  const run = (file, args) => exec(file, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const cli = (...args) => JSON.parse(run(config.cli[0], [...config.cli.slice(1), ...args]));
  const gh = (...args) => run("gh", args);
  const repoArgs = config.repo ? ["--repo", config.repo] : [];
  let slug = config.repo ?? null;
  const repo = () => slug ??= JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner;
  const api = (path, ...extra) => JSON.parse(gh("api", ...extra, `repos/${repo()}/${path}`));
  const fields = "number,title,state,isDraft,baseRefName,headRefName,headRefOid,body,statusCheckRollup,mergeStateStatus,url";
  return {
    prView: number => JSON.parse(gh("pr", "view", String(number), ...repoArgs, "--json", `${fields},files`)),
    prOpen: () => JSON.parse(gh("pr", "list", ...repoArgs, "--state", "open", "--limit", "200", "--json", fields)),
    taskIds: () => { const ids = []; let cursor = null; do { const page = cli("list", "tasks", "--project", config.project, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? null; } while (cursor); return ids; },
    task: id => cli("task", id, "--project", config.project),
    commit: sha => { const data = api(`commits/${sha}`); return { sha: data.sha, parents: data.parents.map(parent => parent.sha), tree: data.commit.tree.sha, committerEmail: data.commit.committer?.email, verified: data.commit.verification?.verified === true }; },
    // A commit is on main when comparing main...commit says the commit is behind or identical.
    onMain: sha => ["behind", "identical"].includes(api(`compare/${config.baseBranch ?? "main"}...${sha}`).status),
    // Clean merge of two commits computed locally (needs the objects); null when it cannot be computed or conflicts.
    cleanMergeTree: (first, second) => {
      try { run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", first, second]); return run("git", ["-C", repoRoot, "merge-tree", "--write-tree", first, second]).trim().split("\n")[0]; } catch { return null; }
    },
    updateBranch: (number, head) => { gh("api", "-X", "PUT", `repos/${repo()}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${head}`); },
    merge: (number, head) => gh("pr", "merge", String(number), ...repoArgs, `--${config.mergeMethod}`, "--match-head-commit", head),
  };
}

async function loadTasks(adapter, pr, taskIds, options = {}) {
  const wanted = new Set(resolveTasks(taskReferences(pr.body), taskIds));
  if (options.manual?.taskId) wanted.add(options.manual.taskId.toLowerCase());
  const tasks = new Map();
  for (const id of wanted) { try { tasks.set(id, adapter.task(id)); } catch { /* reported as unreadable */ } }
  return tasks;
}

export async function checkPr({ adapter, number, options = {}, baseBranch = "main", taskIds }) {
  const pr = adapter.prView(number);
  const files = (pr.files ?? []).map(file => file.path);
  const ids = taskIds ?? adapter.taskIds();
  if (options.manual?.taskId && !ids.map(id => id.toLowerCase()).includes(options.manual.taskId.toLowerCase())) throw new Error(`--task ${options.manual.taskId} 不是这个项目的 Task`);
  const tasks = await loadTasks(adapter, pr, ids, options);
  const lineage = needsLineage({ pr, tasks, options }) ? await buildLineage(adapter, pr.headRefOid) : undefined;
  return { pr, files, result: evaluatePr({ pr, files, tasks, taskIds: ids, options, baseBranch, lineage }) };
}

const hours = ms => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`; };

/** Open PRs that are accepted for their current head (or a proven update of it), with how long each has been waiting. */
export async function pendingMerges({ adapter, baseBranch = "main", now = Date.now(), all = false }) {
  const ids = adapter.taskIds();
  const rows = [];
  for (const pr of adapter.prOpen()) {
    const tasks = await loadTasks(adapter, pr, ids);
    const lineage = needsLineage({ pr, tasks }) ? await buildLineage(adapter, pr.headRefOid) : undefined;
    const result = evaluatePr({ pr, files: [], tasks, taskIds: ids, options: {}, baseBranch, lineage });
    const accepted = result.accepted;
    if (accepted || all) rows.push({ pr: pr.number, title: pr.title, branch: pr.headRefName, head: short(pr.headRefOid), ready: result.verdict === "allow", needsUpdate: Boolean(result.needsUpdate),
      updatedSinceAcceptance: Boolean(accepted?.updated), blockedBy: result.verdict === "allow" ? [] : result.reasons, task: accepted?.taskId ?? null, taskTitle: accepted?.title ?? null,
      acceptedBy: accepted?.observer ?? null, passedAt: accepted?.passedAt ?? null, waitedMs: accepted ? now - new Date(accepted.passedAt).getTime() : null });
  }
  return rows.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1));
}

export function formatPending(rows) {
  if (!rows.length) return "没有“已验收、PR 仍打开”的项目。";
  return rows.map(row => `#${row.pr} ${row.head} ${row.ready ? "可合并" : row.needsUpdate ? "已验收，需更新分支" : row.task ? "已验收但受阻" : "未验收"}` +
    (row.passedAt ? ` · 已等 ${hours(row.waitedMs)}(${row.acceptedBy} 于 ${row.passedAt} 签 used)` : "") + ` · ${row.title}` +
    (row.blockedBy.length && !row.needsUpdate ? `\n    受阻: ${row.blockedBy.join("; ")}` : "")).join("\n");
}

const defaultSleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const DEFAULT_WAITS = { headMs: 120_000, checksMs: 1_200_000, intervalMs: 5_000 };

/**
 * Ask GitHub to update the PR branch from main at the accepted head H, wait for the new head and its checks.
 * Returns { ok: true } or { ok: false, reason }. Nothing is merged here.
 */
async function updateAcceptedBranch({ adapter, number, expectedHead, waits, sleep, log }) {
  adapter.updateBranch(number, expectedHead);
  log(`已请求 GitHub 更新 PR #${number}(expected head ${short(expectedHead)}),等待新头…`);
  const started = Date.now();
  let view = adapter.prView(number);
  while (view.headRefOid === expectedHead) {
    if (Date.now() - started > waits.headMs) return { ok: false, reason: `请求更新后 ${Math.round(waits.headMs / 1000)} 秒内 PR 头没有变化,未合并` };
    await sleep(waits.intervalMs); view = adapter.prView(number);
  }
  log(`新头 ${short(view.headRefOid)},等待检查…`);
  const waitStart = Date.now();
  for (;;) {
    const progress = checksProgress(view.statusCheckRollup);
    if (progress.failed.length) return { ok: false, reason: `更新后的检查没有通过: ${progress.failed.join("; ")},未合并` };
    if (!progress.running.length) return { ok: true, head: view.headRefOid };
    if (Date.now() - waitStart > waits.checksMs) return { ok: false, reason: `更新后的检查在 ${Math.round(waits.checksMs / 60000)} 分钟内没有完成(${progress.running.join("; ")}),未合并` };
    await sleep(waits.intervalMs); view = adapter.prView(number);
  }
}

export async function mergePr({ adapter, number, options = {}, baseBranch = "main", execute = false, log = console.log, taskIds, waits = DEFAULT_WAITS, sleep = defaultSleep }) {
  let { pr, result } = await checkPr({ adapter, number, options, baseBranch, taskIds });
  log(`PR #${pr.number} ${pr.headRefName} @ ${short(pr.headRefOid)} — ${pr.title}`);
  if (options.expectTitle && !pr.title.includes(options.expectTitle)) result.reasons.push(`标题不含 "${options.expectTitle}",实际是 "${pr.title}"(号码输错了吗?)`), result.verdict = "refuse";
  const printWarnings = () => { for (const warning of result.warnings) log(`提醒: ${warning}`); };
  printWarnings();

  if (result.needsUpdate && options.updateBranch) {
    // Only the "behind main" reason is being worked on here; any other reason still refuses.
    const others = result.reasons.filter(reason => !reason.startsWith("已验收,但 PR 落后于"));
    if (others.length) result.reasons = others;
    else if (!execute) { log(`预演:验收头 ${short(result.accepted.headSha)} 已核对,将请求 GitHub 更新分支、等检查,再只合并“把 ${baseBranch} 合进来”的新头。加 --execute 才会执行。`); return { merged: false, result }; }
    else {
      const anchor = result.accepted.headSha;
      const update = await updateAcceptedBranch({ adapter, number, expectedHead: pr.headRefOid, waits, sleep, log });
      if (!update.ok) { log(`拒绝合并 PR #${number}:\n  - ${update.reason}`); return { merged: false, result: { ...result, verdict: "refuse", reasons: [update.reason] } }; }
      // Re-check from scratch. For a hand mapping the accepted head is pinned so that an author commit after it still fails.
      ({ pr, result } = await checkPr({ adapter, number, baseBranch, taskIds, options: { ...options, manual: options.manual ? { ...options.manual, anchor } : undefined } }));
      log(`更新后重新核对 PR #${number} @ ${short(pr.headRefOid)}`);
      printWarnings();
      if (result.accepted) log(`验收头 ${short(anchor)} → 当前头 ${short(pr.headRefOid)}:${result.accepted.updated ? "只是把 main 合进来的更新" : "头没有变化"}`);
    }
  }
  if (result.verdict !== "allow") { log(`拒绝合并 PR #${pr.number}:\n${result.reasons.map(reason => `  - ${reason}`).join("\n")}`); return { merged: false, result }; }
  if (result.accepted) log(`验收: ${result.accepted.observer} 对 Task ${result.accepted.taskId.slice(0, 8)} 的交付 ${result.accepted.deliveryId.slice(0, 8)} 签了 used(${result.accepted.passedAt})`);
  if (!execute) { log("核对通过。加 --execute 才会真正合并(这是预演)。"); return { merged: false, result }; }
  // Re-read the head right before merging, and ask GitHub to merge only that exact commit.
  const fresh = adapter.prView(number);
  if (fresh.headRefOid !== pr.headRefOid) { log(`拒绝合并:核对之后 PR 头从 ${short(pr.headRefOid)} 变成 ${short(fresh.headRefOid)},请重新核对`); return { merged: false, result, headMoved: true }; }
  adapter.merge(number, pr.headRefOid);
  log(`已合并 PR #${number}(${short(pr.headRefOid)})`);
  return { merged: true, result };
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    pr: { type: "string" }, execute: { type: "boolean", default: false }, "no-task-reason": { type: "string" }, "expect-title": { type: "string" },
    "update-branch": { type: "boolean", default: false }, delivery: { type: "string" }, task: { type: "string" },
    json: { type: "boolean", default: false }, all: { type: "boolean", default: false }, config: { type: "string" },
  } });
  const command = positionals[0];
  const path = values.config ?? process.env.EVOLOOP_MERGE_CONFIG;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!["check", "merge", "pending"].includes(command) || !path || (command !== "pending" && !/^\d+$/.test(values.pr ?? "")) ||
      (values.delivery && !uuid.test(values.delivery)) || (values.task && !uuid.test(values.task)) || (values.task && !values.delivery)) {
    console.error("usage: merge-gate.mjs pending [--all] [--json]\n       merge-gate.mjs check|merge --pr N [--no-task-reason TEXT] [--delivery DELIVERY_UUID [--task TASK_UUID]] [--update-branch] [--expect-title TEXT] [--execute]\nconfig: --config PATH or EVOLOOP_MERGE_CONFIG (outside the repository)");
    process.exit(2);
  }
  try {
    const config = loadConfig(readFileSync(path, "utf8"), resolve(path));
    const adapter = makeAdapters(config);
    const options = { noTaskReason: values["no-task-reason"], expectTitle: values["expect-title"], updateBranch: values["update-branch"],
      manual: values.delivery ? { deliveryId: values.delivery, taskId: values.task } : undefined };
    if (command === "pending") {
      const rows = await pendingMerges({ adapter, baseBranch: config.baseBranch, all: values.all });
      console.log(values.json ? JSON.stringify(rows, null, 2) : formatPending(rows));
    } else {
      const outcome = await mergePr({ adapter, number: Number(values.pr), options, baseBranch: config.baseBranch, execute: command === "merge" && values.execute });
      if (outcome.result.verdict !== "allow" || outcome.headMoved) process.exit(1);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
