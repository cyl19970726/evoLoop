import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAIM_WINDOW, checkPr, deliveryClaims, evaluatePr, formatPending, loadConfig, mergePr, pendingMerges, repoRoot, resolveTasks, taskReferences } from "./merge-gate.mjs";

const T1 = "bcce4633-1111-4222-8333-444455556666"; // the #330 Task: delivered, never accepted
const T2 = "1a886c5b-d5cb-4d62-b026-58d2660f236b"; // an accepted Task
const DOC = "19068463-d1c8-419e-bf61-4d05b9d333a9"; // a Document id, not a Task
const HEAD = "bb46b90a1234567890abcdef1234567890abcdef";

const pr = (over = {}) => ({ number: 339, title: "ci: parallel", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "ci/x", headRefOid: HEAD,
  body: `Task ${T2.slice(0, 8)}`, statusCheckRollup: [{ name: "app", conclusion: "SUCCESS" }, { name: "docs", conclusion: "SUCCESS" }], ...over });
const delivery = (over = {}) => ({ id: "d1111111-0000-4000-8000-000000000001", createdAt: "2026-11-11T10:00:00Z", submittedByActorId: "dev", technicalEvidence: "新 head:#339 bb46b90a 全绿", reason: "", ...over });
const obs = (over = {}) => ({ id: "o1", deliveryId: "d1111111-0000-4000-8000-000000000001", observer: "requirements-claude-agent", observerKind: "agent", result: "used", createdAt: "2026-11-11T11:00:00Z", ...over });
const taskData = (id, deliveries, observations, consumer = "requirements-claude-agent") => ({ task: { id, title: `Task ${id.slice(0, 8)}` }, proposal: { consumer }, deliveries, observations });
const evaluate = (over = {}) => evaluatePr({ pr: pr(), files: ["scripts/x.mjs"], taskIds: [T1, T2], tasks: new Map([[T2, taskData(T2, [delivery()], [obs()])]]), ...over });

test("Task ids come from the PR description, Document ids are not mistaken for Tasks", () => {
  assert.deepEqual(taskReferences(`Task 1a886c5b and ${DOC} and task: ${T1}`).sort(), [DOC, T1, "1a886c5b"].sort());
  assert.deepEqual(resolveTasks(taskReferences(`Task 1a886c5b ${DOC}`), [T1, T2]), [T2]);
  assert.deepEqual(resolveTasks(["deadbeef"], [T1, T2]), []);
});

test("a Delivery claims a PR head with '#N commit'", () => {
  assert.deepEqual(deliveryClaims("#339 bb46b90a、#342 8fe31bc9(#342 含 #339 提交,base main)"), [{ pr: 339, commit: "bb46b90a" }, { pr: 342, commit: "8fe31bc9" }]);
  assert.deepEqual(deliveryClaims("no pr here abcdef1"), []);
});

// Task 62804062: the two Delivery texts that the gate failed to read on 2026-11-13 (#414 and #413), as they were written.
const REBASE_414 = "#414 rebased onto main 01cf998f, migration 105 kept, all five CI checks green on head 8c8010f.";
const REBASE_413 = "只做 PR #413 变基到 origin/main 8207a373；新 head 4b492a12，其余没有改动。";

test("a rebase Delivery names main's commit first and the new head after it: both are candidates, in the order written", () => {
  assert.deepEqual(deliveryClaims(REBASE_414), [{ pr: 414, commit: "01cf998f" }, { pr: 414, commit: "8c8010f" }]);
  assert.deepEqual(deliveryClaims(REBASE_413), [{ pr: 413, commit: "8207a373" }, { pr: 413, commit: "4b492a12" }]);
  // the old reading took only the first commit after the number, which was main's
  assert.ok(REBASE_414.indexOf("8c8010f") - REBASE_414.indexOf("#414") > 40 && REBASE_414.indexOf("8c8010f") - REBASE_414.indexOf("#414") < CLAIM_WINDOW);
});

