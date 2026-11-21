import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsOfLine, configIdentity, day, declaredStage, dominantActor, expandLoops, ghMergeNumber, jsonKeyDiff, mentionsCandidate, mentionsFormalReadback as rawMentionsFormalReadback,
  mentionsNear, mergeInvocations, mergeRows as rawMergeRows, parseTrainLog,
  MERGE_OK, badLineProblem, inspectLine, missingMergeTimeProblem, configProblems, evidencePhraseIsClean, exitCodeFor, hasCompletionEvidence as rawHasCompletionEvidence, humanWriteProblem, judgeClosure as rawJudgeClosure, mentionsAnywhere, mentionsFile, targetLabel, truncationProblem,
} from "./boundary-check.mjs";
import { format, loadConfig, readTranscripts, transcriptFiles } from "../ops/boundary-check.mjs";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The observation these tests are read against: written 2026-11-14 12:00Z. A commit resolves only if it is one of these, an id exists only if it is one of these.
const OBSERVED = Date.parse("2026-11-14T12:00:00Z");
const COMMITS = ["5ae8f8fc", "530497b9"], IDS = ["1ea394b7", "8fecc67c", "7be5a242"];
const V = { observedAtMs: OBSERVED, commitExists: hex => COMMITS.some(known => known.startsWith(hex) || hex.startsWith(known)), idExists: hex => IDS.some(known => known.startsWith(hex) || hex.startsWith(known)) };
const mentionsFormalReadback = text => rawMentionsFormalReadback(text, V);
const judgeClosure = args => rawJudgeClosure({ ...args, verifier: V });
const hasCompletionEvidence = phrase => rawHasCompletionEvidence(phrase, V);

// Merge commands in these fixtures started a minute before the PR was merged (07:00:00Z) and succeeded, unless a test says otherwise.
const mergeRows = args => rawMergeRows({ ...args, transcripts: args.transcripts.map(t => ({ ...t, merges: t.merges.map(m => ({ at: "2026-11-12T06:59:00Z", ok: true, ...m })) })) });

const codexLine = (at, cmd) => JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } });
const claudeLine = (at, command) => JSON.stringify({ timestamp: at, message: { content: [{ type: "tool_use", input: { command } }] } });

test("train log: merged lines become UTC times from the local offset", () => {
  const text = "09:57:46 main 9a4020a5 (execute)\n09:58:03    已合并 PR #370(7e58d111)\n10:02:31    PR #372 x\n10:02:31    已合并 PR #372(8074a56c)\n";
  assert.deepEqual(parseTrainLog(text, "2026-11-12", 300, "a.log"), [
    { pr: 370, at: "2026-11-12T04:58:03.000Z", log: "a.log" }, { pr: 372, at: "2026-11-12T05:02:31.000Z", log: "a.log" }]);
});

test("transcript lines: Codex function_call and Claude tool_use give commands with their time; prose and other records give none", () => {
  assert.deepEqual(commandsOfLine(codexLine("2026-11-12T06:48:51.000Z", "node /tmp/merge-gate.mjs merge --pr 382 --execute")), [{ at: "2026-11-12T06:48:51.000Z", command: "node /tmp/merge-gate.mjs merge --pr 382 --execute" }]);
  assert.deepEqual(commandsOfLine(claudeLine("2026-11-12T06:48:51.000Z", "ls")), [{ at: "2026-11-12T06:48:51.000Z", command: "ls" }]);
  assert.deepEqual(commandsOfLine(JSON.stringify({ timestamp: "2026-11-12T06:48:51.000Z", type: "event_msg", payload: { type: "agent_message", message: "function_call tool_use" } })), []);
  assert.deepEqual(commandsOfLine("not json function_call"), [], "the commands of a bad line are none, but the line is no longer silently dropped: see inspectLine");
  assert.equal(inspectLine("not json function_call").defect, "JSON 无法解析");
});

test("dominant actor is the agent-cli identity the commands use most, with the counts of the others", () => {
  const commands = ["a/agent-cli/leader/evoloop get", "a/agent-cli/leader/evoloop get", "a/agent-cli/requirements/evoloop get"].map(command => ({ command }));
  assert.deepEqual(dominantActor(commands), { actor: "leader", uses: 2, others: ["requirements×1"] });
  assert.equal(dominantActor([{ command: "ls" }]), null);
});

test("merge commands: loops are written out, several per line are all found, --execute is required, gh merges are found without a config", () => {
  const expanded = expandLoops("for n in 380 369; do echo $n; done");
  assert.ok(expanded.includes("echo 380") && expanded.includes("echo 369") && !expanded.includes("$n"), expanded);
  const loop = 'for n in 380 369 378; do node /tmp/merge-gate.mjs merge --pr $n --execute --config ~/ops/merge-config.json 2>&1 | tail -8; done';
  assert.deepEqual(mergeInvocations([{ at: "t", command: loop }]).map(item => item.pr), [380, 369, 378]);
  assert.equal(mergeInvocations([{ at: "t", command: loop }])[0].config, "~/ops/merge-config.json");
  const several = "echo '=== 369'; node /tmp/merge-gate.mjs merge --pr 369 --update-branch --execute --config ~/ops/merge-config.json 2>&1 | tail -8; echo '=== 381'; node /tmp/merge-gate.mjs merge --pr 381 --execute --config ~/ops/merge-config.json";
  assert.deepEqual(mergeInvocations([{ at: "t", command: several }]).map(item => item.pr), [369, 381]);
  assert.deepEqual(mergeInvocations([{ at: "t", command: "node /tmp/merge-gate.mjs merge --pr 5" }]), [], "a dry run is not a merge");
  assert.deepEqual(mergeInvocations([{ at: "t", command: "gh pr merge 7 --merge" }, { at: "t", command: "gh api repos/o/r/pulls/8/merge -X PUT" }]).map(item => [item.pr, item.via, item.config]),
    [[7, "gh pr merge", null], [8, "gh api merge", null]]);
});

test("config identity comes from the agent-cli path of the merge config's cli", () => {
  assert.equal(configIdentity({ cli: ["/Users/x/.local/share/evoloop/agent-cli/requirements-claude-agent/evoloop"] }), "requirements-claude-agent");
  assert.equal(configIdentity({ cli: ["/usr/bin/evoloop"] }), null);
  assert.equal(configIdentity(null), null);
});

test("merge rows: the train, one's own config, a borrowed config and no record are four different verdicts, and no command text is carried", () => {
  const merged = [382, 400, 401, 500].map(number => ({ number, mergedAt: "2026-11-12T07:00:00Z", mergedBy: { login: "someone" }, title: "t" }));
  const train = [{ pr: 401, at: "x", log: "merge-train-1.log" }];
  const transcripts = [
    { id: "01a1befd", actor: { actor: "leader" }, merges: [{ pr: 382, configIdentity: "requirements", via: "merge-gate", command: "SECRET-TOKEN" }] },
    { id: "0b0b0b0b", actor: { actor: "requirements" }, merges: [{ pr: 400, configIdentity: "requirements", via: "merge-gate" }] },
  ];
  const rows = mergeRows({ merged, train, transcripts });
  assert.deepEqual(rows.map(row => [row.pr, row.verdict]), [[382, "借用他人合并配置"], [400, "本人发起"], [401, "合并列车"], [500, "发起者无记录"]]);
  assert.match(rows[0].who, /leader 用 requirements 的配置（会话记录 01a1befd）/);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET-TOKEN/);
});

test("JSON key diff names keys and entry counts, never values, and says when a file does not parse", () => {
  const before = JSON.stringify({ sessionMessages: { grants: [1, 2], enabled: true }, auth: { token: "AAA-secret" } });
  const after = JSON.stringify({ sessionMessages: { grants: [1, 2, 3, 4], enabled: true }, auth: { token: "BBB-secret" }, extra: { a: 1 } });
  const diff = jsonKeyDiff(before, after);
  assert.deepEqual(diff.added, ["extra", "extra.a"]);
  assert.deepEqual(diff.changedSizes, ["sessionMessages.grants 2→4"]);
  assert.deepEqual(diff.removed, []);
  assert.doesNotMatch(JSON.stringify(diff), /secret/);
  assert.equal(jsonKeyDiff(before, '{"broken": ').afterParses, false);
  assert.equal(jsonKeyDiff(before, after).afterParses, true);
});

