import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { balanceForecast, cyclesAt, formatReading, listRollouts, loadConfig, parseBalances, readDeltas, reading, sumWindow, tokenDeltas } from "./quota-reading.mjs";

const T = text => Date.parse(text);
const HOUR = 3_600_000;
const CONFIG = { provider: "codex", utcOffsetMinutes: 300, balanceUnit: "元", rateWindowHours: 3, lowHours: 4, staleHours: 3, holds: [] };
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

// Balance readings: `n` hourly readings ending at `endMs`, starting at `start` and dropping `perHour` each hour.
const hourly = (endMs, n, start, perHour) => Array.from({ length: n }, (_, index) => ({ at: endMs - (n - 1 - index) * HOUR, balance: start - index * perHour }));

test("Q3. the balance, the pace and how long it lasts agree with a hand calculation on an even decline", () => {
  // 100, 98, 96, 94, 92, 90 yuan, one reading an hour, the last one at NOW: pace of the last 3 hours = (96 - 90) / 3... the window holds 4 readings (3 h)
  const readings = hourly(NOW, 6, 100, 2);
  const f = balanceForecast({ readings, nowMs: NOW, config: CONFIG });
  assert.equal(f.balance, 90); assert.equal(f.ageHours, 0);
  assert.equal(f.perHour, 2); assert.equal(f.paceWindowHours, 3);
  assert.equal(f.hoursLeft, 45); assert.equal(f.runsOutAt, new Date(NOW + 45 * HOUR).toISOString());
  assert.deepEqual(f.flags, []);
  const r = reading({ deltas: [], holds: HOLDS, balances: readings, nowMs: NOW, config: CONFIG });
  assert.equal(r.state, "ok");
  assert.match(r.line, /^余额 90 元（11-15 03:00 读数，刚刚），最近 3 小时每小时掉 2 元，照这个速度还能撑约 45 小时（约 11-17 00:00）$/);
});

test("Q4. a top-up (a reading that is higher than the one before) restarts the pace: only the readings after it count", () => {
  // 100 -> 90 over 5 h (2/h), a top-up to 200, then 3 h at 4/h: 200, 196, 192, 188 -> the pace is 4, not the mix with the old 2
  const old = hourly(NOW - 4 * HOUR, 6, 100, 2), fresh = hourly(NOW, 4, 200, 4);
  const f = balanceForecast({ readings: [...old, ...fresh], nowMs: NOW, config: { ...CONFIG, rateWindowHours: 10 } });
  assert.equal(f.perHour, 4); assert.equal(f.balance, 188); assert.equal(f.hoursLeft, 47);
  assert.equal(f.toppedUpAt, new Date(NOW - 3 * HOUR).toISOString());
  assert.equal(f.paceWindowHours, 3, "the window starts at the top-up reading, not before");
  // two top-ups: the last one counts
  const twice = balanceForecast({ readings: [...old, ...fresh, ...hourly(NOW + 3 * HOUR, 3, 300, 1)], nowMs: NOW + 3 * HOUR, config: CONFIG });
  assert.equal(twice.perHour, 1); assert.equal(twice.hoursLeft, 298);
  const justToppedUp = reading({ deltas: [], holds: HOLDS, balances: [...old, { at: NOW, balance: 500 }], nowMs: NOW, config: CONFIG });
  assert.match(justToppedUp.line, /^余额 500 元（.*刚刚）；只有一条读数，算不出每小时掉多少.*（刚充值，按充值后的读数算）$/);
});