test("a claim belongs to the nearest PR number before it: the window stops at the next #N, at a line end and at the window length", () => {
  assert.deepEqual(deliveryClaims("#339 rebased onto main 01cf998f; #342 head 8fe31bc9"), [{ pr: 339, commit: "01cf998f" }, { pr: 342, commit: "8fe31bc9" }]);
  assert.deepEqual(deliveryClaims("#339 on main 01cf998f\nhead bb46b90a"), [{ pr: 339, commit: "01cf998f" }]);
  assert.deepEqual(deliveryClaims(`#339 ${"x".repeat(CLAIM_WINDOW)} bb46b90a`), [], "a commit beyond the window is not about this PR");
});

test("a rebased PR whose Delivery names main first and the new head after it is recognised as accepted (it was refused before)", () => {
  for (const reason of ["#339 rebased onto main 01cf998f, migration kept, all CI checks green on head bb46b90a.", "只做 PR #339 变基到 origin/main 8207a373；新 head bb46b90a，其余没有改动。"]) {
    const result = evaluate({ tasks: new Map([[T2, taskData(T2, [delivery({ technicalEvidence: "", reason })], [obs()])]]) });
    assert.equal(result.verdict, "allow", reason);
    assert.equal(result.accepted.observer, "requirements-claude-agent");
  }
});

test("a Delivery that names only main's commit still does not identify the head", () => {
  const result = evaluate({ tasks: new Map([[T2, taskData(T2, [delivery({ technicalEvidence: "", reason: "#339 rebased onto main 01cf998f, all checks green" })], [obs()])]]) });
  assert.equal(result.verdict, "refuse");
  assert.match(result.reasons.join("\n"), /没有交付写明 "#339 bb46b90a"/);
  assert.match(result.reasons.join("\n"), /01cf998f/, "what the Delivery did say is shown");
});

test("a PR whose current head has a used observation by the designated consumer may merge", () => {
  const result = evaluate();
  assert.equal(result.verdict, "allow");
  assert.equal(result.accepted.observer, "requirements-claude-agent");
});

test("refuses, and says what is missing, when the acceptance is absent, failed, by the wrong person or self-signed", () => {
  const cases = [
    [[], /还没有验收观察/],
    [[obs({ result: "failed" })], /最新观察是 failed/],
    [[obs({ result: "notUsed" })], /最新观察是 notUsed/],
    [[obs({ observer: "someone-else" })], /约定验收者是 requirements-claude-agent/],
    [[obs({ result: "used", createdAt: "2026-11-11T11:00:00Z" }), obs({ id: "o2", result: "failed", createdAt: "2026-11-11T12:00:00Z" })], /最新观察是 failed/],
  ];
  for (const [observations, pattern] of cases) {
    const result = evaluate({ tasks: new Map([[T2, taskData(T2, [delivery()], observations)]]) });
    assert.equal(result.verdict, "refuse");
    assert.match(result.reasons.join("\n"), pattern);
  }
});

test("the designated consumer who also submitted the Delivery is not an independent acceptance", () => {
  const result = evaluate({ tasks: new Map([[T2, taskData(T2, [delivery()], [obs({ observer: "dev" })], "dev")]]) });
  assert.equal(result.verdict, "refuse");
  assert.match(result.reasons.join("\n"), /不是独立验收/);
});

test("a push after the acceptance changes the head, so the old acceptance no longer counts", () => {
  const result = evaluate({ pr: pr({ headRefOid: "ffffffff1234567890abcdef1234567890abcdef" }) });
  assert.equal(result.verdict, "refuse");
  assert.match(result.reasons.join("\n"), /没有交付写明 "#339 ffffffff".*bb46b90a/s);
});

test("the Delivery must name this PR number, not just any commit", () => {
  const result = evaluate({ pr: pr({ number: 340 }) });
  assert.equal(result.verdict, "refuse");
});

