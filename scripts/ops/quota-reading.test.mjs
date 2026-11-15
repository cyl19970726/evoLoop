import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cyclesAt, formatReading, listRollouts, loadConfig, readDeltas, reading, sumWindow, tokenDeltas } from "./quota-reading.mjs";

const T = text => Date.parse(text);
const HOUR = 3_600_000;
const CONFIG = { provider: "codex", utcOffsetMinutes: 300, windowHours: 2, warnAt: [0.6, 0.8], weights: { input: 1, uncachedInput: 0, output: 0 }, holds: [] };
const countLine = (at, input, cached, output) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
// An even pace: `perHour` input tokens every hour (cached share 90%, output 1%), between two instants, in 15-minute events.
const steady = (session, fromMs, toMs, perHour) => {
  const out = [];
  for (let at = fromMs; at < toMs; at += HOUR / 4) out.push({ at, session, input: perHour / 4, cached: perHour / 4 * 0.9, output: perHour / 4 * 0.01 });
  return out;
};
// holds: first pause 11-12 04:00–05:00 (so a cycle starts 05:00), second pause 11-13 05:00–11-14 12:00, now 11-14 22:00
const HOLDS = [{ openedAt: "2026-11-12T04:00:00Z", releasedAt: "2026-11-12T05:00:00Z" }, { openedAt: "2026-11-13T05:00:00Z", releasedAt: "2026-11-14T12:00:00Z" }];
const NOW = T("2026-11-14T22:00:00Z");
const previous = (perHour = 100) => steady("A", T("2026-11-12T05:00:00Z"), T("2026-11-13T05:00:00Z"), perHour); // 24 h of 100/h = 2400

test("Q1. token counts: steps of the cumulative counter, a restarted counter, lines that are not token counts, bad JSON", () => {
  const deltas = tokenDeltas([countLine("2026-11-14T10:00:00Z", 100, 80, 5), "{not json \"token_count\"", '{"timestamp":"2026-11-14T10:01:00Z","payload":{"type":"agent_message","message":"token_count"}}',
    countLine("2026-11-14T10:05:00Z", 250, 200, 9), countLine("2026-11-14T10:09:00Z", 40, 30, 1), countLine("2026-11-14T10:10:00Z", 60, 50, 3)]);
  assert.deepEqual(deltas.map(item => [item.input, item.cached, item.output]), [[100, 80, 5], [150, 120, 4], [40, 30, 1], [20, 20, 2]]);
  assert.equal(deltas[0].at, T("2026-11-14T10:00:00Z"));
});

test("Q2. cycles from the pause history: none, paused, the first pause (no previous cycle), two pauses, a pause in the future, a release that had not happened yet", () => {
  assert.equal(cyclesAt([], NOW).state, "no-history");
  assert.deepEqual(cyclesAt([{ openedAt: "2026-11-14T20:00:00Z", releasedAt: null }], NOW), { state: "paused", openedAt: T("2026-11-14T20:00:00Z") });
  const one = cyclesAt([HOLDS[0]], NOW);
  assert.equal(one.state, "running"); assert.equal(one.previous, null);
  assert.deepEqual(one.current, { start: T("2026-11-12T05:00:00Z"), end: NOW });
  const two = cyclesAt(HOLDS, NOW);
  assert.deepEqual(two.current, { start: T("2026-11-14T12:00:00Z"), end: NOW });
  assert.deepEqual(two.previous, { start: T("2026-11-12T05:00:00Z"), end: T("2026-11-13T05:00:00Z") });
  assert.equal(cyclesAt([...HOLDS, { openedAt: "2026-11-15T01:00:00Z", releasedAt: null }], NOW).current.start, T("2026-11-14T12:00:00Z"), "a pause that opens after `now` does not exist yet");
  const unreleased = cyclesAt(HOLDS, T("2026-11-13T20:00:00Z"));
  assert.equal(unreleased.state, "paused", "at that time the release of the second pause had not happened");
});

