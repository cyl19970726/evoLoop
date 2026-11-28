#!/usr/bin/env node
// 分工账：按职责汇总一段时间里的承接、交付、验收结果、占用和花费，并标出需要处理的项。
// 它回答“现在的分工合不合理、每个职责的效果和效率怎样”，供复盘的每日 BP 和 Leader 的每日评估读取（DEC-056、PROP-012）。
// 只读：在 READ ONLY 事务里只跑 SELECT/WITH；不写数据库，不改任何 Task、Role 或 Session。口径见 docs/development/scheduling-metrics.md。
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { MetricsError, TIMEZONE, assertReadOnlySql, completeDayWindows, dayWindow, overlapSeconds } from "./scheduling-metrics.mjs";

const DAY_MS = 86_400_000;
const fail = (code, message) => { throw new MetricsError(code, message); };
const ms = value => value === null || value === undefined ? null : new Date(value).getTime();
const round = (value, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

export const UNCLASSIFIED = "未归类";
export const TEMPORARY = "临时专项";
export const DEFAULT_THRESHOLDS = Object.freeze({ idleDays: 3, reworkRate: 0.3, reworkMinObserved: 5 });

/**
 * 一个 Session 属于哪个职责。Role 绑定运行时（DEC-035），所以同一职责会分在几个 Role 里，验收又挂在开发 Role 下；
 * 这里按项目已有的显示名约定“职责 · 实例”归类，显式对照表优先。
 */
export function dutyOf(session, map = {}) {
  const explicit = map.sessions?.[session.session_id] ?? map.roles?.[session.role_id];
  if (explicit) return explicit;
  if (session.tenure === "temporary") return TEMPORARY;
  const name = String(session.display_name ?? "").trim();
  const separator = name.indexOf(" · ");
  if (separator > 0) return name.slice(0, separator).trim();
  return roleDuty({ role_id: session.role_id, title: session.role_title }, map);
}

/** 没有显示名时按 Role 标题归类：去掉末尾标运行时的括号，例如“功能开发（Codex）”归到“功能开发”。 */
export function roleDuty(role, map = {}) {
  const explicit = map.roles?.[role.role_id];
  if (explicit) return explicit;
  const title = String(role.title ?? "").replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim();
  return title || UNCLASSIFIED;
}

function dedupe(rows, key) {
  const seen = new Map();
  for (const row of rows) if (!seen.has(row[key])) seen.set(row[key], row);
  return [...seen.values()];
}

/** Session 在这段时间里存在的区间；已关闭的以核实关闭时间为准，没有就用最后更新时间。 */
function presence(session, period) {
  const start = Math.max(ms(session.created_at), ms(period.start));
  const closedAt = session.state === "closed" ? ms(session.close_verified_at) ?? ms(session.updated_at) : null;
  const end = Math.min(closedAt ?? ms(period.end), ms(period.end));
  return end > start ? { start, end } : null;
}

export function flagsFor(row, thresholds = DEFAULT_THRESHOLDS) {
  const flags = [];
  const overdue = row.roles.filter(role => role.overdue);
  if (overdue.length)
    flags.push({ code: "TRIAL_OVERDUE", message: `试行到期未回看：${overdue.map(role => `${role.title}（${role.reviewAt.slice(0, 10)}）`).join("、")}` });
  if (row.sessions.neverRan.length)
    flags.push({ code: "NEVER_RAN", message: `就绪但从未跑过 Run：${row.sessions.neverRan.map(item => item.name).join("、")}` });
  if (row.sessions.idle.length)
    flags.push({ code: "IDLE", message: `连续 ${thresholds.idleDays} 天以上没有 Run，建议收回或合并：${row.sessions.idle.map(item => `${item.name}（${item.idleDays} 天）`).join("、")}` });
  if (row.observed >= thresholds.reworkMinObserved && row.rejectRate !== null && row.rejectRate >= thresholds.reworkRate)
    flags.push({ code: "REWORK", message: `打回率 ${Math.round(row.rejectRate * 100)}%（${row.rejected}/${row.observed}），先查方法和输入，不先加人` });
  return flags;
}

export function buildLedger({ projectId, period, data, map = {}, thresholds = DEFAULT_THRESHOLDS, generatedAt = new Date().toISOString() }) {
  const periodStart = ms(period.start);
  const periodEnd = ms(period.end);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) fail("INVALID_RANGE", "period end must be after start");
  const inPeriod = value => { const at = ms(value); return at !== null && at >= periodStart && at < periodEnd; };
  const dates = new Set(period.dates ?? []);

  const sessions = dedupe(data.sessions ?? [], "session_id").filter(session => ms(session.created_at) < periodEnd);
  const sessionDuty = new Map(sessions.map(session => [session.session_id, dutyOf(session, map)]));
  const label = session => String(session.display_name ?? "").trim() || `${String(session.session_id).slice(0, 8)}（无显示名）`;

  const runsBySession = new Map();
  for (const run of data.runs ?? []) {
    if (!sessionDuty.has(run.session_id) || ms(run.created_at) >= periodEnd) continue;
    if (!runsBySession.has(run.session_id)) runsBySession.set(run.session_id, []);
    runsBySession.get(run.session_id).push(run);
  }
  const runSession = new Map((data.runs ?? []).map(run => [run.run_id, run.session_id]));
  // 每个 Session 到这段时间结束为止的 Run 总数和最后一次 Run：有聚合结果就用它，没有（如测试）就从 runs 推出。
  const runTotals = new Map();
  if (data.runTotals) {
    for (const total of data.runTotals) runTotals.set(total.session_id, { count: Number(total.total_runs ?? 0), lastRunAt: ms(total.last_run_at) });
  } else {
    for (const [sessionId, runs] of runsBySession)
      runTotals.set(sessionId, { count: runs.length, lastRunAt: runs.reduce((latest, run) => Math.max(latest, ms(run.updated_at) ?? ms(run.created_at) ?? 0), 0) || null });
  }

  const observationsByDelivery = new Map();
  for (const observation of data.observations ?? []) {
    if (!observation.delivery_id) continue;
    if (!observationsByDelivery.has(observation.delivery_id)) observationsByDelivery.set(observation.delivery_id, new Set());
    observationsByDelivery.get(observation.delivery_id).add(observation.result);
  }

  const costBySession = new Map();
  for (const usage of data.usage ?? []) {
    if (!dates.has(String(usage.day))) continue;
    // cost_usd 是已记到的下限：cost_reported=false 表示至少有一笔记账没有报费用，runs_only 表示费用只含 Run（迁移 112 之前的行）。
    const entry = costBySession.get(usage.session_id) ?? { usd: 0, complete: true };
    entry.usd += Number(usage.cost_usd ?? 0);
    if (!usage.cost_reported || (usage.cost_scope ?? "all_turns") !== "all_turns") entry.complete = false;
    costBySession.set(usage.session_id, entry);
  }

  const rows = new Map();
  const rowFor = duty => {
    if (!rows.has(duty)) rows.set(duty, {
      duty, sessions: { existed: 0, ready: 0, active: 0, neverRan: [], idle: [] }, runs: 0, taskIds: new Set(),
      runSeconds: 0, availableSeconds: 0, deliveries: 0, observed: 0, accepted: 0, rejected: 0, pending: 0,
      cost: { usd: 0, known: false, partialSessions: [], unreportedSessions: [] }, lastRunAt: null, roles: [],
    });
    return rows.get(duty);
  };

  for (const session of sessions) {
    const row = rowFor(sessionDuty.get(session.session_id));
    const runs = runsBySession.get(session.session_id) ?? [];
    const present = presence(session, period);
    if (present) { row.sessions.existed += 1; row.availableSeconds += (present.end - present.start) / 1000; }
    const ready = session.state === "ready";
    if (ready) row.sessions.ready += 1;
    const periodRuns = runs.filter(run => inPeriod(run.created_at));
    if (periodRuns.length) row.sessions.active += 1;
    row.runs += periodRuns.length;
    for (const run of periodRuns) if (run.task_id) row.taskIds.add(run.task_id);
    row.runSeconds += overlapSeconds({ start: period.start, end: period.end }, runs.map(run => ({ start: run.created_at, end: run.updated_at })));
    const totals = runTotals.get(session.session_id) ?? { count: 0, lastRunAt: null };
    const lastRunAt = totals.lastRunAt;
    if (lastRunAt && (row.lastRunAt === null || lastRunAt > row.lastRunAt)) row.lastRunAt = lastRunAt;
    if (ready && !totals.count) row.sessions.neverRan.push({ sessionId: session.session_id, name: label(session) });
    else if (ready && lastRunAt) {
      const idleDays = Math.floor((periodEnd - Math.min(lastRunAt, periodEnd)) / DAY_MS);
      if (idleDays >= thresholds.idleDays) row.sessions.idle.push({ sessionId: session.session_id, name: label(session), lastRunAt: new Date(lastRunAt).toISOString(), idleDays });
    }
    const cost = costBySession.get(session.session_id);
    const recorded = cost && (cost.usd > 0 || cost.complete);
    if (recorded) { row.cost.usd += cost.usd; row.cost.known = true; }
    if (recorded && !cost.complete) row.cost.partialSessions.push(label(session));
    if (!recorded && periodRuns.length) row.cost.unreportedSessions.push(label(session));
  }

  let unattributedDeliveries = 0;
  for (const delivery of data.deliveries ?? []) {
    if (!inPeriod(delivery.created_at)) continue;
    const duty = sessionDuty.get(delivery.session_id ?? runSession.get(delivery.run_id));
    if (!duty) { unattributedDeliveries += 1; continue; }
    const row = rowFor(duty);
    const results = observationsByDelivery.get(delivery.delivery_id);
    row.deliveries += 1;
    if (!results) { row.pending += 1; continue; }
    row.observed += 1;
    if (results.has("used")) row.accepted += 1;
    if (results.has("notUsed") || results.has("failed")) row.rejected += 1;
  }

  const roles = dedupe(data.roles ?? [], "role_id");
  for (const role of roles) {
    const reviewAt = role.review_at_utc ? new Date(role.review_at_utc).toISOString() : null;
    const entry = { roleId: role.role_id, title: role.title || UNCLASSIFIED, roleClass: role.role_class || null, state: role.state,
      reviewAt, reviewed: Boolean(role.reviewed),
      overdue: role.state === "trial" && reviewAt !== null && ms(reviewAt) < periodEnd && !role.reviewed };
    const duties = new Set(sessions.filter(session => session.role_id === role.role_id).map(session => sessionDuty.get(session.session_id)));
    duties.delete(TEMPORARY);
    if (!duties.size) duties.add(roleDuty(role, map));
    for (const duty of duties) rowFor(duty).roles.push(entry);
  }

  const duties = [...rows.values()].map(row => {
    const out = {
      duty: row.duty, sessions: row.sessions, runs: row.runs, tasks: row.taskIds.size,
      runHours: round(row.runSeconds / 3600, 1),
      busyShare: row.availableSeconds > 0 ? round(row.runSeconds / row.availableSeconds, 3) : null,
      deliveries: row.deliveries, observed: row.observed, accepted: row.accepted, rejected: row.rejected, pending: row.pending,
      rejectRate: row.observed ? round(row.rejected / row.observed, 3) : null,
      cost: { usd: row.cost.known ? round(row.cost.usd, 2) : null, partialSessions: row.cost.partialSessions, unreportedSessions: row.cost.unreportedSessions },
      costPerAccepted: row.cost.known && row.accepted && !row.cost.partialSessions.length && !row.cost.unreportedSessions.length
        ? round(row.cost.usd / row.accepted, 2) : null,
      lastRunAt: row.lastRunAt ? new Date(row.lastRunAt).toISOString() : null,
      idleDays: row.lastRunAt ? Math.floor((periodEnd - Math.min(row.lastRunAt, periodEnd)) / DAY_MS) : null,
      roles: row.roles,
    };
    out.flags = flagsFor(out, thresholds);
    return out;
  }).filter(row => row.sessions.ready > 0 || row.runs > 0 || row.deliveries > 0 || row.flags.length > 0)
    .sort((left, right) => right.runs - left.runs || left.duty.localeCompare(right.duty, "zh"));

  const sum = key => duties.reduce((total, row) => total + row[key], 0);
  const knownCost = duties.filter(row => row.cost.usd !== null);
  return {
    kind: "duty-ledger", projectId, generatedAt, timezone: TIMEZONE, readOnly: true,
    period: { start: period.start, end: period.end, dates: [...dates] }, thresholds,
    totals: {
      duties: duties.length, sessionsReady: duties.reduce((total, row) => total + row.sessions.ready, 0),
      sessionsActive: duties.reduce((total, row) => total + row.sessions.active, 0),
      runs: sum("runs"), deliveries: sum("deliveries"), observed: sum("observed"), accepted: sum("accepted"), rejected: sum("rejected"),
      costUsd: knownCost.length ? round(knownCost.reduce((total, row) => total + row.cost.usd, 0), 2) : null,
      unattributedDeliveries,
      rolesOverdue: dedupe(duties.flatMap(row => row.roles.filter(role => role.overdue)), "roleId").length,
    },
    duties,
  };
}

