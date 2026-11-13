import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsOfLine, configIdentity, day, declaredStage, dominantActor, expandLoops, ghMergeNumber, jsonKeyDiff, mentionsCandidate, mentionsFormalReadback,
  mentionsNear, mergeInvocations, mergeRows, parseTrainLog,
  MERGE_OK, configProblems, exitCodeFor, judgeClosure, mentionsAnywhere, mentionsFile, targetLabel, truncationProblem,
} from "./boundary-check.mjs";
import { format, loadConfig } from "../ops/boundary-check.mjs";

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
  assert.deepEqual(commandsOfLine("not json function_call"), []);
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
    { id: "01a1befd", actor: { actor: "leader" }, merges: [{ pr: 382, at: "a", configIdentity: "requirements", via: "merge-gate", command: "SECRET-TOKEN" }] },
    { id: "0b0b0b0b", actor: { actor: "requirements" }, merges: [{ pr: 400, at: "b", configIdentity: "requirements", via: "merge-gate" }] },
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
  assert.equal(mentionsFormalReadback("正式环境已验证"), true);
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
  for (const text of ["候选已用，正式实例读回通过", "正式环境已验证", "候选通过；正式实测通过"]) assert.equal(mentionsFormalReadback(text), true, text);
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
  assert.equal(judgeClosure({ evidence: "候选通过；正式实例读回通过", hasDelivery: true, stage: null }).flagged, false);
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