test("Q3. the reading: used, the share of the previous cycle by kind, weights, the 60% and 80% lines, and the time the quota runs out at the recent pace", () => {
  // previous cycle: 100/h for 24 h = 2400 input; current: 10 h at 100/h (3 h after release then recent pace 100/h)
  const deltas = [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 100)];
  const r = reading({ deltas, holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.equal(r.state, "ok");
  assert.equal(Math.round(r.current.totals.input), 1000);
  assert.ok(Math.abs(r.percent.input - 1000 / 2400) < 1e-9); assert.ok(Math.abs(r.percent.weighted - 1000 / 2400) < 1e-9);
  assert.ok(Math.abs(r.percent.output - r.percent.input) < 1e-9, "the three kinds are given separately");
  assert.deepEqual(r.flags, []);
  // remaining 1400 at 100/h = 14 h after 22:00 -> 12:00 the next day
  assert.equal(r.eta, "2026-11-15T12:00:00.000Z");
  assert.match(r.line, /^放行 10\.0 小时，已用上个周期的 42%，照现在的速度约 11-15 17:00 用完$/);
  const doubled = reading({ deltas: [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 200)], holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.deepEqual(doubled.flags, [0.6, 0.8]); assert.match(doubled.line, /已用上个周期的 83%（已过 60%、80% 线）/);
  const mid = reading({ deltas: [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 150)], holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.deepEqual(mid.flags, [0.6]); assert.match(mid.line, /（已过 60% 线）/);
  const byCost = reading({ deltas: [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 100)], holds: HOLDS, nowMs: NOW, config: { ...CONFIG, weights: { input: 0, uncachedInput: 1, output: 0 } } });
  assert.ok(Math.abs(byCost.percent.weighted - 1000 / 2400) < 1e-9, "uncached input is its own share and can be the weighted one");
});

test("Q4. it says so instead of giving a number: no history, a pause that is open, no previous cycle, no recent use, over the quota", () => {
  const deltas = [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 100)];
  assert.match(reading({ deltas, holds: [], nowMs: NOW, config: CONFIG }).line, /^无法估计：没有任何提供方暂停\/放行记录/);
  const paused = reading({ deltas, holds: [...HOLDS, { openedAt: "2026-11-14T21:00:00Z", releasedAt: null }], nowMs: NOW, config: CONFIG });
  assert.equal(paused.state, "paused"); assert.match(paused.line, /^暂停中：/); assert.equal(paused.eta, undefined);
  const first = reading({ deltas, holds: [HOLDS[0]], nowMs: NOW, config: CONFIG });
  assert.equal(first.state, "no-estimate"); assert.match(first.line, /^无法估计：放行 .* 小时，已用输入 .* 亿，但没有上一个完整周期可比/); assert.equal(first.eta, undefined); assert.equal(first.percent, undefined);
  const quiet = reading({ deltas: [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), T("2026-11-14T18:00:00Z"), 100)], holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.match(quiet.line, /最近 2\.0 小时几乎没有用量，无法估计用完时间/); assert.equal(quiet.eta, undefined);
  const over = reading({ deltas: [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 300)], holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.match(over.line, /已超过额度/); assert.equal(over.eta, undefined);
  const emptyPrevious = reading({ deltas: steady("B", T("2026-11-14T12:00:00Z"), NOW, 100), holds: HOLDS, nowMs: NOW, config: CONFIG });
  assert.match(emptyPrevious.line, /^无法估计：.*上一个完整周期按当前权重的用量是 0/);
});

test("Q5. with a recharge amount and unit prices the quota is that amount: no previous cycle is needed", () => {
  const config = { ...CONFIG, recharge: { amount: 10, unitPrice: { uncachedInput: 1, cachedInput: 0.1, output: 2 } } }; // per million tokens
  const deltas = steady("B", T("2026-11-14T12:00:00Z"), NOW, 1_000_000);
  const r = reading({ deltas, holds: [HOLDS[0], HOLDS[1]].slice(0, 2), nowMs: NOW, config });
  // 10 h: 10M input (9M cached, 1M uncached) + 0.1M output = 1*1 + 9*0.1 + 0.1*2 = 2.1 ... per 1M/h: 0.1 + 0.9*0.1 + 0.02 = 0.21 per hour -> 2.1 in 10 h
  assert.ok(Math.abs(r.percent.amount - 0.21) < 1e-9);
  assert.match(r.line, /已用充值金额的 21%/); assert.equal(r.basis, "充值金额");
  const noPrevious = reading({ deltas, holds: [HOLDS[1]], nowMs: NOW, config });
  assert.match(noPrevious.line, /已用充值金额的 21%/, "no previous cycle is needed when the amount is given");
});

test("Q6. by Session, and the edges of a window: an event exactly at the start counts, one exactly at the end does not", () => {
  const deltas = [{ at: 10, session: "x", input: 5, cached: 4, output: 1 }, { at: 20, session: "y", input: 7, cached: 7, output: 0 }, { at: 30, session: "x", input: 100, cached: 0, output: 0 }];
  const { total, bySession } = sumWindow(deltas, 10, 30);
  assert.deepEqual([total.input, total.uncachedInput], [12, 1]);
  assert.deepEqual([...bySession.keys()].sort(), ["x", "y"]); assert.equal(bySession.get("x").input, 5);
});

test("Q7. the config: an absolute path outside the repository, an absolute sessions root, pause history, sensible weights", () => {
  const ok = { codexSessionsRoot: "/srv/codex", utcOffsetMinutes: 300, holds: [] };
  assert.equal(loadConfig(JSON.stringify(ok), "/etc/quota.json").windowHours, 2);
  assert.throws(() => loadConfig(JSON.stringify(ok), "relative.json"), /absolute path outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify(ok), new URL("../../x.json", import.meta.url).pathname), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, codexSessionsRoot: "rel" }), "/etc/q.json"), /codexSessionsRoot/);
  assert.throws(() => loadConfig(JSON.stringify({ codexSessionsRoot: "/srv/codex" }), "/etc/q.json"), /databaseUrl \+ projectId .* or holds/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, weights: { input: 0, uncachedInput: 0, output: 0 } }), "/etc/q.json"), /at least one kind/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, weights: { input: -1 } }), "/etc/q.json"), /weights\.input/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, recharge: { amount: 5 } }), "/etc/q.json"), /recharge needs/);
});

