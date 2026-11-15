import assert from "node:assert/strict";
import test from "node:test";
import { alertDecision, alertText, exitCodeFor, formatPatrol, loadPatrol, patrolOnce, readOccurrences, skippedOccurrences } from "./ops-patrol.mjs";

const NOW = Date.parse("2026-11-15T07:00:00Z");
const GB = 1024 ** 3;
const patrol = { cli: "/opt/agent/evoloop", projectId: "P", leaderSessionKey: "owned:L", watchSchedules: ["f3d7cfe6-5781-48b0-919a-9c0fa92e7abc"], stateFile: "/state/patrol.json", alertIntervalMinutes: 360, skipLookbackHours: 48 };
const occ = (plannedAtUtc, state, operationId) => ({ plannedAtUtc, state, reason: state === "skipped" ? "overlap skipped" : "scheduled", operationId, taskId: state === "skipped" ? null : "t" });
const OCCURRENCES = [occ("2026-11-12T03:00:00Z", "skipped", "old"), occ("2026-11-14T03:00:00Z", "skipped", "op-a"), occ("2026-11-14T15:00:00Z", "skipped", "op-b"), occ("2026-11-15T03:00:00Z", "created", "op-c")];

// A fake CLI: records what is run, answers the occurrence read, and the send.
function fakeCli({ occurrences = OCCURRENCES, failSend = false, failRead = false } = {}) {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args, input: options?.input });
    if (args[0] === "read") { if (failRead) throw Object.assign(new Error("boom"), { status: 1 }); return JSON.stringify(occurrences); }
    if (args[0] === "work" && args[1] === "send") { if (failSend) throw new Error("send refused"); return '{"status":"queued"}\n'; }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls };
}
const reportOf = (over = {}) => ({ generatedAt: "2026-11-15T07:00:00Z", execute: true, freeBytesBefore: 4 * GB, freeBytes: 30 * GB, minFreeBytes: 20 * GB, lowSpace: false, worktrees: { count: 0, totalBytes: 0 }, instances: { running: 0, underTestRoots: 0, totalBytes: 0 }, reclaimed: [], skipped: [], failed: [], processesKnown: true, deps: undefined, ...over });
const withReport = report => ({ adapter: {}, reclaimFn: async () => report });

test("P1. only occurrences the schedule skipped inside the look-back window count", () => {
  const found = skippedOccurrences("sid", OCCURRENCES, NOW, 48);
  assert.deepEqual(found.map(item => item.operationId), ["op-a", "op-b"], "an old skip and a created occurrence are not reported");
  assert.deepEqual(skippedOccurrences("sid", null, NOW, 48), []);
});

test("P2. a skipped occurrence not told before is told once; a repeat is not; low space is told again only after the interval", () => {
  const skipped = skippedOccurrences("sid", OCCURRENCES, NOW, 48);
  assert.deepEqual(alertDecision({ lowSpace: false, skipped, state: {}, nowMs: NOW, intervalMinutes: 360 }).fresh.map(item => item.operationId), ["op-a", "op-b"]);
  assert.equal(alertDecision({ lowSpace: false, skipped, state: { toldOccurrences: ["op-a", "op-b"] }, nowMs: NOW, intervalMinutes: 360 }).send, false);
  assert.equal(alertDecision({ lowSpace: false, skipped, state: { toldOccurrences: ["op-a"] }, nowMs: NOW, intervalMinutes: 360 }).fresh.length, 1);
  const recent = { lastLow: true, lastAlertAt: "2026-11-15T05:00:00Z" }, stale = { lastLow: true, lastAlertAt: "2026-11-15T00:00:00Z" };
  assert.equal(alertDecision({ lowSpace: true, skipped: [], state: recent, nowMs: NOW, intervalMinutes: 360 }).send, false);
  assert.equal(alertDecision({ lowSpace: true, skipped: [], state: stale, nowMs: NOW, intervalMinutes: 360 }).send, true);
  assert.equal(alertDecision({ lowSpace: true, skipped: [], state: {}, nowMs: NOW, intervalMinutes: 360 }).send, true, "first low reading is told at once");
  assert.equal(alertDecision({ lowSpace: false, skipped: [], state: { lastLow: true, lastAlertAt: "2026-11-14T00:00:00Z" }, nowMs: NOW, intervalMinutes: 360 }).send, false);
});

