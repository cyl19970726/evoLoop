#!/usr/bin/env node
// Quota reading from the real balance: the balance now, how much it drops per hour, and how many hours it lasts at that pace. Read only: it reads a
// file of balance readings (one "time, amount" per line), the Codex Sessions' native records (usage since the provider pause was last released) and the
// provider pause history (database in a read-only transaction, or a list in the config). It reads no bill, calls no provider API, writes nothing and
// sends nothing. Without a balance reading it reports the usage since the release and says it cannot estimate how long the balance lasts: no percentage,
// no time. (Before, it took the previous full cycle's usage as the quota; the top-ups differ by ~10x, so that was wrong and is gone.)
//   quota-reading.mjs [--now ISO] [--json] [--config PATH] [--balances PATH]   config: EVOLOOP_QUOTA_CONFIG (an absolute path outside the repository)
// Balance readings file: EVOLOOP_QUOTA_BALANCES, --balances, or config.balanceReadings (an absolute path outside the repository). One reading per line,
//   "2026-11-17T08:00:00Z, 38.5" (comma, tab or spaces between the time and the amount) or {"at": "...", "balance": 38.5}; blank lines and # lines are
//   skipped, a line that cannot be read is named in the output. A reading higher than the one before it is a top-up: the pace only uses the readings
//   from the last top-up on. A missing file is "no balance reading".
// Config (JSON): { codexSessionsRoot (abs), provider ("codex"), utcOffsetMinutes (for the clock times printed), databaseUrl + projectId (pause history and
//   Session names) | holds: [{ openedAt, releasedAt|null }], balanceReadings (abs path), balanceUnit ("元"), rateWindowHours (3: the pace uses the
//   readings of the last this-many hours), lowHours (4: marked when it lasts less), staleHours (3: marked when the last reading is older),
//   sessionLabels: { "<8 characters of the thread id>": "label" } }. The old keys weights, warnAt, windowHours and recharge are accepted and ignored.
import { createReadStream, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOUR = 3_600_000, GB_LABEL = 1e8;
export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const positive = (value, name) => { if (!Number.isFinite(value) || value <= 0) throw new Error(`config.${name} must be a positive number`); return value; };

export function loadConfig(text, path) {
  const real = (() => { try { return realpathSync(path); } catch { return resolve(path); } })();
  if (!isAbsolute(path) || real.startsWith(repoRoot + sep)) throw new Error("Quota config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  if (typeof config.codexSessionsRoot !== "string" || !isAbsolute(config.codexSessionsRoot)) throw new Error("config.codexSessionsRoot must be an absolute path");
  if (!Number.isInteger(config.utcOffsetMinutes ?? 0)) throw new Error("config.utcOffsetMinutes must be a whole number of minutes");
  const hasDb = config.databaseUrl && config.projectId;
  if (!hasDb && !Array.isArray(config.holds)) throw new Error("config needs databaseUrl + projectId (pause history from the database) or holds: [{ openedAt, releasedAt }]");
  if (config.balanceReadings !== undefined) checkBalancePath(config.balanceReadings, "config.balanceReadings");
  if (config.balanceUnit !== undefined && (typeof config.balanceUnit !== "string" || !config.balanceUnit)) throw new Error("config.balanceUnit must be a non-empty text");
  return { provider: "codex", balanceUnit: "元", ...config, rateWindowHours: positive(config.rateWindowHours ?? 3, "rateWindowHours"), lowHours: positive(config.lowHours ?? 4, "lowHours"), staleHours: positive(config.staleHours ?? 3, "staleHours") };
}

/** The balance file path must be absolute and outside the repository (it is private operations data). */
export function checkBalancePath(path, name = "balance readings path") {
  const real = (() => { try { return realpathSync(path); } catch { return resolve(String(path)); } })();
  if (typeof path !== "string" || !isAbsolute(path) || real.startsWith(repoRoot + sep)) throw new Error(`${name} must be an absolute path outside the repository`);
  return path;
}

/** Per-event usage of one native record: the cumulative counter's step between two token_count events (a counter that goes down starts again from 0). */
export function tokenDeltas(lines) {
  const out = [];
  let previous = null;
  for (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const usage = record?.payload?.type === "token_count" ? record.payload.info?.total_token_usage : null;
    const at = Date.parse(record?.timestamp);
    if (!usage || !Number.isFinite(at) || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) continue;
    const current = [usage.input_tokens, usage.cached_input_tokens ?? 0, usage.output_tokens];
    let step = previous ? current.map((value, index) => value - previous[index]) : current;
    if (step.some(value => value < 0)) step = current;
    previous = current;
    out.push({ at, input: step[0], cached: step[1], output: step[2] });
  }
  return out;
}

/**
 * The cycles at `nowMs`, from the pause history: [{ openedAt, releasedAt|null }] as ISO strings or ms. A pause opened after `nowMs` is ignored; a release
 * after `nowMs` had not happened yet. Returns { paused, openedAt } while a pause is open; otherwise the current cycle (since the last release) and the previous
 * full cycle (the one before that pause: from the release before it to its opening), null when there is none.
 */
export function cyclesAt(holds, nowMs) {
  const list = holds.map(hold => ({ openedAt: Date.parse(hold.openedAt), releasedAt: hold.releasedAt ? Date.parse(hold.releasedAt) : null }))
    .filter(hold => Number.isFinite(hold.openedAt) && hold.openedAt <= nowMs).sort((a, b) => a.openedAt - b.openedAt)
    .map(hold => (hold.releasedAt !== null && hold.releasedAt > nowMs ? { ...hold, releasedAt: null } : hold));
  const last = list.at(-1);
  if (!last) return { state: "no-history" };
  if (last.releasedAt === null) return { state: "paused", openedAt: last.openedAt };
  const before = list.at(-2);
  return { state: "running", current: { start: last.releasedAt, end: nowMs }, previous: before?.releasedAt != null ? { start: before.releasedAt, end: last.openedAt } : null };
}

const emptyTotals = () => ({ input: 0, cached: 0, output: 0, uncachedInput: 0 });
export function sumWindow(deltas, startMs, endMs) {
  const total = emptyTotals(), bySession = new Map();
  for (const item of deltas) {
    if (item.at < startMs || item.at >= endMs) continue;
    const mine = bySession.get(item.session) ?? emptyTotals();
    for (const target of [total, mine]) { target.input += item.input; target.cached += item.cached; target.output += item.output; target.uncachedInput += item.input - item.cached; }
    bySession.set(item.session, mine);
  }
  return { total, bySession };
}

const clock = (ms, offset) => new Date(ms + offset * 60_000).toISOString().replace("T", " ").slice(5, 16);
const hoursOf = ms => (ms / HOUR).toFixed(1);
const yi = value => `${(value / GB_LABEL).toFixed(2)} 亿`;

const num = (value, digits = 2) => String(Number(value.toFixed(digits)));

/**
 * Balance readings out of the file text: one per line, "time, amount" or {"at", "balance"}. Returns the readings sorted by time and the lines that could not
 * be read (with their line numbers) — a line is never guessed.
 */
export function parseBalances(text) {
  const readings = [], problems = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let at, balance;
    if (line.startsWith("{")) { try { const record = JSON.parse(line); at = Date.parse(record.at); balance = typeof record.balance === "number" ? record.balance : Number.NaN; } catch { at = Number.NaN; } }
    else { const match = /^(\S+?)\s*[,\t ]\s*(-?\d+(?:\.\d+)?)$/.exec(line); if (match) { at = Date.parse(match[1]); balance = Number(match[2]); } }
    if (!Number.isFinite(at) || !Number.isFinite(balance) || balance < 0) { problems.push(`余额读数第 ${index + 1} 行读不出（要写成“时刻, 金额”），这一行没有算`); return; }
    readings.push({ at, balance });
  });
  readings.sort((a, b) => a.at - b.at);
  return { readings, problems };
}