test("mentions near a time: only commands inside the window that name the file, counted, never quoted", () => {
  const at = Date.parse("2026-11-12T05:24:00Z");
  const transcripts = [
    { id: "dev", actor: { actor: "codex-dev-agent" }, commands: [{ at: "2026-11-12T05:21:13Z", command: "cat ~/rt/runtime/auth.json" }, { at: "2026-11-12T05:22:00Z", command: "ls" }, { at: "2026-11-12T04:00:00Z", command: "cat runtime/auth.json" }] },
    { id: "other", actor: null, commands: [{ at: "2026-11-12T05:24:00Z", command: "echo hi" }] },
  ];
  assert.deepEqual(mentionsNear(transcripts, ["runtime/auth.json"], at, 10 * 60_000), [{ transcript: "dev", actor: "codex-dev-agent", commands: 1, first: "2026-11-12T05:21:13Z" }]);
});

test("observation wording: candidate, a formal read-back, and the stage a Task declares", () => {
  assert.equal(mentionsCandidate("在候选阶段通过"), true);
  assert.equal(mentionsCandidate("在正式实例通过"), false);
  // Quoting this check's own count label is not candidate wording; other candidate wording next to it still is.
  assert.equal(mentionsCandidate("前三行与计数“合并0（共0）·私有文件0（共0）·以使用者身份写入0（共0）·候选观察下关闭0（共3）”与报告一致"), false);
  assert.equal(mentionsCandidate("需要看的：候选观察下关闭 1（共 3）；候选环境通过"), true);
  assert.equal(judgeClosure({ evidence: "边界核对计数“候选观察下关闭0（共3）”与报告一致", hasDelivery: true, stage: null }).flagged, false);
  assert.equal(mentionsCandidate("需要看的：候选观察下关闭 0（共 3）"), false);
  assert.equal(mentionsCandidate("以使用者身份写入 0（共 0）· 候选观察下关闭 **1**（共 3）。"), false);
  // The same words in a sentence, without the count, are still candidate wording (acceptance-2, 11-21).
  assert.equal(mentionsCandidate("本次只在候选观察下关闭，正式未读回"), true);
  assert.equal(mentionsCandidate("这次是按候选观察下关闭的"), true);
  assert.equal(judgeClosure({ evidence: "本次只在候选观察下关闭，正式未读回", hasDelivery: true, stage: null }).flagged, true);
  // The label in quotation marks, the label with a count but no total, and this check's printed verdict are its own words (11-21, afb49a9e).
  const afb = "因“候选观察下关闭”为 1，报告开头第二行写了“需要需求 Session 看：边界核对”。被标红的那一行是 b3ab7bfc、“依据只写候选”；"
    + "我那条观察的证据里原文引用了计数字样“候选观察下关闭0（共3）”，可能被判定脚本按关键词误当成“只写候选”。";
  assert.equal(mentionsCandidate(afb), false);
  assert.equal(judgeClosure({ evidence: afb, hasDelivery: true, stage: null }).flagged, false);
  assert.equal(mentionsCandidate("需要看的：合并 1 · 私有文件 1 · 以使用者身份写入 0 · 候选观察下关闭 1；退出码 0"), false);
  assert.equal(mentionsCandidate("「候选观察下关闭」是 0"), false);
  assert.equal(mentionsCandidate("候选观察下关闭：**2**"), false);
  assert.equal(mentionsCandidate("那一行写着依据没有候选字样"), false);
  assert.equal(mentionsCandidate("依据只写候选，任务声明的阶段就是候选（不列）"), false);
  // Candidate wording next to those words still counts.
  assert.equal(mentionsCandidate("因“候选观察下关闭”为 1；本次在候选实例 4400 上通过"), true);
  assert.equal(mentionsCandidate("“依据只写候选”那行之外，正式未读回，只看了候选环境"), true);
  assert.equal(mentionsCandidate("按候选观察下关闭，正式未读回"), true);
  assert.equal(mentionsCandidate("证据只写候选实例通过"), true);
  // acceptance-2's counterexamples (11-21, #504 first head): a count followed by a measure word, and the verdict words in the acceptor's own prose.
  for (const prose of ["只在候选观察下关闭 3 个任务，正式未读回", "本次候选观察下关闭 2 次，正式未读回", "我的依据只写候选，正式环境未读回",
    "候选观察下关闭 **3** 个任务，正式未读回", "候选观察下关闭12项，正式未读回"]) {
    assert.equal(mentionsCandidate(prose), true, prose);
    assert.equal(judgeClosure({ evidence: prose, hasDelivery: true, stage: null }).flagged, true, prose);
  }
  // Other quotation marks and Markdown backticks, and a quoted verdict with “依据”.
  for (const quoted of ["‘候选观察下关闭’为 1", "『候选观察下关闭』为 1", "`候选观察下关闭` 为 1", "那一行是“依据只写候选”", "`依据只写候选`",
    "⚠ b3ab7bfc 由 requirements-claude-agent 关闭；依据 acceptance-claude-agent:used；依据只写候选\n下一行", "依据只写候选；任务声明阶段：正式"]) {
    assert.equal(mentionsCandidate(quoted), false, quoted);
  }
  assert.equal(mentionsFormalReadback("正式环境已验证（2026-11-13 09:12Z，5ae8f8fc）"), true);
  assert.equal(mentionsFormalReadback("候选环境通过；正式未验证"), false);
  assert.equal(declaredStage("**阶段**：正式（读正式数据）"), "正式");
  assert.equal(declaredStage("**阶段**：候选"), "候选");
  assert.equal(declaredStage("没有写阶段"), null);
});

test("a negated or to-do formal clause is not a formal read-back (candidate acceptance rework)", () => {
  for (const text of [
    "候选环境通过；正式实例未验证，不代表正式已通过",
    "仅候选验证，正式未通过",
    "候选验证通过，正式环境尚未读回",
    "候选环境通过，正式读回待做",
    "正式环境没有读回",
  ]) assert.equal(mentionsFormalReadback(text), false, text);
  for (const text of ["候选已用；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境已验证（2026-11-13 09:12Z，5ae8f8fc）", "候选通过；正式实测通过（2026-11-13 09:12Z，5ae8f8fc）"]) assert.equal(mentionsFormalReadback(text), true, text);
  assert.equal(mentionsFormalReadback(null), false);
});

test("gh pr merge is read wherever the flags stand, and a merge-gate path held in a variable still counts", () => {
  const prs = command => mergeInvocations([{ at: "t", command }]).map(item => item.pr);
  assert.deepEqual(prs("gh pr merge --squash 6"), [6]);
  assert.deepEqual(prs("gh pr merge --auto 10"), [10]);
  assert.deepEqual(prs("gh pr merge 7 --merge"), [7]);
  assert.deepEqual(prs("gh pr merge --match-head-commit abcdef0 --repo o/r 11"), [11]);
  assert.deepEqual(prs("gh pr merge https://github.com/o/r/pull/12 --merge"), [12]);
  assert.deepEqual(prs("gh pr merge --squash"), [], "no number, nothing to attribute");
  assert.equal(ghMergeNumber("--subject 99 8"), 8, "a value of an option is not the PR number");
  const indirect = "MG=/tmp/merge-gate.mjs; node $MG merge --pr 21 --execute --config ~/ops/merge-config.json; node ${MG} merge --pr 22 --execute";
  assert.deepEqual(prs(indirect), [21, 22]);
  assert.equal(mergeInvocations([{ at: "t", command: indirect }])[0].config, "~/ops/merge-config.json");
  assert.deepEqual(prs("node $UNKNOWN merge --pr 23 --execute"), [], "a script path that is not resolvable stays unattributed (a stated limit)");
});