test("Q5. counter-examples: no reading, one reading, an old reading, a pause, no drop, readings from the future, unreadable lines", () => {
  // no balance reading: usage since the release only, no percentage and no time, and the reason said
  const deltas = steady("B", T("2026-11-14T12:00:00Z"), NOW, 5_000_000_000); // far more than the old script's "previous cycle" ever allowed
  const none = reading({ deltas, holds: HOLDS, balances: [], nowMs: NOW, config: CONFIG });
  assert.equal(none.state, "no-balance");
  assert.match(none.line, /^没有余额读数，无法估计还能撑多久。放行 10\.0 小时，已用输入 .* 亿$/);
  assert.doesNotMatch(formatReading(none, CONFIG), /%|已超过额度|上个周期|用完|还能撑约/);
  // one reading: the balance only
  const one = reading({ deltas: [], holds: HOLDS, balances: [{ at: NOW - HOUR / 2, balance: 38 }], nowMs: NOW, config: CONFIG });
  assert.equal(one.state, "balance-only"); assert.match(one.line, /^余额 38 元（.* 读数，30 分钟前）；只有一条读数，算不出每小时掉多少，也就无法估计还能撑多久$/);
  assert.equal(one.balance.rate, null);
  // the last reading is 3 hours old: the age is written, the staleness marked
  const old = reading({ deltas: [], holds: HOLDS, balances: hourly(NOW - 3 * HOUR, 4, 40, 1), nowMs: NOW, config: CONFIG });
  assert.match(old.line, /（11-15 00:00 读数，3 小时前）/); assert.deepEqual(old.flags, ["stale"]); assert.match(old.line, /读数已有 3 小时没更新，数字可能过时/);
  // a pause that is open
  const paused = reading({ deltas: [], holds: [...HOLDS, { openedAt: "2026-11-14T21:00:00Z", releasedAt: null }], balances: hourly(NOW, 4, 40, 1), nowMs: NOW, config: CONFIG });
  assert.equal(paused.state, "paused"); assert.match(paused.line, /^暂停中：提供方自 .* 起处于暂停，没有放行，不做估计；最后一次余额读数：余额 37 元/);
  // not dropping: said, no time
  const flat = reading({ deltas: [], holds: HOLDS, balances: hourly(NOW, 4, 40, 0), nowMs: NOW, config: CONFIG });
  assert.match(flat.line, /最近读数没有下降，无法估计还能撑多久/); assert.equal(flat.balance.hoursLeft, undefined);
  // readings after `now` are not used
  const future = balanceForecast({ readings: [...hourly(NOW, 4, 40, 1), { at: NOW + HOUR, balance: 1 }], nowMs: NOW, config: CONFIG });
  assert.equal(future.balance, 37);
  assert.equal(balanceForecast({ readings: [{ at: NOW + HOUR, balance: 1 }], nowMs: NOW, config: CONFIG }).state, "none");
  // unreadable lines are named with their line number and never guessed
  const parsed = parseBalances("# header\n2026-11-14T10:00:00Z, 40\n\nnot a reading\n2026-11-14T11:00:00Z\t38.5\n{\"at\":\"2026-11-14T12:00:00Z\",\"balance\":37}\n{\"at\":\"x\",\"balance\":1}\n2026-11-14T13:00:00Z, -5\n");
  assert.deepEqual(parsed.readings.map(item => item.balance), [40, 38.5, 37]);
  assert.equal(parsed.problems.length, 3); assert.match(parsed.problems[0], /第 4 行读不出/); assert.match(parsed.problems[1], /第 7 行/); assert.match(parsed.problems[2], /第 8 行/);
});

test("Q6a. fewer than four hours left is marked and the threshold is configurable; a longer reserve is not", () => {
  const readings = hourly(NOW, 4, 20, 4); // 20, 16, 12, 8 yuan at 4/h -> 2 h left
  const low = reading({ deltas: [], holds: HOLDS, balances: readings, nowMs: NOW, config: CONFIG });
  assert.deepEqual(low.flags, ["low"]); assert.match(low.line, /还能撑约 2 小时（约 11-15 .*）；不足 4 小时，请提醒$/);
  assert.match(formatReading(low, CONFIG), /提醒：余额照现在的速度撑不到 4 小时/);
  assert.deepEqual(reading({ deltas: [], holds: HOLDS, balances: readings, nowMs: NOW, config: { ...CONFIG, lowHours: 1 } }).flags, []);
  const ample = reading({ deltas: [], holds: HOLDS, balances: hourly(NOW, 4, 100, 1), nowMs: NOW, config: CONFIG });
  assert.deepEqual(ample.flags, []); assert.doesNotMatch(ample.line, /不足/);
  assert.match(reading({ deltas: [], holds: HOLDS, balances: readings, nowMs: NOW, config: { ...CONFIG, lowHours: 10, balanceUnit: "美元" } }).line, /余额 8 美元.*不足 10 小时/);
});