/**
 * What the balance readings say at `nowMs`: the balance now (the last reading, with its age), the pace per hour, and how long it lasts. The pace only uses the
 * readings from the last top-up (a reading higher than the one before) and, of those, the last `rateWindowHours` before the last reading. One reading, or a
 * pace of 0 or less, each say so instead of a number. Readings after `nowMs` are ignored.
 */
export function balanceForecast({ readings, nowMs, config }) {
  const list = readings.filter(item => item.at <= nowMs);
  if (!list.length) return { state: "none" };
  const last = list.at(-1), ageHours = (nowMs - last.at) / HOUR;
  let from = 0;
  for (let index = 1; index < list.length; index += 1) if (list[index].balance > list[index - 1].balance) from = index;
  const sinceTopUp = list.slice(from);
  const windowStart = last.at - config.rateWindowHours * HOUR;
  const used = sinceTopUp.filter(item => item.at >= windowStart);
  const base = { state: "balance", balance: last.balance, readingAt: new Date(last.at).toISOString(), ageHours: Number(ageHours.toFixed(2)), toppedUpAt: from > 0 ? new Date(list[from].at).toISOString() : null, flags: [] };
  if (ageHours >= config.staleHours) base.flags.push("stale");
  if (used.length < 2) return { ...base, rate: null, reason: sinceTopUp.length < 2 ? "one-reading" : "one-in-window" };
  const first = used[0], spanHours = (last.at - first.at) / HOUR, perHour = (first.balance - last.balance) / spanHours;
  base.paceWindowHours = Number(spanHours.toFixed(2));
  if (!(perHour > 0)) return { ...base, rate: null, reason: "not-dropping", perHour };
  const hoursLeft = last.balance / perHour;
  const result = { ...base, rate: perHour, perHour, hoursLeft: Number(hoursLeft.toFixed(2)), runsOutAt: new Date(last.at + hoursLeft * HOUR).toISOString() };
  if (hoursLeft < config.lowHours) result.flags.push("low");
  return result;
}