test("REGRESSION #330: a mistyped PR number must not merge a Task's unaccepted PR, with or without --no-task-reason", () => {
  // The merger meant their own documentation PR but typed #330, a code PR whose Task was delivered and never accepted.
  const typo = pr({ number: 330, headRefOid: "cafe0000cafe0000cafe0000cafe0000cafe0000", body: `Task ${T1.slice(0, 8)}`, title: "feat(runtime): run stop request" });
  const tasks = new Map([[T1, taskData(T1, [delivery({ technicalEvidence: "#330 cafe0000 全绿" })], [])]]);
  const files = ["packages/adapter-postgres/migrations/078_run_stop_request.mjs", "docs/architecture/overview.md"];
  const plain = evaluatePr({ pr: typo, files, tasks, taskIds: [T1, T2], options: {} });
  assert.equal(plain.verdict, "refuse");
  assert.match(plain.reasons.join("\n"), /还没有验收观察/);
  const declared = evaluatePr({ pr: typo, files, tasks, taskIds: [T1, T2], options: { noTaskReason: "my doc PR" } });
  assert.equal(declared.verdict, "refuse");
  assert.match(declared.reasons.join("\n"), /只用于文档.*078_run_stop_request/s);
  assert.match(declared.reasons.join("\n"), /输错了 PR 号/);
});

test("a documentation-only PR with no Task needs --no-task-reason and prints a reminder", () => {
  const docs = pr({ number: 347, body: "roadmap", title: "docs: roadmap" });
  const files = ["docs/roadmap.md", "README.md"];
  const refused = evaluatePr({ pr: docs, files, tasks: new Map(), taskIds: [T1, T2], options: {} });
  assert.equal(refused.verdict, "refuse");
  assert.match(refused.reasons.join("\n"), /--no-task-reason/);
  const allowed = evaluatePr({ pr: docs, files, tasks: new Map(), taskIds: [T1, T2], options: { noTaskReason: "release record" } });
  assert.equal(allowed.verdict, "allow");
  assert.match(allowed.warnings.join("\n"), /无 Task 文档\/决定 PR.*release record.*#347/s);
});

test("a code PR without a Task is refused even with --no-task-reason", () => {
  const code = pr({ number: 337, body: "no task mentioned", title: "feat" });
  const result = evaluatePr({ pr: code, files: ["apps/coordinator/src/x.ts"], tasks: new Map(), taskIds: [T1, T2], options: { noTaskReason: "x" } });
  assert.equal(result.verdict, "refuse");
  assert.match(result.reasons.join("\n"), /apps\/coordinator\/src\/x\.ts/);
});

test("draft, closed, wrong base and failing checks are refused even when accepted", () => {
  for (const [over, pattern] of [[{ isDraft: true }, /草稿/], [{ state: "MERGED" }, /不是打开状态/], [{ baseRefName: "dev" }, /目标分支/],
    [{ statusCheckRollup: [{ name: "app", conclusion: "FAILURE" }] }, /app: failure/], [{ statusCheckRollup: [{ name: "app", status: "IN_PROGRESS" }] }, /app: in_progress/],
    [{ statusCheckRollup: [{ name: "app", status: "IN_PROGRESS", conclusion: "" }, { context: "ci/x", state: "PENDING" }] }, /app: in_progress.*ci\/x: pending/]]) {
    const result = evaluate({ pr: pr(over) });
    assert.equal(result.verdict, "refuse");
    assert.match(result.reasons.join("\n"), pattern);
  }
});

const adapterFor = (prs, tasks, log = []) => ({
  prView: number => ({ ...prs.find(item => item.number === number), files: (prs.find(item => item.number === number).files ?? []).map(path => ({ path })) }),
  prOpen: () => prs, taskIds: () => [T1, T2], task: id => tasks.get(id),
  merge: (number, head) => { log.push(["merge", number, head]); },
});

test("merge is a preview without --execute and merges exactly the checked head with --execute", async () => {
  const log = [], lines = [];
  const adapter = adapterFor([pr()], new Map([[T2, taskData(T2, [delivery()], [obs()])]]), log);
  const preview = await mergePr({ adapter, number: 339, log: line => lines.push(line) });
  assert.equal(preview.merged, false);
  assert.equal(log.length, 0);
  await mergePr({ adapter, number: 339, execute: true, log: line => lines.push(line) });
  assert.deepEqual(log, [["merge", 339, HEAD]]);
});

test("a push between the check and the merge stops the merge", async () => {
  const log = [];
  const tasks = new Map([[T2, taskData(T2, [delivery()], [obs()])]]);
  const adapter = adapterFor([pr()], tasks, log);
  let reads = 0;
  const original = adapter.prView;
  adapter.prView = number => { reads += 1; const view = original(number); return reads > 1 ? { ...view, headRefOid: "0".repeat(40) } : view; };
  const outcome = await mergePr({ adapter, number: 339, execute: true, log: () => {} });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.headMoved, true);
  assert.equal(log.length, 0);
});