test("a day is 24 hours of local time, and the config must live outside the repository with its required fields", () => {
  assert.deepEqual(day("2026-11-12", 300), { from: "2026-11-11T19:00:00.000Z", to: "2026-11-12T19:00:00.000Z" });
  assert.throws(() => day("11-12", 300), /YYYY-MM-DD/);
  const ok = JSON.stringify({ repo: "o/r", utcOffsetMinutes: 300, humanActors: ["owner-human"] });
  assert.ok(loadConfig(ok, "/etc/boundary.json"));
  assert.throws(() => loadConfig(ok, new URL("../../x.json", import.meta.url).pathname), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ repo: "o/r", humanActors: ["h"] }), "/etc/b.json"), /utcOffsetMinutes/);
  assert.throws(() => loadConfig(JSON.stringify({ repo: "o/r", utcOffsetMinutes: 0, humanActors: [] }), "/etc/b.json"), /humanActors/);
});

// ---- Task ac254c1a: the check must never say "all normal" when it could not tell. Each case below is a counterexample that used to
// come out as a clean report.
const merged = number => ({ number, mergedAt: "2026-11-12T07:00:00Z", mergedBy: { login: "someone" }, title: "t" });
const listed = rows => rows.filter(row => !MERGE_OK.includes(row.verdict));

test("1. a merge whose session or config identity cannot be recognised is listed, with which one is unknown", () => {
  const rows = mergeRows({ merged: [merged(1), merged(2), merged(3)], train: [], transcripts: [
    { id: "a", actor: { actor: "leader" }, merges: [{ pr: 1, via: "merge-gate", configIdentity: null }] },
    { id: "b", actor: null, merges: [{ pr: 2, via: "merge-gate", configIdentity: "requirements" }] },
    { id: "c", actor: null, merges: [{ pr: 3, via: "merge-gate", configIdentity: null }] }] });
  assert.deepEqual(rows.map(row => row.verdict), ["发起者或配置认不出", "发起者或配置认不出", "发起者或配置认不出"]);
  assert.match(rows[0].who, /合并配置所属的身份/); assert.match(rows[1].who, /发起会话的身份/); assert.match(rows[2].who, /发起会话的身份和合并配置所属的身份/);
  assert.equal(listed(rows).length, 3);
});

test("1. a merge-gate config passed through EVOLOOP_MERGE_CONFIG is read, not dropped", () => {
  const found = mergeInvocations([{ at: "t", command: "EVOLOOP_MERGE_CONFIG=~/ops/merge-config.json node /tmp/merge-gate.mjs merge --pr 31 --execute" }]);
  assert.deepEqual(found.map(item => [item.pr, item.config]), [[31, "~/ops/merge-config.json"]]);
});

test("2. a merge that did not go through the merge gate is listed with how it was made", () => {
  const rows = mergeRows({ merged: [merged(5), merged(6)], train: [], transcripts: [
    { id: "d", actor: { actor: "dev" }, merges: [{ pr: 5, via: "gh pr merge", configIdentity: null }, { pr: 6, via: "gh api merge", configIdentity: null }] }] });
  assert.deepEqual(rows.map(row => row.verdict), ["绕过合并门", "绕过合并门"]);
  assert.match(rows[0].who, /dev 用 gh pr merge/); assert.match(rows[1].who, /gh api merge/);
  assert.equal(listed(rows).length, 2);
});

test("3. the merge train log does not outrank the transcripts: a train merge that a session also ran is a conflict", () => {
  const rows = mergeRows({ merged: [merged(7)], train: [{ pr: 7, at: "x", log: "merge-train-1.log" }], transcripts: [
    { id: "e", actor: { actor: "leader" }, merges: [{ pr: 7, via: "merge-gate", configIdentity: "requirements" }] }] });
  assert.equal(rows[0].verdict, "合并列车与会话记录冲突");
  assert.match(rows[0].who, /合并列车日志 merge-train-1.log 记了它/); assert.match(rows[0].who, /leader 用 requirements/);
  assert.equal(listed(rows).length, 1);
});

test("merge commands written into a heredoc, a note or an argument are text, not merges", () => {
  const written = "cat > t.test.mjs <<'EOF'\nnode /tmp/merge-gate.mjs merge --pr 9 --execute --config ~/c.json\nEOF";
  assert.deepEqual(mergeInvocations([{ at: "t", command: written }]), []);
  assert.deepEqual(mergeInvocations([{ at: "t", command: 'grep -n "node /tmp/merge-gate.mjs merge --pr 9 --execute" log' }]), []);
  assert.deepEqual(mergeInvocations([{ at: "t", command: "echo hi; node /tmp/merge-gate.mjs merge --pr 9 --execute --config ~/c.json" }]).map(item => item.pr), [9]);
});

test("4. a token file read through a Read/Edit tool or an array-form command is seen, and a read hours before the write counts", () => {
  const readTool = JSON.stringify({ timestamp: "2026-11-12T01:00:00Z", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/p/runtime/auth.json" } }] } });
  const arrayCommand = JSON.stringify({ timestamp: "2026-11-12T02:00:00Z", type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ command: ["bash", "-lc", "cat /p/runtime/auth.json"] }) } });
  const commands = [...commandsOfLine(readTool), ...commandsOfLine(arrayCommand)];
  assert.equal(commands.length, 2);
  assert.ok(commands.every(item => mentionsFile(item.command, "runtime/auth.json")));
  const transcripts = [{ id: "dev", actor: { actor: "codex-dev-agent" }, commands }];
  assert.deepEqual(mentionsNear(transcripts, ["runtime/auth.json"], Date.parse("2026-11-12T05:24:00Z"), 10 * 60_000), [], "a fixed 10-minute window misses it");
  assert.deepEqual(mentionsAnywhere(transcripts, ["runtime/auth.json"], Date.parse("2026-11-12T05:24:00Z")), [{ transcript: "dev", actor: "codex-dev-agent", commands: 2, nearestMinutes: 204 }]);
});

test("5. a write with no session (an external message) is a row, not an exception", () => {
  assert.equal(targetLabel(null), "（无会话）");
  assert.equal(targetLabel(""), "（无会话）");
  assert.equal(targetLabel("c82afb21-e827-44e7"), "c82afb21");
});

test("6. only a stated formal success is a formal read-back; failures, waiting and to-dos are not, and a closure with no basis is listed", () => {
  for (const evidence of ["候选通过；正式实例读回失败", "候选通过，等正式读回", "候选通过；正式读回 TODO", "候选通过；正式读回缺", "候选通过；正式读回"]) {
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.equal(judged.candidateOnly, true, evidence); assert.equal(judged.flagged, true, evidence);
  }
  assert.equal(judgeClosure({ evidence: "候选通过；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", hasDelivery: true, stage: null }).flagged, false);
  const none = judgeClosure({ evidence: null, hasDelivery: false, stage: null });
  assert.deepEqual([none.noBasis, none.flagged], [true, true]);
});

test("9. a Task that declares the candidate stage is not listed for a candidate-only closure; one that declares 正式 or nothing is", () => {
  assert.equal(judgeClosure({ evidence: "候选环境通过", hasDelivery: true, stage: "候选" }).flagged, false);
  assert.equal(judgeClosure({ evidence: "候选环境通过", hasDelivery: true, stage: "正式" }).flagged, true);
  assert.equal(judgeClosure({ evidence: "候选环境通过", hasDelivery: true, stage: null }).flagged, true);
});