const ageText = hours => (hours < 1 / 6 ? "刚刚" : hours < 1 ? `${Math.round(hours * 60)} 分钟前` : `${num(hours, 1)} 小时前`);

/**
 * The reading at `nowMs`. `deltas` are { at, session, input, cached, output }; `balances` are { at, balance } readings. With a balance reading the
 * conclusion is the balance, the pace and how long it lasts; without one it reports the usage since the release and says it cannot estimate. A pause that is
 * open says "暂停中" and does not estimate. There is no percentage of a previous cycle and no "over quota" any more.
 */
export function reading({ deltas, holds, balances = [], nowMs, config }) {
  const offset = config.utcOffsetMinutes ?? 0, unit = config.balanceUnit ?? "元";
  const cycles = cyclesAt(holds, nowMs);
  const base = { at: new Date(nowMs).toISOString(), flags: [] };
  const forecast = balanceForecast({ readings: balances, nowMs, config });
  const balanceLine = item => `余额 ${num(item.balance)} ${unit}（${clock(Date.parse(item.readingAt), offset)} 读数，${ageText(item.ageHours)}）`;
  if (cycles.state === "paused") {
    const since = new Date(cycles.openedAt).toISOString();
    const tail = forecast.state === "balance" ? `；最后一次余额读数：${balanceLine(forecast)}` : "";
    return { ...base, state: "paused", pausedSince: since, balance: forecast.state === "balance" ? forecast : undefined, line: `暂停中：提供方自 ${clock(cycles.openedAt, offset)} 起处于暂停，没有放行，不做估计${tail}` };
  }
  const current = cycles.state === "running" ? cycles.current : null;
  const used = current ? sumWindow(deltas, current.start, current.end) : null;
  const result = { ...base, balance: forecast.state === "balance" ? forecast : undefined, current: current ? { start: new Date(current.start).toISOString(), hours: Number(hoursOf(current.end - current.start)), totals: used.total, bySession: Object.fromEntries(used.bySession) } : undefined };
  if (forecast.state === "balance") {
    result.flags = forecast.flags;
    const aged = forecast.flags.includes("stale") ? `；读数已有 ${num(forecast.ageHours, 1)} 小时没更新，数字可能过时` : "";
    if (forecast.rate === null) {
      const why = { "one-reading": "只有一条读数，算不出每小时掉多少，也就无法估计还能撑多久", "one-in-window": `最近 ${config.rateWindowHours} 小时内只有一条读数，算不出每小时掉多少`, "not-dropping": "最近读数没有下降，无法估计还能撑多久" }[forecast.reason];
      return { ...result, state: "balance-only", line: `${balanceLine(forecast)}；${why}${forecast.toppedUpAt ? "（刚充值，按充值后的读数算）" : ""}${aged}` };
    }
    const low = forecast.flags.includes("low") ? `；不足 ${config.lowHours} 小时，请提醒` : "";
    return { ...result, state: "ok", line: `${balanceLine(forecast)}，最近 ${num(forecast.paceWindowHours, 1)} 小时每小时掉 ${num(forecast.perHour)} ${unit}，照这个速度还能撑约 ${num(forecast.hoursLeft, 1)} 小时（约 ${clock(Date.parse(forecast.runsOutAt), offset)}）${low}${aged}` };
  }
  if (!current) return { ...result, state: "no-balance", line: "没有余额读数，无法估计还能撑多久；也没有任何提供方暂停/放行记录，不知道用量从哪里算起" };
  return { ...result, state: "no-balance", line: `没有余额读数，无法估计还能撑多久。放行 ${hoursOf(current.end - current.start)} 小时，已用输入 ${yi(used.total.input)}` };
}

export function formatReading(result, config, extra = {}) {
  const lines = [];
  if (extra.problems?.length) lines.push(`⚠ 读数不完整：${extra.problems.join("；")}。下面的数字只含读到的部分。`);
  lines.push(result.line);
  if (result.current) {
    const t = result.current.totals;
    lines.push("", `放行以来的用量（自 ${result.current.start}，${result.current.hours} 小时）：输入 ${yi(t.input)}，其中未命中缓存 ${yi(t.uncachedInput)}，输出 ${yi(t.output)}`);
    const sessions = Object.entries(result.current.bySession).sort((a, b) => b[1].input - a[1].input);
    if (sessions.length) { lines.push("", "分 Session（输入 / 未命中缓存 / 输出）："); for (const [name, s] of sessions) lines.push(`  ${name}：${yi(s.input)} / ${yi(s.uncachedInput)} / ${yi(s.output)}`); }
  }
  if (result.flags.includes("low")) lines.push("", `提醒：余额照现在的速度撑不到 ${config.lowHours} 小时`);
  return lines.join("\n");
}

