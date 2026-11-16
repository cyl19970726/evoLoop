#!/usr/bin/env node
// Quota reading: how much of the previous full cycle has been used since the provider pause was last released, and when the quota runs out at the
// current pace. Read only: it reads the Codex Sessions' native records (timestamped cumulative token counts, so hourly granularity), and the provider
// pause history (database in a read-only transaction, or a list in the config). It reads no bill, calls no provider API, writes nothing and sends nothing.
//   quota-reading.mjs [--now ISO] [--json] [--config PATH]        config: EVOLOOP_QUOTA_CONFIG (an absolute path outside the repository)
// Config (JSON): { codexSessionsRoot (abs), provider ("codex"), utcOffsetMinutes (for the clock times printed), databaseUrl + projectId (pause history and
//   Session names) | holds: [{ openedAt, releasedAt|null }], windowHours (2), warnAt ([0.6, 0.8]), weights ({input, uncachedInput, output}, default input only),
//   recharge: { amount, unitPrice: { uncachedInput, cachedInput, output } per million tokens } (then the quota is that amount, no previous cycle needed),
//   sessionLabels: { "<8 characters of the thread id>": "label" } }.
import { createReadStream, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOUR = 3_600_000, GB_LABEL = 1e8;
export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function loadConfig(text, path) {
  const real = (() => { try { return realpathSync(path); } catch { return resolve(path); } })();
  if (!isAbsolute(path) || real.startsWith(repoRoot + sep)) throw new Error("Quota config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  if (typeof config.codexSessionsRoot !== "string" || !isAbsolute(config.codexSessionsRoot)) throw new Error("config.codexSessionsRoot must be an absolute path");
  if (!Number.isInteger(config.utcOffsetMinutes ?? 0)) throw new Error("config.utcOffsetMinutes must be a whole number of minutes");
  const hasDb = config.databaseUrl && config.projectId;
  if (!hasDb && !Array.isArray(config.holds)) throw new Error("config needs databaseUrl + projectId (pause history from the database) or holds: [{ openedAt, releasedAt }]");
  const weights = { input: 1, uncachedInput: 0, output: 0, ...(config.weights ?? {}) };
  for (const [key, value] of Object.entries(weights)) if (!Number.isFinite(value) || value < 0) throw new Error(`config.weights.${key} must be a number, 0 or more`);
  if (Object.values(weights).every(value => value === 0)) throw new Error("config.weights must weigh at least one kind of token");
  const windowHours = config.windowHours ?? 2;
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("config.windowHours must be a positive number");
  const warnAt = config.warnAt ?? [0.6, 0.8];
  if (!Array.isArray(warnAt) || warnAt.some(value => !(value > 0))) throw new Error("config.warnAt must be a list of ratios above 0");
  if (config.recharge) {
    const { amount, unitPrice } = config.recharge;
    if (!(amount > 0) || !unitPrice || ["uncachedInput", "cachedInput", "output"].some(key => !(unitPrice[key] >= 0))) throw new Error("config.recharge needs amount > 0 and unitPrice.{uncachedInput, cachedInput, output} per million tokens");
  }
  return { provider: "codex", ...config, weights, windowHours, warnAt: [...warnAt].sort((a, b) => a - b) };
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

const weighted = (totals, weights) => weights.input * totals.input + weights.uncachedInput * totals.uncachedInput + weights.output * totals.output;
const cost = (totals, recharge) => (totals.uncachedInput * recharge.unitPrice.uncachedInput + totals.cached * recharge.unitPrice.cachedInput + totals.output * recharge.unitPrice.output) / 1e6;
const pct = ratio => `${Math.round(ratio * 100)}%`;
const clock = (ms, offset) => new Date(ms + offset * 60_000).toISOString().replace("T", " ").slice(5, 16);
const hoursOf = ms => (ms / HOUR).toFixed(1);
const yi = value => `${(value / GB_LABEL).toFixed(2)} 亿`;

/**
 * The reading at `nowMs`. `deltas` are { at, session, input, cached, output }. The quota is the previous full cycle's weighted usage, or the recharge amount
 * when the config gives one. Never a number out of nothing: no history, a pause that is open, no previous cycle, or no pace each say so instead.
 */
export function reading({ deltas, holds, nowMs, config }) {
  const offset = config.utcOffsetMinutes ?? 0, weights = config.weights, windowMs = config.windowHours * HOUR;
  const cycles = cyclesAt(holds, nowMs);
  const base = { at: new Date(nowMs).toISOString(), warnAt: config.warnAt, flags: [] };
  if (cycles.state === "no-history") return { ...base, state: "no-estimate", line: "无法估计：没有任何提供方暂停/放行记录，不知道周期从哪里算起" };
  if (cycles.state === "paused") return { ...base, state: "paused", pausedSince: new Date(cycles.openedAt).toISOString(), line: `暂停中：提供方自 ${clock(cycles.openedAt, offset)} 起处于暂停，没有放行，不做估计` };
  const { current, previous } = cycles;
  const used = sumWindow(deltas, current.start, current.end);
  const prior = previous ? sumWindow(deltas, previous.start, previous.end).total : null;
  const result = { ...base, state: "ok", current: { start: new Date(current.start).toISOString(), hours: Number(hoursOf(current.end - current.start)), totals: used.total, bySession: Object.fromEntries(used.bySession) },
    previous: previous ? { start: new Date(previous.start).toISOString(), end: new Date(previous.end).toISOString(), hours: Number(hoursOf(previous.end - previous.start)), totals: prior } : null };
  const heading = `放行 ${hoursOf(current.end - current.start)} 小时`;
  const byMoney = Boolean(config.recharge);
  if (!byMoney && !previous) return { ...result, state: "no-estimate", line: `无法估计：${heading}，已用输入 ${yi(used.total.input)}，但没有上一个完整周期可比（至少要有两次放行记录）` };
  const capacity = byMoney ? config.recharge.amount : weighted(prior, weights);
  const usedValue = byMoney ? cost(used.total, config.recharge) : weighted(used.total, weights);
  if (!(capacity > 0)) return { ...result, state: "no-estimate", line: `无法估计：${heading}，上一个完整周期按当前权重的用量是 0，没有可比的额度` };
  const ratio = usedValue / capacity;
  result.percent = byMoney ? { amount: ratio } : { input: prior.input ? used.total.input / prior.input : null, uncachedInput: prior.uncachedInput ? used.total.uncachedInput / prior.uncachedInput : null, output: prior.output ? used.total.output / prior.output : null, weighted: ratio };
  result.basis = byMoney ? "充值金额" : "上一个完整周期";
  result.flags = config.warnAt.filter(level => ratio >= level);
  const mark = result.flags.length ? `（已过 ${result.flags.map(pct).join("、")} 线）` : "";
  // pace of the last windowHours (or of the whole cycle if it is younger)
  const from = Math.max(current.start, nowMs - windowMs);
  const recent = byMoney ? cost(sumWindow(deltas, from, nowMs).total, config.recharge) : weighted(sumWindow(deltas, from, nowMs).total, weights);
  const perHour = recent / ((nowMs - from) / HOUR);
  result.paceWindowHours = Number(hoursOf(nowMs - from));
  const what = byMoney ? `充值金额的 ${pct(ratio)}` : `上个周期的 ${pct(ratio)}`;
  if (ratio >= 1) return { ...result, line: `${heading}，已用${what}${mark}，已超过额度，随时可能暂停` };
  if (!(perHour > 0)) return { ...result, line: `${heading}，已用${what}${mark}，最近 ${hoursOf(nowMs - from)} 小时几乎没有用量，无法估计用完时间` };
  const etaMs = nowMs + ((capacity - usedValue) / perHour) * HOUR;
  result.eta = new Date(etaMs).toISOString();
  result.etaHoursFromNow = Number(hoursOf(etaMs - nowMs));
  return { ...result, line: `${heading}，已用${what}${mark}，照现在的速度约 ${clock(etaMs, offset)} 用完` };
}

export function formatReading(result, config, extra = {}) {
  const lines = [];
  if (extra.problems?.length) lines.push(`⚠ 读数不完整：${extra.problems.join("；")}。下面的数字只含读到的部分。`);
  lines.push(result.line);
  if (result.current) {
    const t = result.current.totals;
    lines.push("", `当前周期（自 ${result.current.start}，${result.current.hours} 小时）：输入 ${yi(t.input)}，其中未命中缓存 ${yi(t.uncachedInput)}，输出 ${yi(t.output)}`);
    if (result.previous) {
      const p = result.previous.totals;
      lines.push(`上一个完整周期（${result.previous.start} 至 ${result.previous.end}，${result.previous.hours} 小时）：输入 ${yi(p.input)}，未命中缓存 ${yi(p.uncachedInput)}，输出 ${yi(p.output)}`);
    }
    if (result.percent && !result.percent.amount) lines.push(`相当于上个周期的：输入 ${result.percent.input === null ? "-" : pct(result.percent.input)}，未命中缓存 ${result.percent.uncachedInput === null ? "-" : pct(result.percent.uncachedInput)}，输出 ${result.percent.output === null ? "-" : pct(result.percent.output)}；按权重（输入 ${config.weights.input}、未命中缓存 ${config.weights.uncachedInput}、输出 ${config.weights.output}）合计 ${pct(result.percent.weighted)}`);
    if (result.percent?.amount !== undefined) lines.push(`按充值金额算：${pct(result.percent.amount)}`);
    if (result.eta) lines.push(`按最近 ${result.paceWindowHours} 小时的速度，预计 ${result.eta}（本地 ${clock(Date.parse(result.eta), config.utcOffsetMinutes ?? 0)}，还有 ${result.etaHoursFromNow} 小时）用完`);
    const sessions = Object.entries(result.current.bySession).sort((a, b) => b[1].input - a[1].input);
    if (sessions.length) { lines.push("", "分 Session（输入 / 未命中缓存 / 输出）："); for (const [name, s] of sessions) lines.push(`  ${name}：${yi(s.input)} / ${yi(s.uncachedInput)} / ${yi(s.output)}`); }
    if (result.flags.length) lines.push("", `提醒线：${result.flags.map(pct).join("、")} 已过`);
  }
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
  const { values } = parseArgs({ options: { now: { type: "string" }, json: { type: "boolean", default: false }, config: { type: "string" } } });
  const path = values.config ?? process.env.EVOLOOP_QUOTA_CONFIG;
  if (!path) { console.error("usage: quota-reading.mjs [--now ISO] [--json]   (EVOLOOP_QUOTA_CONFIG = absolute path of the private config)"); process.exit(2); }
  try {
    const config = loadConfig(await readFile(path, "utf8"), resolve(path));
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new Error("--now must be an ISO time");
    const problems = [];
    const facts = config.databaseUrl && config.projectId ? await databaseFacts(config) : { holds: config.holds, labels: {} };
    const labels = { ...facts.labels, ...(config.sessionLabels ?? {}) };
    const cycles = cyclesAt(facts.holds, nowMs);
    const since = cycles.state === "running" ? (cycles.previous?.start ?? cycles.current.start) : nowMs;
    const files = await listRollouts(config.codexSessionsRoot, since, problems);
    const deltas = await readDeltas(files, problems, thread => labels[thread] ?? `${thread}（未登记）`);
    const result = reading({ deltas, holds: facts.holds, nowMs, config });
    console.log(values.json ? JSON.stringify({ ...result, problems }, null, 2) : formatReading(result, config, { problems }));
    process.exit(problems.length ? 2 : 0);
  } catch (error) { console.error(error.message); process.exit(1); }
}