test("7. an unconfigured or unread source makes the report say so on its first line and exit non-zero; a complete one does not", () => {
  assert.equal(configProblems({ transcriptRoots: ["/a"], privateFiles: [{ globs: ["/b/*"] }], identityFiles: ["runtime/auth.json"], mergeTrainLogs: { dir: "/c" }, databaseUrl: "postgresql://x/y" }).length, 0);
  const problems = configProblems({ repo: "o/r", utcOffsetMinutes: 0, humanActors: ["h"] });
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /transcriptRoots.*privateFiles.*identityFiles.*mergeTrainLogs.*databaseUrl/s);
  const empty = { window: { from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" }, sources: {}, merges: [], privateFiles: [], humanWrites: [], closures: [] };
  const incomplete = format({ ...empty, problems }, 0);
  assert.match(incomplete.split("\n")[0], /^⚠ 核对不完整：/);
  assert.match(incomplete, /不代表正常/);
  assert.equal(exitCodeFor({ problems }), 2);
  assert.doesNotMatch(format({ ...empty, problems: [] }, 0), /核对不完整/);
  assert.equal(exitCodeFor({ problems: [] }), 0);
});

test("8. a file name is matched whole, the train log crosses midnight, and a truncated GitHub listing is a problem", () => {
  assert.equal(mentionsFile("cat tsconfig.json", "config.json"), false);
  assert.equal(mentionsFile("cat /x/config.json", "config.json"), true);
  assert.equal(mentionsFile("cp integrations.json.bak-1 y", "integrations.json"), true);
  const text = "23:50:00 main abc (execute)\n23:58:00    已合并 PR #1(aaaaaaa)\n00:05:00    已合并 PR #2(bbbbbbb)\n";
  assert.deepEqual(parseTrainLog(text, "2026-11-12", 300, "a.log").map(item => [item.pr, item.at]), [[1, "2026-11-12T18:58:00.000Z"], [2, "2026-11-12T19:05:00.000Z"]]);
  assert.match(truncationProblem(1000, 1000, Date.parse("2026-11-12T10:00:00Z"), Date.parse("2026-11-12T00:00:00Z")), /达到上限 1000/);
  assert.equal(truncationProblem(1000, 1000, Date.parse("2026-11-11T10:00:00Z"), Date.parse("2026-11-12T00:00:00Z")), null, "the listing reaches back before the window: nothing lost");
  assert.equal(truncationProblem(20, 1000, Date.parse("2026-11-12T10:00:00Z"), 0), null);
});

// ---- Task ac254c1a, rework after the second candidate acceptance (report 8d7a48ef): four hard failures, each a counterexample.
test("R1. a release, a review or a plain “成功/通过” is not a formal read-back (the regression of the previous round included)", () => {
  for (const evidence of ["正式发布前候选已通过", "候选通过，正式发布成功", "正式：已通过评审，读回另行安排", "候选通过；正式上线成功", "正式发布验证通过后再安排读回"]) {
    assert.equal(mentionsFormalReadback(evidence), false, evidence);
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.equal(judged.candidateOnly || !judged.mentionsCandidate, true, evidence);
  }
  for (const evidence of ["候选通过；正式发布成功", "正式发布前候选已通过", "候选已通过。正式：已通过评审，读回另行安排"]) assert.equal(judgeClosure({ evidence, hasDelivery: true, stage: null }).flagged, true, evidence);
  // the earlier cases stay as they were
  for (const evidence of ["候选已用；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境已验证（2026-11-13 09:12Z，5ae8f8fc）", "候选通过；正式实测通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境读回一致（2026-11-13 09:12Z，5ae8f8fc）"]) assert.equal(mentionsFormalReadback(evidence), true, evidence);
  for (const evidence of ["候选通过；正式实例读回失败", "候选通过，等正式读回", "候选通过；正式读回 TODO", "候选通过；正式读回缺", "候选通过；正式读回"]) assert.equal(mentionsFormalReadback(evidence), false, evidence);
});

test("R2. a transcript root that exists but holds no transcripts is an incomplete check, and writes with nothing to check them against say so", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readTranscripts } = await import("../ops/boundary-check.mjs");
  const empty = await mkdtemp(join(tmpdir(), "bc-empty-"));
  const problems = [];
  const transcripts = await readTranscripts([empty], 0, Date.now(), problems);
  assert.deepEqual(transcripts, []);
  assert.match(problems.join("\n"), /存在但里面没有任何会话记录文件/);
  assert.equal(exitCodeFor({ problems }), 2);
  const missing = [];
  await readTranscripts([join(empty, "nope")], 0, Date.now(), missing);
  assert.match(missing.join("\n"), /读不到/);
  assert.match(humanWriteProblem(3, 0), /3 条以使用者身份的写入.*无法核对/);
  assert.equal(humanWriteProblem(0, 0), null);
  assert.equal(humanWriteProblem(3, 2), null);
});

test("R3. a session that used several CLI identities is not attributed to the most frequent one", () => {
  const mixed = { id: "m", actor: { actor: "leader", uses: 40, others: ["dev×2", "acceptance×1"] }, merges: [{ pr: 11, via: "merge-gate", configIdentity: "leader" }, { pr: 12, via: "merge-gate", configIdentity: "requirements" }] };
  const rows = mergeRows({ merged: [merged(11), merged(12)], train: [], transcripts: [mixed] });
  assert.deepEqual(rows.map(row => row.verdict), ["发起者或配置认不出", "发起者或配置认不出"]);
  assert.match(rows[0].who, /会话混用多个身份：leader×40、dev×2、acceptance×1/);
  assert.equal(listed(rows).length, 2, "even when the most frequent identity equals the config identity, it is not 本人发起");
  const single = { id: "s", actor: { actor: "leader", uses: 40, others: [] }, merges: [{ pr: 11, via: "merge-gate", configIdentity: "leader" }, { pr: 12, via: "merge-gate", configIdentity: "requirements" }] };
  assert.deepEqual(mergeRows({ merged: [merged(11), merged(12)], train: [], transcripts: [single] }).map(row => row.verdict), ["本人发起", "借用他人合并配置"]);
});

test("R4. a Codex array-form command [bash, -lc, gh pr merge N] is read: the method, the session and that no merge config is involved", () => {
  const line = JSON.stringify({ timestamp: "2026-11-13T05:00:00Z", type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ command: ["bash", "-lc", "gh pr merge 505"] }) } });
  const commands = commandsOfLine(line);
  assert.deepEqual(mergeInvocations(commands).map(item => [item.pr, item.via, item.config]), [[505, "gh pr merge", null]]);
  const merges = mergeInvocations(commands).map(item => ({ ...item, ok: true, configIdentity: null }));
  const rows = mergeRows({ merged: [{ ...merged(505), mergedAt: "2026-11-13T23:00:00Z" }], train: [], transcripts: [{ id: "cx", actor: { actor: "codex-dev-agent", uses: 9, others: [] }, merges }] });
  assert.equal(rows[0].verdict, "绕过合并门");
  assert.match(rows[0].who, /codex-dev-agent 用 gh pr merge，没有经过合并门，不涉及合并配置（会话记录 cx）/);
  const scripted = commandsOfLine(JSON.stringify({ timestamp: "2026-11-13T05:00:00Z", type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ command: ["bash", "-lc", "echo hi\ngh pr merge --squash 506"] }) } }));
  assert.deepEqual(mergeInvocations(scripted).map(item => item.pr), [506]);
});

// ---- Task ac254c1a, rework 3 (acceptance report 3166a125): C8 and C9, the two sentences that still passed as a formal read-back.
test("C8. “非正式” is not the formal environment: a read-back on a non-formal instance is listed", () => {
  const evidence = "候选通过；非正式实例读回成功";
  assert.equal(mentionsFormalReadback(evidence), false);
  const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
  assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  for (const text of ["候选通过；伪正式实例读回成功", "候选通过；准正式环境读回通过"]) assert.equal(mentionsFormalReadback(text), false, text);
});

test("C9. a read-back must be of the formal environment itself: “正式包” read back on a self-built instance is listed", () => {
  const evidence = "候选通过；正式包在自建实例读回通过";
  assert.equal(mentionsFormalReadback(evidence), false);
  const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
  assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  for (const text of ["候选通过；正式包在本地读回通过", "候选通过；正式实例在候选环境读回成功", "候选通过；正式环境的演练读回通过"]) assert.equal(mentionsFormalReadback(text), false, text);
});

test("C8/C9 keep the earlier formal read-back cases as they were (R1 and the positives)", () => {
  for (const evidence of ["候选已用；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境已验证（2026-11-13 09:12Z，5ae8f8fc）", "候选通过；正式实测通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境读回一致（2026-11-13 09:12Z，5ae8f8fc）", "正式数据库读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境的读回通过（2026-11-13 09:12Z，5ae8f8fc）"]) assert.equal(mentionsFormalReadback(evidence), true, evidence);
  for (const evidence of ["正式发布前候选已通过", "候选通过，正式发布成功", "正式：已通过评审，读回另行安排", "候选通过；正式实例读回失败", "候选通过，等正式读回", "候选通过；正式读回"]) assert.equal(mentionsFormalReadback(evidence), false, evidence);
});