test("--expect-title catches a number that points at a different PR", async () => {
  const log = [];
  const adapter = adapterFor([pr()], new Map([[T2, taskData(T2, [delivery()], [obs()])]]), log);
  const outcome = await mergePr({ adapter, number: 339, options: { expectTitle: "docs:" }, execute: true, log: () => {} });
  assert.equal(outcome.merged, false);
  assert.equal(log.length, 0);
});

test("pending lists only accepted open PRs, longest-waiting first, with the wait", async () => {
  const second = pr({ number: 340, headRefOid: "aaaaaaaa1234567890abcdef1234567890abcdef", body: `Task ${T2.slice(0, 8)}`, title: "second" });
  const t2 = taskData(T2, [delivery(), delivery({ id: "d2", technicalEvidence: "#340 aaaaaaaa" })],
    [obs(), obs({ id: "o9", deliveryId: "d2", createdAt: "2026-11-11T09:00:00Z" })]);
  const unaccepted = pr({ number: 330, headRefOid: "cafe0000cafe0000cafe0000cafe0000cafe0000", body: `Task ${T1.slice(0, 8)}` });
  const adapter = adapterFor([pr(), second, unaccepted], new Map([[T2, t2], [T1, taskData(T1, [], [])]]));
  const now = new Date("2026-11-11T13:00:00Z").getTime();
  const rows = await pendingMerges({ adapter, now });
  assert.deepEqual(rows.map(row => [row.pr, row.waitedMs]), [[340, 4 * 3600e3], [339, 2 * 3600e3]]);
  assert.match(formatPending(rows), /#340 aaaaaaaa 可合并 · 已等 4h00m/);
  const everything = await pendingMerges({ adapter, now, all: true });
  assert.equal(everything.at(-1).pr, 330);
  assert.equal(everything.at(-1).ready, false);
});

test("the config must live outside the repository and name an absolute CLI and a project UUID", () => {
  const ok = JSON.stringify({ cli: ["/opt/evoloop"], project: T2 });
  assert.equal(loadConfig(ok, "/etc/merge.json").baseBranch, "main");
  assert.throws(() => loadConfig(ok, join(repoRoot, "merge.json")), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ cli: ["evoloop"], project: T2 }), "/etc/m.json"), /absolute path/);
  assert.throws(() => loadConfig(JSON.stringify({ cli: ["/opt/evoloop"], project: "x" }), "/etc/m.json"), /project UUID/);
});