const dash = "—";
const percent = value => value === null ? dash : `${Math.round(value * 100)}%`;
const money = value => value === null ? dash : value.toFixed(2);

export function renderMarkdown(ledger) {
  const first = ledger.period.dates[0] ?? "?";
  const last = ledger.period.dates.at(-1) ?? "?";
  const lines = [`# 分工账（${first}${last === first ? "" : ` 至 ${last}`}）`, ""];
  lines.push(`时区：${ledger.timezone}；生成时间：${ledger.generatedAt}；项目：\`${ledger.projectId}\`；只读：是。`, "");
  lines.push(`合计：${ledger.totals.duties} 个职责，就绪会话 ${ledger.totals.sessionsReady} 个，这段时间跑过 Run 的会话 ${ledger.totals.sessionsActive} 个；Run ${ledger.totals.runs} 个，交付 ${ledger.totals.deliveries} 份（被接受 ${ledger.totals.accepted}，打回 ${ledger.totals.rejected}）；已记花费 ${money(ledger.totals.costUsd)} 美元；到期未回看的试行 Role ${ledger.totals.rolesOverdue} 个。`, "");
  lines.push("| 职责 | 就绪会话 | 跑过的 | Run | 任务 | 交付 | 被接受 | 打回 | 打回率 | 忙碌占比 | 距上次 Run | 花费（美元） | 每件被接受 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of ledger.duties)
    lines.push(`| ${row.duty} | ${row.sessions.ready} | ${row.sessions.active} | ${row.runs} | ${row.tasks} | ${row.deliveries} | ${row.accepted} | ${row.rejected} | ${percent(row.rejectRate)} | ${percent(row.busyShare)} | ${row.idleDays === null ? "从未" : `${row.idleDays} 天`} | ${money(row.cost.usd)}${row.cost.partialSessions.length || row.cost.unreportedSessions.length ? "＊" : ""} | ${money(row.costPerAccepted)} |`);
  lines.push("", "## 需要处理", "");
  const flagged = ledger.duties.filter(row => row.flags.length);
  if (!flagged.length) lines.push("没有越线的项。");
  for (const row of flagged) for (const flag of row.flags) lines.push(`- **${row.duty}**：${flag.message}。`);
  const costGaps = ledger.duties.filter(row => row.cost.partialSessions.length || row.cost.unreportedSessions.length);
  if (costGaps.length) {
    lines.push("", "## 花费记到什么程度", "");
    for (const row of costGaps) {
      const parts = [];
      if (row.cost.partialSessions.length) parts.push(`只记了一部分：${row.cost.partialSessions.join("、")}`);
      if (row.cost.unreportedSessions.length) parts.push(`运行时没有报费用：${row.cost.unreportedSessions.join("、")}`);
      lines.push(`- **${row.duty}**：${parts.join("；")}。`);
    }
  }
  lines.push("", "## 口径", "");
  lines.push("- 职责按会话显示名“职责 · 实例”归类，没有显示名的按 Role 标题去掉运行时括号归类；可用 `--duty-map` 指定。");
  lines.push("- 就绪会话是读取时仍为就绪状态的会话；忙碌占比是 Run 时长除以会话在这段时间里存在的时长，是近似值。");
  lines.push("- 被接受指交付有一条“已使用”的观察；打回指有“未使用”或“失败”的观察；打回率的分母是已有观察的交付。");
  lines.push("- 这张表按 Run 和交付计产出。主要产出是观察的职责（如验收）和不走 Run 的工作（如 Leader 的消息轮次）会被低估。");
  lines.push("- 花费是账本里已记到的下限。带＊的职责有会话只记了一部分（费用只含 Run，或有记账没有报费用）或运行时不报费用，这时不算每件被接受的花费。");
  lines.push(`- 越线规则是初值：连续 ${ledger.thresholds.idleDays} 天没有 Run；打回率不低于 ${Math.round(ledger.thresholds.reworkRate * 100)}% 且已有观察的交付不少于 ${ledger.thresholds.reworkMinObserved} 份。它们只提示该看哪里，不代替判断。`);
  if (ledger.totals.unattributedDeliveries) lines.push(`- 另有 ${ledger.totals.unattributedDeliveries} 份交付没有对应的 Run，没有计入任何职责。`);
  return `${lines.join("\n")}\n`;
}

export function renderText(ledger) {
  const lines = [`分工账 ${ledger.period.dates[0] ?? "?"}..${ledger.period.dates.at(-1) ?? "?"} (${ledger.timezone})`];
  for (const row of ledger.duties)
    lines.push(`${row.duty}: 就绪 ${row.sessions.ready}，Run ${row.runs}，交付 ${row.deliveries}（接受 ${row.accepted}／打回 ${row.rejected}），忙碌 ${percent(row.busyShare)}，花费 ${money(row.cost.usd)}${row.flags.length ? `；${row.flags.map(flag => flag.code).join(",")}` : ""}`);
  return `${lines.join("\n")}\n`;
}

// 每条查询的参数：project 只带项目；range 带这段时间的起止时刻；until 只带结束时刻；days 带起止日期。只读取这段时间需要的行，账本变大也不会全表读取。
export const LEDGER_QUERIES = {
  sessions: { params: "project", sql: `SELECT s.session_id,s.role_id,s.state,s.created_at,s.updated_at,s.close_verified_at,
      COALESCE(s.observed_model,s.model) AS model,s.runtime_provider,
      COALESCE(rr.proposal->>'title','') AS role_title,sp.display_name,sp.membership,sp.tenure
    FROM runtime_session s
    LEFT JOIN role_definition rd ON rd.project_id=s.project_id AND rd.role_id::text=s.role_id
    LEFT JOIN role_revision rr ON rr.project_id=rd.project_id AND rr.revision_id=rd.current_revision_id
    LEFT JOIN session_profile sp ON sp.project_id=s.project_id AND sp.target_id=s.session_id
    WHERE s.project_id=$1 ORDER BY s.created_at` },
  roles: { params: "project", sql: `SELECT rd.role_id,rd.state,rd.review_at_utc,
      COALESCE(rr.proposal->>'title','') AS title,COALESCE(rr.proposal->>'roleClass','') AS role_class,
      EXISTS (SELECT 1 FROM role_trial_review tr WHERE tr.project_id=rd.project_id AND tr.role_id=rd.role_id) AS reviewed
    FROM role_definition rd
    LEFT JOIN role_revision rr ON rr.project_id=rd.project_id AND rr.revision_id=rd.current_revision_id
    WHERE rd.project_id=$1 ORDER BY rd.created_at_utc` },
  runs: { params: "range", sql: `SELECT run_id,task_id,session_id,created_at,updated_at FROM runtime_run
    WHERE project_id=$1 AND created_at < $3 AND updated_at >= $2 ORDER BY created_at` },
  runTotals: { params: "until", sql: `SELECT session_id,count(*)::int AS total_runs,max(updated_at) AS last_run_at FROM runtime_run
    WHERE project_id=$1 AND created_at < $2 GROUP BY session_id` },
  deliveries: { params: "range", sql: `SELECT d.delivery_id,d.run_id,d.created_at,r.session_id FROM delivery d
    LEFT JOIN runtime_run r ON r.project_id=d.project_id AND r.run_id=d.run_id
    WHERE d.project_id=$1 AND d.created_at >= $2 AND d.created_at < $3` },
  observations: { params: "range", sql: `SELECT o.delivery_id,o.result FROM consumer_observation o
    JOIN delivery d ON d.project_id=o.project_id AND d.delivery_id=o.delivery_id
    WHERE o.project_id=$1 AND d.created_at >= $2 AND d.created_at < $3` },
  usage: { params: "days", sql: `SELECT session_id,day::text AS day,cost_usd,cost_reported,cost_scope FROM session_usage_daily
    WHERE project_id=$1 AND day >= $2::date AND day <= $3::date` },
};

export async function collectLedgerData(databaseUrl, projectId, period) {
  const paramsFor = { project: [projectId], range: [projectId, period.start, period.end], until: [projectId, period.end], days: [projectId, period.dates[0], period.dates.at(-1)] };
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 30_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const data = {};
    for (const [key, { sql, params }] of Object.entries(LEDGER_QUERIES)) {
      assertReadOnlySql(sql);
      data[key] = (await client.query(sql, paramsFor[params])).rows.map(row => key === "sessions" || key === "roles"
        ? { ...row, session_id: row.session_id && String(row.session_id), role_id: row.role_id && String(row.role_id) } : row);
    }
    await client.query("COMMIT");
    return data;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

function help() {
  return `Usage:
  EVOLOOP_METRICS_DATABASE_URL=postgres://... node scripts/duty-ledger.mjs --project UUID [options]

Options:
  --days N             Number of complete days in the period (default 7)
  --end YYYY-MM-DD     Last complete day in ${TIMEZONE} (default yesterday)
  --start YYYY-MM-DD   First day; overrides --days
  --format text|json|markdown  Output format (default markdown)
  --out FILE           Write the JSON ledger to FILE
  --markdown-out FILE  Write the markdown ledger to FILE
  --duty-map FILE      JSON {"sessions":{"SESSION_ID":"职责"},"roles":{"ROLE_ID":"职责"}} overriding the naming convention
  --idle-days N        Flag ready sessions with no Run for N days (default ${DEFAULT_THRESHOLDS.idleDays})
  --rework-rate R      Flag duties whose reject rate is at least R, 0..1 (default ${DEFAULT_THRESHOLDS.reworkRate})
  --database-url URL   Overrides EVOLOOP_METRICS_DATABASE_URL
  --help               Show this help
`;
}

export function periodFrom({ now = new Date(), days = 7, start = null, end = null } = {}) {
  let windows;
  if (start) {
    const first = dayWindow(start);
    const last = dayWindow(end ?? start);
    if (ms(first.startUtc) > ms(last.startUtc)) fail("INVALID_RANGE", "--start must not be after --end");
    const count = Math.round((ms(last.startUtc) - ms(first.startUtc)) / DAY_MS) + 1;
    windows = completeDayWindows(now, count, last.date);
  } else {
    windows = completeDayWindows(now, days, end);
  }
  return { start: windows[0].startUtc, end: windows.at(-1).endUtc, dates: windows.map(window => window.date) };
}

async function main() {
  const { values } = parseArgs({ allowPositionals: false, options: {
    project: { type: "string" }, "database-url": { type: "string" }, days: { type: "string" }, end: { type: "string" },
    start: { type: "string" }, format: { type: "string" }, out: { type: "string" }, "markdown-out": { type: "string" },
    "duty-map": { type: "string" }, "idle-days": { type: "string" }, "rework-rate": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(help()); return; }
  const projectId = values.project ?? process.env.EVOLOOP_PROJECT;
  if (!projectId) fail("PROJECT_REQUIRED", "--project is required");
  const databaseUrl = values["database-url"] ?? process.env.EVOLOOP_METRICS_DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL_REQUIRED", "set EVOLOOP_METRICS_DATABASE_URL or pass --database-url");
  const thresholds = { ...DEFAULT_THRESHOLDS };
  if (values["idle-days"] !== undefined) {
    thresholds.idleDays = Number(values["idle-days"]);
    if (!Number.isSafeInteger(thresholds.idleDays) || thresholds.idleDays < 1) fail("INVALID_THRESHOLD", "--idle-days must be a positive integer");
  }
  if (values["rework-rate"] !== undefined) {
    thresholds.reworkRate = Number(values["rework-rate"]);
    if (!(thresholds.reworkRate > 0 && thresholds.reworkRate <= 1)) fail("INVALID_THRESHOLD", "--rework-rate must be within (0, 1]");
  }
  const period = periodFrom({ days: values.days ? Number(values.days) : 7, start: values.start ?? null, end: values.end ?? null });
  const map = values["duty-map"] ? JSON.parse(readFileSync(values["duty-map"], "utf8")) : {};
  const data = await collectLedgerData(databaseUrl, projectId, period);
  const ledger = buildLedger({ projectId, period, data, map, thresholds });
  if (values.out) writeFileSync(values.out, `${JSON.stringify(ledger, null, 2)}\n`);
  if (values["markdown-out"]) writeFileSync(values["markdown-out"], renderMarkdown(ledger));
  const format = values.format ?? "markdown";
  if (format === "json") process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  else if (format === "text") process.stdout.write(renderText(ledger));
  else process.stdout.write(renderMarkdown(ledger));
}

if (process.argv[1]?.endsWith("duty-ledger.mjs")) {
  main().catch(error => {
    const code = error?.code ?? "LEDGER_FAILED";
    process.stderr.write(`${JSON.stringify({ error: { code, message: error?.message ?? String(error) } })}\n`);
    process.exitCode = 2;
  });
}