// ---- Task ac254c1a, rework 4 (acceptance report ff5b3134): C11–C14, conditions and plans about a read-back that has not happened.
const CONDITIONAL = {
  C11: "候选通过；正式实例读回通过后再签 used",
  C12: "候选通过；需正式实例读回通过才能关闭",
  C13: "候选通过；如果正式实例读回成功则关闭",
  C14: "候选通过；预计正式实例读回通过",
};
for (const [name, evidence] of Object.entries(CONDITIONAL)) {
  test(`${name}. “${evidence.split("；")[1]}” is a condition or a plan, not a formal read-back, and is listed`, () => {
    assert.equal(mentionsFormalReadback(evidence), false);
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  });
}

test("C11–C14 neighbours: other ways of saying the read-back is still to come are not read-backs either; stated successes stay", () => {
  for (const evidence of ["候选通过；正式实例读回通过之后再关闭", "候选通过；须正式实例读回通过才算完成", "候选通过；若正式实例读回成功则关闭", "候选通过；一旦正式实例读回通过就关闭",
    "候选通过；预期正式环境读回成功", "候选通过；计划正式实例读回通过", "候选通过；要求正式实例读回通过", "候选通过；将在正式实例读回通过", "候选通过；拟正式实例读回通过"])
    assert.equal(mentionsFormalReadback(evidence), false, evidence);
  for (const evidence of ["候选已用；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境已验证（2026-11-13 09:12Z，5ae8f8fc）", "候选通过；正式实测通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境读回一致（2026-11-13 09:12Z，5ae8f8fc）", "正式数据库读回通过（2026-11-13 09:12Z，5ae8f8fc）", "正式环境的读回通过（2026-11-13 09:12Z，5ae8f8fc）"])
    assert.equal(mentionsFormalReadback(evidence), true, evidence);
});

// ---- Task ac254c1a, rework 5 (observation 98cb5533): the judgement is positive. Only a read-back that says it was done and carries evidence
// (a time, a version/commit, a PR/Run id or a command) counts; conditions, hopes, goals, sequencing and bare claims are listed.
const N = {
  N1: "候选通过；只要正式实例读回通过就签 used",
  N2: "候选通过；正式实例读回通过后签 used",
  N3: "候选通过；希望正式实例读回通过",
  N4: "候选通过；要是正式实例读回成功就关闭",
  N5: "候选通过；目标是正式实例读回通过",
  N6: "候选通过；期望正式实例读回通过",
};
for (const [name, evidence] of Object.entries(N)) {
  test(`${name}. “${evidence.split("；")[1]}” is not a formal read-back and is listed`, () => {
    assert.equal(mentionsFormalReadback(evidence), false);
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  });
}

test("N1–N6 even with evidence-looking text next to them stay listed, because the clause itself is conditional, hoped for or sequenced", () => {
  for (const evidence of Object.values(N)) assert.equal(mentionsFormalReadback(`${evidence}（2026-11-13 09:12Z，5ae8f8fc）`), false, evidence);
});

test("a read-back counts only with completion evidence in a fixed form: a commit hash, a Run id, or a date with a clock time; a bare claim, a PR number, a bare date, a version label or a command is listed", () => {
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过"), false, "no time, hash, or id");
  assert.equal(hasCompletionEvidence("正式实例读回通过"), false);
  for (const text of ["候选通过；正式实例读回通过（2026-11-13 09:12Z）", "候选通过；正式实例读回通过（5ae8f8fc）", "候选通过；正式实例读回通过（Run 1ea394b7）",
    "候选通过；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）"])
    assert.equal(mentionsFormalReadback(text), true, text);
  for (const text of ["候选通过；正式实例读回通过 v1.2.3", "候选通过；正式实例读回通过（见 #419）", "候选通过；正式实例读回通过 2026-11-13", "候选通过；正式实例读回通过 `npm run boundary:check`", "候选通过；正式实例读回通过（版本 12345678）"])
    assert.equal(mentionsFormalReadback(text), false, text);
  assert.deepEqual([judgeClosure({ evidence: "候选通过；正式实例读回通过", hasDelivery: true, stage: null }).flagged,
    judgeClosure({ evidence: "候选通过；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", hasDelivery: true, stage: null }).flagged], [true, false]);
});

// ---- Task ac254c1a, rework 6 (observation d8b687d2): conditions and places are checked over the whole SENTENCE, and the evidence must sit in
// the read-back's own clause right after it. Each of these used to come out as a formal read-back.
const E = {
  E1: "如果 #419 合并发布，正式实例读回通过就签 used",
  E2: "正式实例读回通过的截止时间是 2026-11-14 10:00Z",
  E3: "等 7729e587 发布，正式实例读回通过就关闭",
  E4: "下一步：正式实例读回通过，命令 evoloop read run",
  E6: "正式实例读回通过，用的是候选实例 4400 的 7729e587",
};
for (const [name, evidence] of Object.entries(E)) {
  test(`${name}. “${evidence}” is listed: the condition, deadline, next step or place is in the same sentence`, () => {
    assert.equal(mentionsFormalReadback(evidence), false);
    const judged = judgeClosure({ evidence: `候选通过；${evidence}`, hasDelivery: true, stage: null });
    assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  });
}

test("E1–E6 keep working when a real completion follows in its own sentence, and the evidence must be in the read-back's clause", () => {
  const done = "候选通过；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）";
  assert.equal(mentionsFormalReadback(done), true);
  assert.equal(mentionsFormalReadback(`${E.E1}；${done.split("；")[1]}`), true, "a separate sentence with its own evidence still counts");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过，版本 5ae8f8fc"), false, "evidence in a later clause is not adjacent");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过 `evoloop read run`"), false, "a command is not proof that it was done");
});

// ---- Task ac254c1a, rework 7 (observation d8074774): F2 and F5. A date or a number near the read-back is not evidence when the words around it
// make it a cut-off or a future step; evidence is only a commit hash, a Run id, or a date with a clock time, and any timing or plan word voids it.
const F = {
  F2: "候选通过；正式实例读回通过（2026-11-14 10:00Z 之前）",
  F5: "候选通过；正式实例读回通过 #419 合并后进行",
};
for (const [name, evidence] of Object.entries(F)) {
  test(`${name}. “${evidence.split("；")[1]}” is a cut-off or a future step, not a completed read-back, and is listed`, () => {
    assert.equal(mentionsFormalReadback(evidence), false);
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  });
}

test("F2/F5 do not remove genuine completions: a real time plus a commit, a commit alone and a Run id still count; timing words void the evidence", () => {
  for (const evidence of ["候选通过；正式实例读回通过（2026-11-13 09:12Z，5ae8f8fc）", "候选通过；正式实例读回通过（5ae8f8fc）", "候选通过；正式实例读回通过（Run 1ea394b7）", "候选通过；正式实例读回通过（2026-11-13 09:12Z）"]) {
    assert.equal(mentionsFormalReadback(evidence), true, evidence);
    assert.equal(judgeClosure({ evidence, hasDelivery: true, stage: null }).flagged, false, evidence);
  }
  for (const phrase of ["（2026-11-13 09:12Z 之后）", "（5ae8f8fc 以前）", "（2026-11-14 10:00Z 截止）", "（5ae8f8fc，计划）", "（2026-11-14 10:00Z，预计）", "（5ae8f8fc 将）", "（2026-11-14 10:00Z 进行）", "（下一步 5ae8f8fc）", "（待 5ae8f8fc）"])
    assert.equal(hasCompletionEvidence(phrase), false, phrase);
  assert.equal(hasCompletionEvidence("（会话 5ae8f8fc）"), true, "“会话” is not the future word 会");
  assert.equal(hasCompletionEvidence("（20261114）"), false, "a bare number is not a hash");
});

// ---- Task ac254c1a, rework 8 (acceptance report bbadddc0): no lexical list decides what counts as evidence. Evidence is verified: a commit that resolves,
// an id that exists, a time that is not after the observation. Plans, schedules, ETAs, "waiting for" and unresolved hex words cannot pass.
const G = {
  G1: "候选通过；正式实例读回通过（预定 2026-11-20 10:00Z）",
  G2: "候选通过；正式实例读回通过（发布后 2026-11-20 10:00Z 再做）",
  G3: "候选通过；正式实例读回通过 (scheduled 2026-11-20 10:00Z)",
  G4: "候选通过；正式实例读回通过（排期 11-21 09:00）",
  G5: "候选通过；正式实例读回通过（拟于 2026-11-21 09:00Z 执行）",
  G6: "候选通过；正式实例读回通过（等 deadbeef 合并）",
  G7: "候选通过；正式实例读回通过（ETA 2026-11-21 09:00Z）",
  G8: "候选通过；正式实例读回通过（还没做，目标 2026-11-21 09:00Z）",
};
for (const [name, evidence] of Object.entries(G)) {
  test(`${name}. “${evidence.split("通过")[2] ?? evidence}” is a plan, a schedule, an ETA or an unresolved word, not evidence of a completed read-back, and is listed`, () => {
    assert.equal(mentionsFormalReadback(evidence), false);
    const judged = judgeClosure({ evidence, hasDelivery: true, stage: null });
    assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
  });
}