test("Q6. by Session, and the edges of a window: an event exactly at the start counts, one exactly at the end does not", () => {
  const deltas = [{ at: 10, session: "x", input: 5, cached: 4, output: 1 }, { at: 20, session: "y", input: 7, cached: 7, output: 0 }, { at: 30, session: "x", input: 100, cached: 0, output: 0 }];
  const { total, bySession } = sumWindow(deltas, 10, 30);
  assert.deepEqual([total.input, total.uncachedInput], [12, 1]);
  assert.deepEqual([...bySession.keys()].sort(), ["x", "y"]); assert.equal(bySession.get("x").input, 5);
});

test("Q7. the config: an absolute path outside the repository, an absolute sessions root, pause history, the balance file path, the old keys still load", () => {
  const ok = { codexSessionsRoot: "/srv/codex", utcOffsetMinutes: 300, holds: [] };
  const loaded = loadConfig(JSON.stringify(ok), "/etc/quota.json");
  assert.deepEqual([loaded.rateWindowHours, loaded.lowHours, loaded.staleHours, loaded.balanceUnit], [3, 4, 3, "元"]);
  assert.throws(() => loadConfig(JSON.stringify(ok), "relative.json"), /absolute path outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify(ok), new URL("../../x.json", import.meta.url).pathname), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, codexSessionsRoot: "rel" }), "/etc/q.json"), /codexSessionsRoot/);
  assert.throws(() => loadConfig(JSON.stringify({ codexSessionsRoot: "/srv/codex" }), "/etc/q.json"), /databaseUrl \+ projectId .* or holds/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, balanceReadings: "balances.txt" }), "/etc/q.json"), /balanceReadings must be an absolute path outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, balanceReadings: new URL("../../b.txt", import.meta.url).pathname }), "/etc/q.json"), /balanceReadings must be an absolute path outside the repository/);
  assert.equal(loadConfig(JSON.stringify({ ...ok, balanceReadings: "/srv/balances.txt" }), "/etc/q.json").balanceReadings, "/srv/balances.txt");
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, lowHours: 0 }), "/etc/q.json"), /lowHours must be a positive number/);
  assert.throws(() => loadConfig(JSON.stringify({ ...ok, rateWindowHours: "x" }), "/etc/q.json"), /rateWindowHours/);
  assert.doesNotThrow(() => loadConfig(JSON.stringify({ ...ok, weights: { input: 1 }, warnAt: [0.6], windowHours: 2, recharge: { amount: 5 } }), "/etc/q.json"), "an old config still loads; its old keys are ignored");
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

test("Q9. the printout: the one-line conclusion first, the usage since the release and the Sessions, the reminder line; an incomplete read says so on the first line", () => {
  const deltas = [...steady("B", T("2026-11-14T12:00:00Z"), NOW, 200), ...steady("C", T("2026-11-14T12:00:00Z"), NOW, 50)];
  const r = reading({ deltas, holds: HOLDS, balances: hourly(NOW, 4, 20, 4), nowMs: NOW, config: CONFIG });
  const text = formatReading(r, CONFIG);
  const lines = text.split("\n");
  assert.match(lines[0], /^余额 8 元（.* 读数，刚刚），最近 3 小时每小时掉 4 元，照这个速度还能撑约 2 小时/);
  assert.match(text, /放行以来的用量（自 .*，10 小时）：输入 .* 亿，其中未命中缓存 .* 亿，输出 .* 亿/);
  assert.match(text, /分 Session（输入 \/ 未命中缓存 \/ 输出）：[\s\S]*B：[\s\S]*C：/);
  assert.doesNotMatch(text, /相当于上个周期|已超过额度|%/);
  const incomplete = formatReading(r, CONFIG, { problems: ["余额读数第 4 行读不出"] });
  assert.match(incomplete.split("\n")[0], /^⚠ 读数不完整：/);
});

