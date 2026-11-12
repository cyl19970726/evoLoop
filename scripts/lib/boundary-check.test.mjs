import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsOfLine, configIdentity, day, declaredStage, dominantActor, expandLoops, jsonKeyDiff, mentionsCandidate, mentionsFormalReadback,
  mentionsNear, mergeInvocations, mergeRows, parseTrainLog,
} from "./boundary-check.mjs";
import { loadConfig } from "../ops/boundary-check.mjs";

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

test("a day is 24 hours of local time, and the config must live outside the repository with its required fields", () => {
  assert.deepEqual(day("2026-11-12", 300), { from: "2026-11-11T19:00:00.000Z", to: "2026-11-12T19:00:00.000Z" });
  assert.throws(() => day("11-12", 300), /YYYY-MM-DD/);
  const ok = JSON.stringify({ repo: "o/r", utcOffsetMinutes: 300, humanActors: ["owner-human"] });
  assert.ok(loadConfig(ok, "/etc/boundary.json"));
  assert.throws(() => loadConfig(ok, new URL("../../x.json", import.meta.url).pathname), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ repo: "o/r", humanActors: ["h"] }), "/etc/b.json"), /utcOffsetMinutes/);
  assert.throws(() => loadConfig(JSON.stringify({ repo: "o/r", utcOffsetMinutes: 0, humanActors: [] }), "/etc/b.json"), /humanActors/);
});