test("P1–P5. genuine completions are accepted: a past time with a resolvable commit, a Run id, a past time alone, an existing observation id; “已进行” does not void them", () => {
  const P = {
    P1: "候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9）",
    P2: "候选通过；正式实例读回通过（Run 8fecc67c）",
    P3: "候选通过；正式实例读回通过（2026-11-14 10:05Z 已进行，5ae8f8fc）",
    P4: "候选通过；正式实例读回通过（2026-11-14 10:05Z，会话 c9c73237）",
    P5: "候选通过；正式实例读回通过（观察 7be5a242）",
  };
  for (const [name, evidence] of Object.entries(P)) {
    assert.equal(mentionsFormalReadback(evidence), true, name);
    assert.equal(judgeClosure({ evidence, hasDelivery: true, stage: null }).flagged, false, name);
  }
});

test("verification, not wording: the same words pass or fail by what they point at", () => {
  const phrase = "候选通过；正式实例读回通过（5ae8f8fc）";
  assert.equal(rawMentionsFormalReadback(phrase, V), true);
  assert.equal(rawMentionsFormalReadback(phrase, { ...V, commitExists: () => false }), false, "a hash that does not resolve is just a word");
  assert.equal(rawMentionsFormalReadback(phrase, undefined), false, "without a verifier nothing can be checked and nothing counts");
  assert.equal(rawMentionsFormalReadback("候选通过；正式实例读回通过（Run 1ea394b7）", { ...V, idExists: () => false }), false, "an id that does not exist");
  const timed = "候选通过；正式实例读回通过（2026-11-14 10:05Z）";
  assert.equal(rawMentionsFormalReadback(timed, V), true);
  assert.equal(rawMentionsFormalReadback(timed, { ...V, observedAtMs: Date.parse("2026-11-14T10:00:00Z") }), false, "a time after the observation is a plan");
  assert.equal(rawMentionsFormalReadback(timed, { ...V, observedAtMs: null }), false, "without the observation time a bare time cannot be checked");
  assert.equal(rawMentionsFormalReadback("候选通过；正式实例读回通过（2026-11-14 10:05Z，2026-11-21 09:00Z）", V), false, "one future time voids the phrase");
  assert.equal(rawMentionsFormalReadback("候选通过；正式实例读回通过（5ae8f8fc，ETA 2026-11-21 09:00Z）", V), false, "a valid commit does not rescue a future time next to it");
});

// ---- Task ac254c1a, rework 9 (acceptance report 17815932): plan semantics win over time and commit. These stayed "normal" because a past time, or a
// commit that resolves, was taken as proof of completion even when the sentence says the read-back is scheduled, waited for, or to be done after a release.
const H = {
  G1: "候选通过；正式实例读回通过（预定 2026-11-20 10:00Z）",
  G2: "候选通过；正式实例读回通过（发布后 2026-11-20 10:00Z 再做）",
  G3: "候选通过；正式实例读回通过（scheduled 2026-11-20 10:00Z）",
  H1: "候选通过；正式实例读回通过（预定 2026-11-13 10:00Z）",
  H2: "候选通过；正式实例读回通过（scheduled 2026-11-13 10:00Z）",
  H3: "候选通过；正式实例读回通过（等真实 commit 530497b9 合并后）",
  H4: "候选通过；正式实例读回通过（ETA 11-14 09:00）",
  H5: "候选通过；正式实例读回通过（发布后 2026-11-13 10:00Z 再做）",
};
const LATE = { ...V, observedAtMs: Date.parse("2026-12-01T00:00:00Z") }; // an observation written after every one of these times: time can no longer rule them out
for (const [name, evidence] of Object.entries(H)) {
  test(`${name}. “${evidence.split("通过")[2]}” is a plan, a schedule or a wait whatever the time or commit says, and is listed`, () => {
    for (const verifier of [V, LATE]) {
      assert.equal(rawMentionsFormalReadback(evidence, verifier), false, `${name} observed at ${new Date(verifier.observedAtMs).toISOString()}`);
      const judged = rawJudgeClosure({ evidence, hasDelivery: true, stage: null, verifier });
      assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
    }
  });
}

test("plan words win over a resolvable commit and a past time, while an explicit completed read-back keeps its “合并后/发布后” and the P cases stay accepted", () => {
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（预定，5ae8f8fc）"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（排期 2026-11-13 10:00Z，5ae8f8fc）"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（定于 2026-11-13 10:00Z）"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（等 5ae8f8fc 发布）"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（还没做，5ae8f8fc）"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例已读回通过（2026-11-14 10:05Z，5ae8f8fc），#419 合并后"), true, "plainly done, with “合并后” outside the evidence phrase");
  assert.equal(mentionsFormalReadback("候选通过；正式实例已读回通过（#419 合并后，2026-11-14 10:05Z，5ae8f8fc）"), false, "other content inside the evidence phrase: listed");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（#419 合并后，2026-11-14 10:05Z，5ae8f8fc）"), false, "“合并后” without a plain “已…” is a plan: listed when unsure");
  for (const evidence of ["候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9）", "候选通过；正式实例读回通过（2026-11-14 10:05Z 已进行，5ae8f8fc）", "候选通过；正式实例读回通过（Run 8fecc67c）"])
    assert.equal(mentionsFormalReadback(evidence), true, evidence);
});

// ---- Task ac254c1a, rework 10 (acceptance report 010a2c1b): the evidence phrase is an allow-list. Right after the read-back it may contain only actual times,
// commit hashes, labelled Run/delivery/observation ids, separators and 已/已经/已完成. Anything else — planned, pending, TBD, 稍后, 届时, 明天, 等…合入, 发版后,
// 回头…再看, will run — makes the sentence listed, even with a past time or a commit that resolves.
const I = {
  I1: "（planned 2026-11-13 10:00Z）",
  I2: "（pending 2026-11-13 10:00Z）",
  I3: "（TBD，2026-11-13 10:00Z）",
  I4: "（稍后 2026-11-13 10:00Z 做）",
  I5: "（届时 2026-11-13 10:00Z）",
  I6: "（明天 10:00，530497b9）",
  I7: "（等 530497b9 合入）",
  I8: "（发版后 2026-11-13 10:00Z）",
  I9: "（回头 2026-11-13 10:00Z 再看）",
  I10: "（will run 2026-11-13 10:00Z）",
};
for (const [name, evidence] of Object.entries(I)) {
  test(`${name}. “${evidence}” is other content in the evidence phrase and is listed, with a past time or a resolvable commit`, () => {
    const text = `候选通过；正式实例读回通过${evidence}`;
    for (const verifier of [V, LATE]) {
      assert.equal(rawMentionsFormalReadback(text, verifier), false);
      const judged = rawJudgeClosure({ evidence: text, hasDelivery: true, stage: null, verifier });
      assert.deepEqual([judged.candidateOnly, judged.flagged], [true, true]);
    }
  });
}

test("the allow-list: only times, hashes, labelled ids, separators and 已/已经/已完成/已进行 may stand in the evidence phrase", () => {
  for (const phrase of ["（2026-11-14 10:05Z，commit 530497b9）", "（5ae8f8fc）", "（Run 8fecc67c）", "（观察 7be5a242，已完成）", "（已，2026-11-14 10:05Z；5ae8f8fc）", "（2026-11-14 10:05Z 已进行，5ae8f8fc）", "（会话 c9c73237，2026-11-14 10:05Z）"])
    assert.equal(evidencePhraseIsClean(phrase), true, phrase);
  for (const phrase of ["（planned 2026-11-14 10:05Z）", "（2026-11-14 10:05Z，OK）", "（#419）", "（版本 12345678）", "（`npm run x` 2026-11-14 10:05Z）", "（2026-11-14）", "（已经看过 5ae8f8fc）"])
    assert.equal(evidencePhraseIsClean(phrase), false, phrase);
});