test("end to end: the real script, with a fake gh and CLI, refuses the mistyped number and never calls merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const calls = join(dir, "gh-calls.log");
  const typo = { number: 330, title: "feat(runtime): run stop request", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "feat/run-stop-request",
    headRefOid: "cafe0000cafe0000cafe0000cafe0000cafe0000", body: `Task ${T1.slice(0, 8)}`, files: [{ path: "packages/adapter-postgres/migrations/078_run_stop_request.mjs" }],
    statusCheckRollup: [{ name: "app", conclusion: "SUCCESS" }] };
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\ncase "$*" in *"pr merge"*) exit 0;; *) cat ${JSON.stringify(join(dir, "pr.json"))};; esac\n`);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "pr.json"), JSON.stringify(typo));
  const taskJson = JSON.stringify(taskData(T1, [delivery({ technicalEvidence: "#330 cafe0000 全绿" })], []));
  writeFileSync(join(dir, "evoloop"), `#!/bin/sh\ncase "$1" in list) echo '{"items":[{"id":"${T1}"},{"id":"${T2}"}]}';; task) echo '${taskJson.replaceAll("'", "")}';; esac\n`);
  chmodSync(join(dir, "evoloop"), 0o755);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ cli: [join(dir, "evoloop")], project: T2 }));
  const script = join(repoRoot, "scripts/release/merge-gate.mjs");
  for (const extra of [[], ["--no-task-reason", "my docs PR"]]) {
    const run = spawnSync(process.execPath, [script, "merge", "--pr", "330", "--execute", ...extra], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, EVOLOOP_MERGE_CONFIG: join(dir, "config.json") } });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /拒绝合并 PR #330/);
  }
  assert.ok(!readFileSync(calls, "utf8").includes("pr merge"));
});

// ---- behind-main update, lineage and hand mapping ----

const sha = prefix => prefix.padEnd(40, "0");
const H = sha("abcdef12"), M = sha("1111aaaa"), H2 = sha("2222bbbb"), AUTHOR = sha("3333cccc");
const webflow = (parents, tree = "tree-update") => ({ parents, tree, committerEmail: "noreply@github.com", verified: true });
const handmade = (parents, tree) => ({ parents, tree, committerEmail: "dev@example.com", verified: false });

/** A fake GitHub: commits, which commits are on main, and a PR whose head moves when "Update branch" is requested. */
const world = ({ head = H, behind = true, commits = {}, onMain = [M], afterUpdate = {}, clean = {}, checks = [{ name: "app", conclusion: "SUCCESS" }, { name: "docs", conclusion: "SUCCESS" }], tasks, log = [], updateTo = H2 } = {}) => {
  const state = { head, behind, checks };
  const base = { number: 339, title: "ci: parallel", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "ci/x", body: `Task ${T2.slice(0, 8)}`, files: [{ path: "scripts/x.mjs" }] };
  const view = () => ({ ...base, headRefOid: state.head, mergeStateStatus: state.behind ? "BEHIND" : "CLEAN", statusCheckRollup: state.checks });
  const graph = { [H]: handmade([sha("0000dead")], "t-h"), [M]: webflow([sha("0000dead")]), [H2]: webflow([H, M]), ...commits };
  return { log, state, adapter: {
    prView: () => view(), prOpen: () => [view()], taskIds: () => [T1, T2],
    task: id => (tasks ?? new Map([[T2, taskData(T2, [delivery({ technicalEvidence: `#339 ${H.slice(0, 8)} 全绿` })], [obs()])]])).get(id),
    commit: async hash => graph[hash] ? { sha: hash, ...graph[hash] } : { sha: hash, parents: [], tree: "x" },
    onMain: async hash => onMain.includes(hash), cleanMergeTree: async (a, b) => clean[`${a}+${b}`] ?? null,
    updateBranch: (number, expected) => { log.push(["update", number, expected]); Object.assign(state, { head: updateTo, behind: false }, afterUpdate); },
    merge: (number, hash) => { log.push(["merge", number, hash]); },
  } };
};
const fast = { headMs: 30, checksMs: 30, intervalMs: 2 };
const quick = () => new Promise(resolvePromise => setTimeout(resolvePromise, 2));
const lines = () => { const out = []; out.log = line => out.push(line); return out; };

test("BEHIND: an accepted PR is reported as needing an update, not as unaccepted, and is not merged without --update-branch", async () => {
  const { adapter, log } = world();
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, execute: true, log: out.log });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.result.needsUpdate, true);
  assert.match(out.join("\n"), /落后于 main.*--update-branch/);
  assert.equal(log.length, 0);
  const rows = await pendingMerges({ adapter, now: new Date("2026-11-11T13:00:00Z").getTime() });
  assert.equal(rows[0].needsUpdate, true);
  assert.equal(rows[0].ready, false);
  assert.match(formatPending(rows), /#339 abcdef12 已验收，需更新分支 · 已等 2h00m/);
  assert.ok(!/未验收/.test(formatPending(rows)));
});