test("Q8. native records: only recent ones are listed, the thread comes from the file name, one unreadable file is named and the rest still count", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-")), day = join(root, "2026", "11", "14"); mkdirSync(day, { recursive: true });
  const name = (thread, rest) => `rollout-2026-11-14T10-00-00-${thread}-${rest}.jsonl`;
  const good = join(day, name("01a1c691", "e8b4-7c11-9d2e-5f0a1b2c3d4e")), old = join(day, name("01a1c692", "e8b4-7c11-9d2e-5f0a1b2c3d4e")), dangling = join(day, name("01a1c693", "e8b4-7c11-9d2e-5f0a1b2c3d4e"));
  writeFileSync(good, `${countLine("2026-11-14T10:00:00Z", 100, 90, 4)}\n${countLine("2026-11-14T11:00:00Z", 300, 270, 10)}\n`);
  writeFileSync(old, `${countLine("2026-11-10T10:00:00Z", 999, 0, 0)}\n`);
  utimesSync(old, new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T10:00:00Z"));
  symlinkSync(join(day, "nowhere.jsonl"), dangling);
  const problems = [];
  const files = await listRollouts(root, T("2026-11-14T00:00:00Z"), problems);
  assert.deepEqual(files.map(file => file.thread), ["01a1c691"]);
  assert.match(problems.join("\n"), /记录读不了（rollout-.*01a1c693.*：ENOENT），只有这一个文件没有算/);
  const deltas = await readDeltas([...files, { path: join(day, "missing.jsonl"), thread: "ffffffff" }], problems, thread => (thread === "01a1c691" ? "角色甲" : `${thread}（未登记）`));
  assert.deepEqual(deltas.map(item => [item.session, item.input]), [["角色甲", 100], ["角色甲", 200]]);
  assert.match(problems.join("\n"), /记录读不了（missing\.jsonl：ENOENT）/);
});