test("BETA is not ETA: English plan words match as whole words only, so a real completion mentioning BETA keeps counting, while a real ETA is listed", () => {
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9），BETA 环境之外"), true, "BETA outside the evidence phrase");
  assert.equal(mentionsFormalReadback("候选通过；BETA 实例通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9）"), true, "BETA in an earlier sentence");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（ETA 11-14 09:00）"), false, "a real ETA");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9），ETA 之后补测"), false, "a real ETA in the sentence");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（BETA 环境之外，2026-11-14 10:05Z，commit 530497b9）"), false, "words inside the evidence phrase are other content, whatever they are: listed when unsure");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过 SCHEDULED"), false);
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9），pending 之外"), false, "pending as a whole word");
  assert.equal(mentionsFormalReadback("候选通过；正式实例读回通过（2026-11-14 10:05Z，commit 530497b9），suspending 之外"), true, "suspending contains pending but is not the word");
});

// ---- Task ac254c1a, 2026-11-15 decision: input that is missing must not vanish silently; attribution checks the merge time and the command result.
const codexCall = (at, cmd, callId) => JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "function_call", call_id: callId, arguments: JSON.stringify({ cmd }) } });
const codexOutput = (at, callId, output) => JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });

test("M1. a line that mentions a tool call but cannot be read is a defect, not an empty result: bad JSON, a call with no timestamp, a call with a timestamp that is not a time", () => {
  assert.equal(inspectLine("{broken function_call").defect, "JSON 无法解析");
  assert.equal(inspectLine(JSON.stringify({ type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ cmd: "ls" }) } })).defect, "缺时间戳或时间戳读不出");
  assert.equal(inspectLine(codexCall("not-a-time", "ls", "c1")).defect, "缺时间戳或时间戳读不出", "an invalid time used to throw RangeError and lose the whole report");
  assert.equal(inspectLine(codexCall("2026-11-12T06:59:00Z", "ls", "c1")).defect, null);
  assert.deepEqual(inspectLine(JSON.stringify({ timestamp: "2026-11-12T06:48:51.000Z", type: "event_msg", payload: { type: "agent_message", message: "function_call tool_use" } })), { commands: [], results: [], defect: null }, "prose that mentions the words is not a defect");
});