test("--update-branch asks GitHub to update from the accepted head, waits for checks, and merges only the safe update commit", async () => {
  const { adapter, log } = world();
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, execute: true, log: out.log, waits: fast, sleep: quick });
  assert.equal(outcome.merged, true);
  assert.deepEqual(log, [["update", 339, H], ["merge", 339, H2]]);
  assert.match(out.join("\n"), /验收头 abcdef12 → 当前头 2222bbbb:只是把 main 合进来的更新/);
});

test("--update-branch without --execute is a preview and requests nothing", async () => {
  const { adapter, log } = world();
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, log: out.log, waits: fast, sleep: quick });
  assert.equal(outcome.merged, false);
  assert.equal(log.length, 0);
  assert.match(out.join("\n"), /预演.*请求 GitHub 更新分支/);
});

test("checks that fail, never finish, or never start after the update leave the PR unmerged", async () => {
  for (const [checks, pattern] of [
    [[{ name: "app", conclusion: "FAILURE" }, { name: "docs", conclusion: "SUCCESS" }], /更新后的检查没有通过: app: failure/],
    [[{ name: "app", status: "IN_PROGRESS", conclusion: "" }, { name: "docs", conclusion: "SUCCESS" }], /没有完成.*app: in_progress/],
    [[], /检查还没有开始/],
  ]) {
    const { adapter, log } = world({ afterUpdate: { checks } });
    const out = lines();
    const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, execute: true, log: out.log, waits: fast, sleep: quick });
    assert.equal(outcome.merged, false);
    assert.match(out.join("\n"), pattern);
    assert.ok(!log.some(call => call[0] === "merge"));
  }
});

test("if GitHub never produces a new head after the request, nothing is merged", async () => {
  const { adapter, log } = world({ updateTo: H });
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, execute: true, log: out.log, waits: fast, sleep: quick });
  assert.equal(outcome.merged, false);
  assert.match(out.join("\n"), /PR 头没有变化/);
  assert.ok(!log.some(call => call[0] === "merge"));
});

test("an update that still leaves the PR behind main (main moved again) is not merged", async () => {
  const { adapter, log } = world({ afterUpdate: { behind: true } });
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, execute: true, log: out.log, waits: fast, sleep: quick });
  assert.equal(outcome.merged, false);
  assert.match(out.join("\n"), /落后于 main/);
  assert.ok(!log.some(call => call[0] === "merge"));
});

test("a head that changes again between the post-update check and the merge stops the merge", async () => {
  const { adapter, log, state } = world();
  let readsSinceUpdate = null;
  const original = adapter.prView, update = adapter.updateBranch;
  adapter.updateBranch = (...args) => { readsSinceUpdate = 0; update(...args); };
  // after the update: 1 read for the new head, 1 for the re-check, 3rd is the read right before merging
  adapter.prView = number => { const view = original(number); if (readsSinceUpdate !== null) readsSinceUpdate += 1; return readsSinceUpdate === 3 ? { ...view, headRefOid: sha("9999ffff") } : view; };
  const outcome = await mergePr({ adapter, number: 339, options: { updateBranch: true }, execute: true, log: () => {}, waits: fast, sleep: quick });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.headMoved, true);
  assert.ok(!log.some(call => call[0] === "merge"));
  assert.ok(state.head === H2);
});