test("Q10. the command: no balance file, an unreadable file, one reading and a full series; the exit code, the old way of calling, nothing written", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-cli-")), sessions = join(dir, "codex"), day = join(sessions, "2026", "11", "14"); mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-14T10-00-00-01a1c691-e8b4-7c11-9d2e-5f0a1b2c3d4e.jsonl"), `${countLine("2026-11-14T13:00:00Z", 5_000_000, 4_500_000, 5000)}\n${countLine("2026-11-14T14:00:00Z", 6_000_000, 5_400_000, 6000)}\n`);
  const config = join(dir, "quota.json"), balances = join(dir, "balances.txt");
  // the old-style config: its old keys are ignored, and no balance file is named anywhere
  writeFileSync(config, JSON.stringify({ codexSessionsRoot: sessions, utcOffsetMinutes: 300, weights: { input: 1 }, warnAt: [0.6, 0.8], windowHours: 2,
    holds: [{ openedAt: "2026-11-10T00:00:00Z", releasedAt: "2026-11-10T01:00:00Z" }, { openedAt: "2026-11-13T00:00:00Z", releasedAt: "2026-11-14T12:00:00Z" }] }));
  const run = (args = [], env = {}) => spawnSync(process.execPath, ["scripts/ops/quota-reading.mjs", ...args], { encoding: "utf8", env: { ...process.env, EVOLOOP_QUOTA_BALANCES: "", EVOLOOP_QUOTA_CONFIG: config, ...env } });
  const NOWISO = "2026-11-14T15:00:00Z";
  const none = run(["--now", NOWISO]);
  assert.equal(none.status, 0); assert.match(none.stdout.split("\n")[0], /^没有余额读数，无法估计还能撑多久。放行 3\.0 小时，已用输入 /); assert.doesNotMatch(none.stdout, /%|已超过额度/);
  const missing = run(["--now", NOWISO, "--balances", join(dir, "nowhere.txt")]);
  assert.equal(missing.status, 0); assert.match(missing.stdout.split("\n")[0], /^没有余额读数/, "a missing file is no reading, not an error");
  writeFileSync(balances, `${["2026-11-14T12:00:00Z, 50", "2026-11-14T13:00:00Z, 48", "2026-11-14T14:00:00Z, 46", "2026-11-14T15:00:00Z, 44"].join("\n")}\n`);
  const full = run(["--now", NOWISO], { EVOLOOP_QUOTA_BALANCES: balances });
  assert.equal(full.status, 0); assert.match(full.stdout.split("\n")[0], /^余额 44 元（.* 读数，刚刚），最近 3 小时每小时掉 2 元，照这个速度还能撑约 22 小时/);
  const asJson = JSON.parse(run(["--now", NOWISO, "--json", "--balances", balances]).stdout);
  assert.equal(asJson.state, "ok"); assert.equal(asJson.balance.hoursLeft, 22); assert.deepEqual(asJson.problems, []);
  writeFileSync(balances, "2026-11-14T14:00:00Z, 46\nbroken line\n");
  const bad = run(["--now", NOWISO, "--balances", balances]);
  assert.equal(bad.status, 2); assert.match(bad.stdout.split("\n")[0], /^⚠ 读数不完整：余额读数第 2 行读不出/); assert.match(bad.stdout, /只有一条读数/);
  assert.equal(run(["--now", NOWISO, "--balances", "relative.txt"]).status, 1);
  symlinkSync(join(day, "nowhere.jsonl"), join(day, "rollout-2026-11-14T10-00-00-01a1c692-e8b4-7c11-9d2e-5f0a1b2c3d4e.jsonl"));
  const broken = run(["--now", NOWISO]);
  assert.equal(broken.status, 2); assert.match(broken.stdout.split("\n")[0], /^⚠ 读数不完整：/);
  writeFileSync(config, "{}");
  assert.equal(run().status, 1);
  assert.equal(spawnSync(process.execPath, ["scripts/ops/quota-reading.mjs"], { encoding: "utf8", env: { ...process.env, EVOLOOP_QUOTA_CONFIG: "" } }).status, 2);
});