test("M2. the result of a call is read: Codex exit code (0, non-zero, still running) and Claude tool_result is_error", () => {
  const ok = inspectLine(codexOutput("2026-11-12T06:59:01Z", "c1", "Chunk ID: a\nProcess exited with code 0\nOutput:\n")).results;
  const failed = inspectLine(codexOutput("2026-11-12T06:59:01Z", "c2", "Process exited with code 1\nOutput:\nboom")).results;
  const running = inspectLine(codexOutput("2026-11-12T06:59:01Z", "c3", "Process running with session ID 55")).results;
  assert.deepEqual([ok, failed, running], [[{ callId: "c1", ok: true }], [{ callId: "c2", ok: false }], [{ callId: "c3", ok: null }]]);
  const claude = flag => inspectLine(JSON.stringify({ timestamp: "2026-11-12T06:59:01Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: flag, content: "x" }] } })).results;
  assert.deepEqual([claude(true), claude(false)], [[{ callId: "t1", ok: false }], [{ callId: "t1", ok: true }]]);
  const call = inspectLine(JSON.stringify({ timestamp: "2026-11-12T06:59:00Z", message: { content: [{ type: "tool_use", id: "t1", input: { command: "ls" } }] } }));
  assert.equal(call.commands[0].callId, "t1");
});

test("M3. unreadable lines are counted with the file and line, the report is incomplete and the exit code is not zero", () => {
  const bad = [{ file: "a.jsonl", line: 3, why: "JSON 无法解析" }, { file: "b.jsonl", line: 9, why: "缺时间戳或时间戳读不出" }];
  const problem = badLineProblem(bad);
  assert.match(problem, /2 行无法解析：a\.jsonl:3（JSON 无法解析）、b\.jsonl:9（缺时间戳或时间戳读不出）/);
  assert.equal(badLineProblem([]), null);
  assert.match(badLineProblem(Array.from({ length: 12 }, (_, index) => ({ file: "x.jsonl", line: index + 1, why: "JSON 无法解析" }))), /共 12 行/);
  assert.equal(exitCodeFor({ problems: [problem] }), 2);
});

test("M4. readTranscripts counts bad lines by file and line, and sets aside one unreadable file while the others are still read", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-"));
  mkdirSync(join(root, "p"));
  const at = "2026-11-12T06:59:00Z";
  writeFileSync(join(root, "p", "good.jsonl"), [codexCall(at, "node /x/merge-gate.mjs merge --pr 7 --execute", "c1"), codexOutput("2026-11-12T06:59:05Z", "c1", "Process exited with code 0\nOutput:\n"), "{truncated function_call", codexCall("nope", "ls", "c9")].join("\n") + "\n");
  mkdirSync(join(root, "p", "dir.jsonl")); // a directory named like a transcript: it cannot be read as a file
  const problems = [];
  const transcripts = await readTranscripts([root], Date.parse("2026-11-12T00:00:00Z"), Date.parse("2026-11-13T00:00:00Z"), problems);
  assert.equal(transcripts.length, 1, "the readable transcript is still read");
  assert.equal(transcripts[0].commands[0].ok, true, "the result of the merge command is attached to it");
  assert.match(problems.join("\n"), /good\.jsonl:3（JSON 无法解析）、good\.jsonl:4（缺时间戳或时间戳读不出）/);
  assert.match(problems.join("\n"), /会话记录读不了（dir\.jsonl：[A-Z]+），只有这一个文件没有核对/);
  assert.equal(exitCodeFor({ problems }), 2);
});

test("M5. a merge command counts as the initiator only if it started no later than the GitHub merge time and did not fail", () => {
  const run = (extra, pr = merged(20)) => mergeRows({ merged: [pr], train: [], transcripts: [{ id: "t", actor: { actor: "leader", uses: 9, others: [] }, merges: [{ pr: 20, via: "merge-gate", configIdentity: "leader", ...extra }] }] })[0];
  assert.equal(run({}).verdict, "本人发起");
  assert.equal(run({ at: "2026-11-12T07:00:00.700Z" }).verdict, "本人发起", "within the same second as the merge");
  const late = run({ at: "2026-11-12T07:00:05Z" });
  assert.equal(late.verdict, "合并命令不能算发起");
  assert.match(late.who, /晚于 GitHub 合并时间 07:00:00Z/);
  assert.match(run({ ok: false }).who, /命令失败/);
  assert.equal(run({ ok: false }).verdict, "合并命令不能算发起");
  assert.match(run({ ok: null }).who, /命令结果记录缺失/);
  assert.match(run({ at: "yesterday" }).who, /命令时间读不出/);
  assert.equal(listed([late]).length, 1);
});

test("M6. a late or failed command next to a qualifying one does not hide the qualifying one; and a train merge is not undone by a late command", () => {
  const two = mergeRows({ merged: [merged(21)], train: [], transcripts: [{ id: "t", actor: { actor: "leader", uses: 9, others: [] }, merges: [
    { pr: 21, via: "merge-gate", configIdentity: "leader", at: "2026-11-12T06:50:00Z" }, { pr: 21, via: "merge-gate", configIdentity: "leader", at: "2026-11-12T07:30:00Z" }] }] })[0];
  assert.equal(two.verdict, "本人发起");
  assert.match(two.who, /不能算发起（命令时间 07:30:00Z 晚于/);
  const train = mergeRows({ merged: [merged(22)], train: [{ pr: 22, at: "x", log: "merge-train-1.log" }], transcripts: [{ id: "t", actor: { actor: "leader", uses: 9, others: [] }, merges: [{ pr: 22, via: "merge-gate", configIdentity: "leader", at: "2026-11-12T07:30:00Z" }] }] })[0];
  assert.equal(train.verdict, "合并列车");
});

test("M7. a merged PR with no merge time is listed, the report says so and the format does not fail on it", () => {
  const rows = rawMergeRows({ merged: [{ number: 30, mergedAt: null, title: "t" }, merged(31)], train: [], transcripts: [] });
  assert.equal(rows[0].verdict, "合并时间缺失");
  assert.equal(listed(rows).length, 2);
  const problem = missingMergeTimeProblem([{ number: 30, mergedAt: null }, { number: 31, mergedAt: "2026-11-12T07:00:00Z" }]);
  assert.match(problem, /1 个已合并 PR 没有合并时间（#30）/);
  assert.equal(missingMergeTimeProblem([merged(31)]), null);
  const text = format({ window: { from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" }, sources: {}, problems: [problem], merges: rows, privateFiles: [], humanWrites: [], closures: [] }, 0);
  assert.match(text.split("\n")[0], /^⚠ 核对不完整：/);
  assert.match(text, /时间未知 #30 合并时间缺失/);
  assert.match(text, /判定依据：边界核对判定约定 7c58f1f4 修订 2/);
  assert.equal(exitCodeFor({ problems: [problem] }), 2);
});

test("M8. one transcript whose stat fails is named and skipped alone: a dangling link, and a file that vanishes between the listing and the stat; the other files are still read", async () => {
  const root = mkdtempSync(join(tmpdir(), "bcs-"));
  const at = "2026-11-12T06:59:00Z";
  writeFileSync(join(root, "good.jsonl"), `${codexLine(at, "node /x/merge-gate.mjs merge --pr 7 --execute")}\n`);
  writeFileSync(join(root, "gone.jsonl"), `${codexLine(at, "ls")}\n`);
  writeFileSync(join(root, "later.jsonl"), `${codexLine(at, "ls")}\n`);
  symlinkSync(join(root, "does-not-exist.jsonl"), join(root, "dangling.jsonl"));
  const fromMs = Date.parse("2026-11-12T00:00:00Z");
  for (const name of ["good.jsonl", "gone.jsonl", "later.jsonl"]) utimesSync(join(root, name), new Date(), new Date()); // modified after the window started
  // 1. the real file system: the dangling link
  const problems = [];
  const found = (await transcriptFiles([root], fromMs, problems)).map(path => path.split("/").pop()).sort();
  assert.deepEqual(found, ["gone.jsonl", "good.jsonl", "later.jsonl"], "every other transcript is still listed");
  assert.match(problems.join("\n"), /会话记录读不了（dangling\.jsonl：ENOENT），只有这一个文件没有核对/);
  assert.doesNotMatch(problems.join("\n"), /会话记录目录读取出错/, "the directory as a whole is not given up on");
  // 2. a file that disappears after the listing: the stat of that one name fails, the others succeed
  const later = [];
  const real = await import("node:fs/promises");
  const statFn = async path => { if (path.endsWith("gone.jsonl")) { const error = new Error("vanished"); error.code = "ENOENT"; throw error; } return real.stat(path); };
  const listed = (await transcriptFiles([root], fromMs, later, { statFn })).map(path => path.split("/").pop()).sort();
  assert.deepEqual(listed, ["good.jsonl", "later.jsonl"]);
  assert.match(later.join("\n"), /会话记录读不了（gone\.jsonl：ENOENT），只有这一个文件没有核对/);
  assert.match(later.join("\n"), /dangling\.jsonl/);
  // 3. end to end: readTranscripts still reads the good one, the report is incomplete, the exit code is not zero
  const all = [];
  const transcripts = await readTranscripts([root], fromMs, Date.parse("2026-11-13T00:00:00Z"), all);
  assert.equal(transcripts.length, 3, "good, gone and later are all read; only the dangling link is not");
  assert.ok(transcripts.some(item => item.commands.some(command => command.command.includes("merge-gate.mjs"))));
  assert.match(all.join("\n"), /会话记录读不了（dangling\.jsonl：ENOENT）/);
  assert.equal(exitCodeFor({ problems: all }), 2);
});

// ---- Task ac254c1a, 2026-11-16: the formal run on the deployed code said "核对不完整" for 1,157 lines that were all Claude `api-request-blob` records.
// Real shape (from a session record): { type, hash, message: { role, content: [thinking, tool_use, …] }, sessionId } and NO timestamp, by design.
const blobLine = (command, sessionId = "5f6ad90d-3021-4219-8384-1eb90b06d356") => JSON.stringify({ type: "api-request-blob", hash: "9f2c1d", sessionId,
  message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "tool_use", id: "toolu_01blob", name: "Bash", input: { command } }] } });
const assistantLine = (at, command, id = "toolu_01blob") => JSON.stringify({ type: "assistant", timestamp: at, sessionId: "5f6ad90d", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const assistantNoTime = command => JSON.stringify({ type: "assistant", sessionId: "5f6ad90d", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_02", name: "Bash", input: { command } }] } });

test("B1. an api-request-blob (a mirror of the API request, no timestamp by design) is neither a command nor a bad line; its neighbouring assistant line still gives the command with its time", () => {
  const blob = inspectLine(blobLine("node /x/merge-gate.mjs merge --pr 9 --execute"));
  assert.deepEqual(blob, { commands: [], results: [], defect: null });
  const real = inspectLine(assistantLine("2026-11-12T07:00:00.000Z", "node /x/merge-gate.mjs merge --pr 9 --execute"));
  assert.equal(real.defect, null);
  assert.deepEqual(real.commands.map(item => [item.at, item.callId]), [["2026-11-12T07:00:00.000Z", "toolu_01blob"]]);
  assert.deepEqual(commandsOfLine(blobLine("ls")), []);
});

test("B2. a call record that really has no time is still a defect: a Claude assistant line and a Codex function_call, and an unreadable time; bad JSON is still a defect", () => {
  assert.equal(inspectLine(assistantNoTime("ls")).defect, "缺时间戳或时间戳读不出");
  assert.equal(inspectLine(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c", arguments: JSON.stringify({ cmd: "ls" }) } })).defect, "缺时间戳或时间戳读不出");
  assert.equal(inspectLine(assistantLine("not-a-time", "ls")).defect, "缺时间戳或时间戳读不出");
  assert.equal(inspectLine("{broken tool_use").defect, "JSON 无法解析");
  // other records that mention tool_use without being calls: a tool_result in a user line, an attachment
  assert.equal(inspectLine(JSON.stringify({ type: "user", timestamp: "2026-11-12T07:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_01blob", is_error: false, content: "ok" }] } })).defect, null);
});

test("B3. a transcript of real-shaped lines: blobs plus their assistant lines read clean (no 核对不完整, exit code 0); one real assistant line without a time makes it incomplete and is named by file and line", async () => {
  const root = mkdtempSync(join(tmpdir(), "bcb-"));
  const at = "2026-11-12T06:59:00Z";
  const lines = [blobLine("node /x/merge-gate.mjs merge --pr 7 --execute"), assistantLine(at, "node /x/merge-gate.mjs merge --pr 7 --execute", "toolu_01a"), blobLine("ls"), assistantLine(at, "ls", "toolu_01b")];
  writeFileSync(join(root, "real.jsonl"), `${lines.join("\n")}\n`);
  const clean = [];
  const transcripts = await readTranscripts([root], Date.parse("2026-11-12T00:00:00Z"), Date.parse("2026-11-13T00:00:00Z"), clean);
  assert.deepEqual(clean, [], "1 blob per call: nothing is reported");
  assert.equal(transcripts.length, 1);
  assert.deepEqual(transcripts[0].commands.map(item => item.command), ["node /x/merge-gate.mjs merge --pr 7 --execute", "ls"], "each call once: the blobs add nothing");
  assert.equal(exitCodeFor({ problems: clean }), 0);
  writeFileSync(join(root, "real.jsonl"), `${[...lines, assistantNoTime("pwd")].join("\n")}\n`);
  const dirty = [];
  await readTranscripts([root], Date.parse("2026-11-12T00:00:00Z"), Date.parse("2026-11-13T00:00:00Z"), dirty);
  assert.match(dirty.join("\n"), /会话记录有 1 行无法解析：real\.jsonl:5（缺时间戳或时间戳读不出）/);
  assert.equal(exitCodeFor({ problems: dirty }), 2);
});