test("P3. the message names space, the skipped times and ids, never a path or a command", () => {
  const text = alertText({ report: reportOf({ lowSpace: true, freeBytes: 4.2 * GB }), fresh: skippedOccurrences("f3d7cfe6-5781", OCCURRENCES, NOW, 48), lowDue: true, generatedAt: "2026-11-15T07:00:00Z" });
  assert.match(text, /可用空间 4\.2 GB,低于阈值 20\.0 GB/);
  assert.match(text, /日程 f3d7cfe6 计划 2026-11-14T03:00:00Z 的时刻:overlap skipped/);
  assert.doesNotMatch(text, /\/Users\/|\/private\//);
});

test("P4. a skip is sent to the Leader through `work send` and remembered; a second run with the same skip sends nothing", async () => {
  const cli = fakeCli(); const files = {};
  const common = { patrol, config: {}, execute: false, now: NOW, exec: cli.exec, write: (path, text) => { files[path] = JSON.parse(text); }, read: path => files[path] ?? {}, ...withReport(reportOf()) };
  const run = () => patrolOnce(common);
  const first = await run();
  assert.equal(first.decision.send, true);
  const sends = cli.calls.filter(call => call.args[0] === "work");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args, ["work", "send", "owned:L", "--project", "P", "--stdin"]);
  assert.match(sends[0].input, /2 个日程时刻被跳过/);
  assert.deepEqual(files["/state/patrol.json"].toldOccurrences.sort(), ["op-a", "op-b"]);
  const second = await run();
  assert.equal(second.decision.send, false);
  assert.equal(cli.calls.filter(call => call.args[0] === "work").length, 1, "no second message for the same skips");
});

test("P5. a message that does not go out, or a schedule that cannot be read, makes the patrol incomplete (exit 1) and is tried again next time", async () => {
  const files = {};
  const run = (cli) => patrolOnce({ patrol, config: {}, execute: false, now: NOW, exec: cli.exec, write: (path, text) => { files[path] = JSON.parse(text); }, read: path => files[path] ?? {}, ...withReport(reportOf()) });
  const refused = await run(fakeCli({ failSend: true }));
  assert.match(refused.problems.join("|"), /告警没有送出/);
  assert.equal(files["/state/patrol.json"], undefined, "not remembered, so the next patrol tries again");
  assert.equal(exitCodeFor(refused), 1);
  const unreadable = await run(fakeCli({ failRead: true }));
  assert.match(unreadable.problems.join("|"), /读日程 f3d7cfe6 的时刻失败.*无法确认/);
  assert.match(formatPatrol(unreadable), /^⚠ 巡检不完整或告警未送出/);
  assert.equal(readOccurrences({ ...patrol, nowMs: NOW }, fakeCli({ failRead: true }).exec).problems.length, 1);
});

test("P6. loadPatrol wants an absolute CLI and state file outside the repository, a project, a Leader key and a schedule list", () => {
  assert.equal(loadPatrol({ patrol }, "/p").alertIntervalMinutes, 360);
  assert.throws(() => loadPatrol({}, "/p"), /config\.patrol is required/);
  assert.throws(() => loadPatrol({ patrol: { ...patrol, cli: "evoloop" } }, "/p"), /patrol\.cli must be an absolute path/);
  assert.throws(() => loadPatrol({ patrol: { ...patrol, stateFile: new URL("../../x.json", import.meta.url).pathname } }, "/p"), /stateFile must be an absolute path outside the repository/);
  assert.throws(() => loadPatrol({ patrol: { ...patrol, leaderSessionKey: "" } }, "/p"), /leaderSessionKey is required/);
  assert.throws(() => loadPatrol({ patrol: { ...patrol, watchSchedules: "x" } }, "/p"), /watchSchedules must be a list/);
});