test("author commits or illegal parents after the accepted head are refused and need a new Delivery", async () => {
  const cases = {
    "author commit on top of the accepted head": { head: AUTHOR, behind: false, commits: { [AUTHOR]: handmade([H], "t-author") }, pattern: /不是合并提交/ },
    "author commit on top of a GitHub update": { head: AUTHOR, behind: false, commits: { [AUTHOR]: handmade([H2], "t-author") }, pattern: /不是合并提交/ },
    "merge whose second parent is not on main": { head: H2, behind: false, commits: { [H2]: webflow([H, sha("4444dddd")]) }, pattern: /第二个父提交.*不在 main 上/ },
    "hand-made merge that is not the clean merge": { head: H2, behind: false, commits: { [H2]: handmade([H, M], "t-evil") }, clean: { [`${H}+${M}`]: "t-clean" }, pattern: /无法证明内容只是把 main 合进来/ },
    "hand-made merge when the clean merge cannot be computed": { head: H2, behind: false, commits: { [H2]: handmade([H, M], "t-evil") }, pattern: /无法证明/ },
    "merge with the accepted head as the SECOND parent": { head: H2, behind: false, commits: { [H2]: webflow([M, H]) }, pattern: /第二个父提交.*不在 main 上/ },
  };
  for (const [name, { pattern, ...setup }] of Object.entries(cases)) {
    const { adapter, log } = world(setup);
    const out = lines();
    const outcome = await mergePr({ adapter, number: 339, execute: true, log: out.log });
    assert.equal(outcome.merged, false, name);
    assert.match(out.join("\n"), pattern, name);
    assert.equal(log.length, 0, name);
  }
});

test("a hand-made merge whose content equals the clean merge of H and main is accepted as an equivalent update", async () => {
  const { adapter, log } = world({ head: H2, behind: false, commits: { [H2]: handmade([H, M], "t-clean") }, clean: { [`${H}+${M}`]: "t-clean" } });
  const outcome = await mergePr({ adapter, number: 339, execute: true, log: () => {} });
  assert.equal(outcome.merged, true);
  assert.deepEqual(log, [["merge", 339, H2]]);
});

test("pending shows a PR that was already updated by GitHub as ready, and says it moved since acceptance", async () => {
  const { adapter } = world({ head: H2, behind: false });
  const rows = await pendingMerges({ adapter });
  assert.equal(rows[0].ready, true);
  assert.equal(rows[0].updatedSinceAcceptance, true);
});

test("an unsafe lineage never lets an older acceptance carry over to a later head", () => {
  const result = evaluatePr({ pr: pr({ headRefOid: AUTHOR, mergeStateStatus: "CLEAN" }), files: [], taskIds: [T1, T2], tasks: new Map([[T2, taskData(T2, [delivery({ technicalEvidence: `#339 ${H.slice(0, 8)}` })], [obs()])]]),
    lineage: [{ sha: AUTHOR, safe: false, why: "x" }, { sha: H, safe: false, why: "" }] });
  assert.equal(result.verdict, "refuse");
});

// hand mapping (--delivery / --task)
const manualWorld = (over = {}) => {
  const old = delivery({ technicalEvidence: "基线 deadbeef,没有写 PR 号和头", submittedByActorId: "dev" });
  const tasks = over.tasks ?? new Map([[T2, taskData(T2, [old], [obs()])], [T1, taskData(T1, [delivery({ id: "d9999999-0000-4000-8000-000000000009" })], [])]]);
  return world({ head: H, behind: false, tasks, ...over.world });
};
const manualOptions = (extra = {}) => ({ manual: { deliveryId: "d1111111-0000-4000-8000-000000000001", taskId: T2, ...extra } });

test("hand mapping: a Delivery that does not name the head is accepted only as a loud manual declaration", async () => {
  const { adapter, log } = manualWorld();
  const out = lines();
  const outcome = await mergePr({ adapter, number: 339, options: manualOptions(), execute: true, log: out.log });
  assert.equal(outcome.merged, true);
  assert.match(out.join("\n"), /【人工声明·仅过渡期】.*没有被自动核对,由声明者负责/);
  assert.deepEqual(log, [["merge", 339, H]]);
});

test("hand mapping: a Delivery that does name this PR and head is reported as automatically verified", async () => {
  const { adapter } = manualWorld({ tasks: new Map([[T2, taskData(T2, [delivery({ technicalEvidence: `#339 ${H.slice(0, 8)}` })], [obs()])]]) });
  const { result } = await checkPr({ adapter, number: 339, options: manualOptions() });
  assert.equal(result.verdict, "allow");
  assert.match(result.warnings.join("\n"), /这一项已自动核对/);
});