/** Every native record (rollout-*-<thread id>.jsonl) modified since `sinceMs`: { path, thread } and the problems of the ones that could not be listed. */
export async function listRollouts(root, sinceMs, problems = []) {
  const files = [];
  const walk = async dir => {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { problems.push(`目录读不了（${basename(dir)}：${error.code ?? error.message}）`); return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const match = /^rollout-.*-([0-9a-f]{8})-[0-9a-f-]{27}\.jsonl$/.exec(entry.name);
      if (!match) continue;
      try { if ((await stat(path)).mtimeMs >= sinceMs) files.push({ path, thread: match[1] }); } catch (error) { problems.push(`记录读不了（${entry.name}：${error.code ?? error.message}），只有这一个文件没有算`); }
    }
  };
  await walk(root);
  return files;
}

export async function readDeltas(files, problems = [], label = thread => thread) {
  const deltas = [];
  for (const file of files) {
    try {
      const lines = [];
      for await (const line of createInterface({ input: createReadStream(file.path, { encoding: "utf8" }), crlfDelay: Infinity })) if (line.includes('"token_count"')) lines.push(line);
      for (const item of tokenDeltas(lines)) deltas.push({ ...item, session: label(file.thread) });
    } catch (error) { problems.push(`记录读不了（${basename(file.path)}：${error.code ?? error.message}），只有这一个文件没有算`); }
  }
  return deltas;
}

async function databaseFacts(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: config.databaseUrl, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    const holds = (await client.query("SELECT opened_at, released_at FROM runtime_provider_hold WHERE project_id=$1 AND provider=$2 ORDER BY opened_at", [config.projectId, config.provider])).rows
      .map(row => ({ openedAt: row.opened_at.toISOString(), releasedAt: row.released_at ? row.released_at.toISOString() : null }));
    const sessions = (await client.query("SELECT session_id::text AS id, role_id::text AS role, native_thread_id AS thread FROM runtime_session WHERE project_id=$1 AND runtime_provider=$2", [config.projectId, config.provider])).rows;
    return { holds, labels: Object.fromEntries(sessions.filter(row => row.thread).map(row => [String(row.thread).slice(0, 8), `${row.id.slice(0, 8)}（角色 ${row.role.slice(0, 8)}）`])) };
  } finally { await client.end(); }
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values } = parseArgs({ options: { now: { type: "string" }, json: { type: "boolean", default: false }, config: { type: "string" }, balances: { type: "string" } } });
  const path = values.config ?? process.env.EVOLOOP_QUOTA_CONFIG;
  if (!path) { console.error("usage: quota-reading.mjs [--now ISO] [--json] [--balances PATH]   (EVOLOOP_QUOTA_CONFIG = absolute path of the private config; EVOLOOP_QUOTA_BALANCES = balance readings file)"); process.exit(2); }
  try {
    const config = loadConfig(await readFile(path, "utf8"), resolve(path));
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new Error("--now must be an ISO time");
    const problems = [];
    const facts = config.databaseUrl && config.projectId ? await databaseFacts(config) : { holds: config.holds, labels: {} };
    const labels = { ...facts.labels, ...(config.sessionLabels ?? {}) };
    const cycles = cyclesAt(facts.holds, nowMs);
    const since = cycles.state === "running" ? cycles.current.start : nowMs;
    const files = await listRollouts(config.codexSessionsRoot, since, problems);
    const deltas = await readDeltas(files, problems, thread => labels[thread] ?? `${thread}（未登记）`);
    const balancePath = values.balances ?? process.env.EVOLOOP_QUOTA_BALANCES ?? config.balanceReadings;
    let balances = [];
    if (balancePath) {
      checkBalancePath(balancePath);
      let text = null;
      try { text = await readFile(balancePath, "utf8"); } catch (error) { if (error.code !== "ENOENT") problems.push(`余额读数文件读不了（${error.code ?? error.message}）`); }
      if (text !== null) { const parsed = parseBalances(text); balances = parsed.readings; problems.push(...parsed.problems); }
    }
    const result = reading({ deltas, holds: facts.holds, balances, nowMs, config });
    console.log(values.json ? JSON.stringify({ ...result, problems }, null, 2) : formatReading(result, config, { problems }));
    process.exit(problems.length ? 2 : 0);
  } catch (error) { console.error(error.message); process.exit(1); }
}