test("Q9. the printout: one line first, the three kinds and the weighted total, Sessions, the reminder lines; an incomplete read says so on the first line", () => {
  const deltas = [...previous(100), ...steady("B", T("2026-11-14T12:00:00Z"), NOW, 200), ...steady("C", T("2026-11-14T12:00:00Z"), NOW, 50)];
  const r = reading({ deltas, holds: HOLDS, nowMs: NOW, config: CONFIG });
  const text = formatReading(r, CONFIG);
  const lines = text.split("\n");
  assert.match(lines[0], /^放行 10\.0 小时，已用上个周期的 1\d\d%/);
  assert.match(text, /相当于上个周期的：输入 \d+%，未命中缓存 \d+%，输出 \d+%；按权重（输入 1、未命中缓存 0、输出 0）合计/);
  assert.match(text, /分 Session（输入 \/ 未命中缓存 \/ 输出）：[\s\S]*B：[\s\S]*C：/);
  const incomplete = formatReading(r, CONFIG, { problems: ["记录读不了（x.jsonl：ENOENT）"] });
  assert.match(incomplete.split("\n")[0], /^⚠ 读数不完整：/);
});

test("Q10. the command: from a config with a pause list it prints the one-line conclusion, exits 2 when a record could not be read, 1 for a bad config, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-cli-")), sessions = join(dir, "codex"), day = join(sessions, "2026", "11", "14"); mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-14T10-00-00-01a1c691-e8b4-7c11-9d2e-5f0a1b2c3d4e.jsonl"), `${countLine("2026-11-11T10:00:00Z", 5_000_000, 4_500_000, 5000)}\n${countLine("2026-11-14T13:00:00Z", 6_000_000, 5_400_000, 6000)}\n`);
  const config = join(dir, "quota.json");
  writeFileSync(config, JSON.stringify({ codexSessionsRoot: sessions, utcOffsetMinutes: 300, holds: [{ openedAt: "2026-11-10T00:00:00Z", releasedAt: "2026-11-10T01:00:00Z" }, { openedAt: "2026-11-13T00:00:00Z", releasedAt: "2026-11-14T12:00:00Z" }] }));
  const run = (...args) => spawnSync(process.execPath, ["scripts/ops/quota-reading.mjs", ...args], { encoding: "utf8", env: { ...process.env, EVOLOOP_QUOTA_CONFIG: config } });
  const ok = run("--now", "2026-11-14T15:00:00Z");
  assert.equal(ok.status, 0); assert.match(ok.stdout.split("\n")[0], /^放行 3\.0 小时，已用上个周期的/);
  const asJson = JSON.parse(run("--now", "2026-11-14T15:00:00Z", "--json").stdout);
  assert.equal(asJson.state, "ok"); assert.deepEqual(asJson.problems, []);
  symlinkSync(join(day, "nowhere.jsonl"), join(day, "rollout-2026-11-14T10-00-00-01a1c692-e8b4-7c11-9d2e-5f0a1b2c3d4e.jsonl"));
  const broken = run("--now", "2026-11-14T15:00:00Z");
  assert.equal(broken.status, 2); assert.match(broken.stdout.split("\n")[0], /^⚠ 读数不完整：/);
  writeFileSync(config, "{}");
  assert.equal(run().status, 1);
  assert.equal(spawnSync(process.execPath, ["scripts/ops/quota-reading.mjs"], { encoding: "utf8", env: { ...process.env, EVOLOOP_QUOTA_CONFIG: "" } }).status, 2);
});