test("hand mapping refuses a Delivery that belongs to a different Task, or an unknown one", async () => {
  const { adapter, log } = manualWorld();
  const wrongTask = await mergePr({ adapter, number: 339, options: manualOptions({ taskId: T1 }), execute: true, log: () => {} });
  assert.equal(wrongTask.merged, false);
  assert.match(wrongTask.result.reasons.join("\n"), /不属于 Task bcce4633/);
  const unknown = await mergePr({ adapter, number: 339, options: manualOptions({ deliveryId: "d0000000-0000-4000-8000-00000000ffff" }), execute: true, log: () => {} });
  assert.equal(unknown.merged, false);
  assert.equal(log.length, 0);
});

test("hand mapping without --task needs the PR description to name the Task", async () => {
  const noTask = world({ head: H, behind: false });
  noTask.adapter.prView = () => ({ number: 351, title: "fix", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "x", headRefOid: H, body: "no task id here", mergeStateStatus: "CLEAN", files: [], statusCheckRollup: [{ name: "app", conclusion: "SUCCESS" }] });
  const outcome = await mergePr({ adapter: noTask.adapter, number: 351, options: { manual: { deliveryId: "d1111111-0000-4000-8000-000000000001" } }, execute: true, log: () => {} });
  assert.equal(outcome.merged, false);
  assert.match(outcome.result.reasons.join("\n"), /请加 --task/);
  // naming the Task makes it work, with a warning that the Task was named by hand
  const named = await checkPr({ adapter: noTask.adapter, number: 351, options: manualOptions() });
  assert.equal(named.result.verdict, "allow");
  assert.match(named.result.warnings.join("\n"), /PR 描述里没有 Task 1a886c5b,这是人工指定的归属/);
});

test("hand mapping still needs a used observation from the designated consumer, not the submitter", () => {
  const cases = [
    [[], /还没有验收观察/],
    [[obs({ result: "failed" })], /最新观察是 failed/],
    [[obs({ observer: "someone-else" })], /约定验收者是 requirements-claude-agent/],
  ];
  for (const [observations, pattern] of cases) {
    const result = evaluatePr({ pr: pr({ mergeStateStatus: "CLEAN" }), files: [], taskIds: [T1, T2], options: manualOptions(), tasks: new Map([[T2, taskData(T2, [delivery()], observations)]]) });
    assert.equal(result.verdict, "refuse");
    assert.match(result.reasons.join("\n"), pattern);
  }
  const self = evaluatePr({ pr: pr({ mergeStateStatus: "CLEAN" }), files: [], taskIds: [T1, T2], options: manualOptions(), tasks: new Map([[T2, taskData(T2, [delivery()], [obs({ observer: "dev" })], "dev")]]) });
  assert.equal(self.verdict, "refuse");
  assert.match(self.reasons.join("\n"), /不是独立验收/);
});

test("hand mapping on a BEHIND PR pins the declared head: update succeeds only while nothing but main was added", async () => {
  const good = manualWorld({ world: { behind: true } });
  const done = await mergePr({ adapter: good.adapter, number: 339, options: { ...manualOptions(), updateBranch: true }, execute: true, log: () => {}, waits: fast, sleep: quick });
  assert.equal(done.merged, true);
  assert.deepEqual(good.log, [["update", 339, H], ["merge", 339, H2]]);
  // the head after the update is an author commit on top of the declared head: refused
  const bad = manualWorld({ world: { behind: true, updateTo: AUTHOR, commits: { [AUTHOR]: handmade([H], "t-author") } } });
  const refused = await mergePr({ adapter: bad.adapter, number: 339, options: { ...manualOptions(), updateBranch: true }, execute: true, log: () => {}, waits: fast, sleep: quick });
  assert.equal(refused.merged, false);
  assert.ok(!bad.log.some(call => call[0] === "merge"));
  assert.match(refused.result.reasons.join("\n"), /不在 PR 的更新链上.*不是合并提交/s);
});
