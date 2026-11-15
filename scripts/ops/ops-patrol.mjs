#!/usr/bin/env node
// The disk patrol that does not depend on the 12-hour routine Task: it reclaims (scripts/ops/disk-reclaim.mjs), looks at the recent
// occurrences of the watched schedules for skipped ones, and tells the Leader Session when free space is below the threshold or an occurrence
// was skipped. A scheduler of the host (or a schedule of its own, whose open Task cannot be the routine's) runs it; a skipped routine
// occurrence or a low-space reading is then no longer only a line in a log or in a report nobody gets.
//   ops-patrol.mjs [--execute] [--json]      EVOLOOP_DISK_CONFIG points at the private config (see disk-reclaim.mjs); its `patrol` object holds:
//     cli (absolute path of the agent CLI), projectId, leaderSessionKey (as `work send` takes it), watchSchedules (schedule ids),
//     stateFile (absolute path outside the repository: what was already told), alertIntervalMinutes (default 360), skipLookbackHours (default 48),
//     messagePrefix (optional text put before the message, e.g. to mark a test).
// Read-only except what disk-reclaim does with --execute and the one `work send` message; the message carries counts, ids and times only.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatReport, loadConfig, makeAdapters, reclaim, within, repoRoot } from "./disk-reclaim.mjs";

const HOUR = 3600_000, MINUTE = 60_000, GB = 1024 ** 3;

export function loadPatrol(config, path) {
  const patrol = config.patrol;
  if (!patrol || typeof patrol !== "object") throw new Error("config.patrol is required (cli, projectId, leaderSessionKey, watchSchedules, stateFile)");
  for (const key of ["cli", "stateFile"]) if (typeof patrol[key] !== "string" || !isAbsolute(patrol[key]) || within(patrol[key], repoRoot)) throw new Error(`config.patrol.${key} must be an absolute path outside the repository`);
  for (const key of ["projectId", "leaderSessionKey"]) if (typeof patrol[key] !== "string" || !patrol[key]) throw new Error(`config.patrol.${key} is required`);
  if (!Array.isArray(patrol.watchSchedules)) throw new Error("config.patrol.watchSchedules must be a list of schedule ids");
  return { alertIntervalMinutes: 360, skipLookbackHours: 48, ...patrol, path };
}

/** Occurrences the schedule skipped (or never turned into a Task) inside the look-back window, as { scheduleId, plannedAtUtc, reason, operationId }. */
export function skippedOccurrences(scheduleId, occurrences, nowMs, lookbackHours) {
  return (Array.isArray(occurrences) ? occurrences : [])
    .filter(item => item?.state === "skipped" && Date.parse(item.plannedAtUtc) >= nowMs - lookbackHours * HOUR)
    .map(item => ({ scheduleId, plannedAtUtc: item.plannedAtUtc, reason: item.reason ?? null, operationId: item.operationId ?? null }));
}

/**
 * What to tell the Leader now. `state` = { lastAlertAt, toldOccurrences: [operationId], lastLow }. Told when there is a skipped occurrence not told before,
 * or when space is low and the last low-space message is older than the interval (or space was not low last time).
 */
export function alertDecision({ lowSpace, skipped, state, nowMs, intervalMinutes }) {
  const told = new Set(state?.toldOccurrences ?? []);
  const fresh = skipped.filter(item => !item.operationId || !told.has(item.operationId));
  const last = Date.parse(state?.lastAlertAt);
  const lowDue = lowSpace && (!state?.lastLow || !Number.isFinite(last) || nowMs - last >= intervalMinutes * MINUTE);
  return { send: fresh.length > 0 || lowDue, fresh, lowDue };
}

export function alertText({ report, fresh, lowDue, generatedAt }) {
  const gb = bytes => `${(bytes / GB).toFixed(1)} GB`;
  const lines = [`【磁盘与日程巡检告警】${generatedAt}`];
  if (lowDue) lines.push(`可用空间 ${gb(report.freeBytes)},低于阈值 ${gb(report.minFreeBytes)}(本次回收前 ${gb(report.freeBytesBefore ?? report.freeBytes)})。需要 Leader 处理:脚本能回收的已回收,其余需要加盘、清理其他项目缓存或停用不需要的工作区。`);
  if (fresh.length) {
    lines.push(`有 ${fresh.length} 个日程时刻被跳过(没有生成 Task):`);
    for (const item of fresh) lines.push(`- 日程 ${item.scheduleId.slice(0, 8)} 计划 ${item.plannedAtUtc} 的时刻:${item.reason ?? "原因未写"}(操作 ${String(item.operationId ?? "").slice(0, 8)})`);
    lines.push("原因通常是上一轮的 Task 还没结束。巡检与回收不再依赖那个日程,但被跳过的例行优化仍需有人决定怎样收口。");
  }
  return lines.join("\n");
}

/** Reads the occurrences of each watched schedule through the agent CLI; a failure is returned, never swallowed. */
export function readOccurrences(patrol, exec = execFileSync) {
  const result = { skipped: [], problems: [] };
  for (const id of patrol.watchSchedules) {
    try {
      const out = exec(patrol.cli, ["read", "schedule", id, "--project", patrol.projectId, "--occurrences"], { encoding: "utf8", maxBuffer: 32 << 20 });
      result.skipped.push(...skippedOccurrences(id, JSON.parse(out), patrol.nowMs ?? Date.now(), patrol.skipLookbackHours));
    } catch (error) { result.problems.push(`读日程 ${id.slice(0, 8)} 的时刻失败(${String(error.status ?? error.message).split("\n")[0].slice(0, 80)}):这个日程有没有被跳过无法确认`); }
  }
  return result;
}

/** Sends the message to the Leader Session and returns what the CLI said; throws when it did not go. */
export function sendAlert(patrol, text, exec = execFileSync) {
  return exec(patrol.cli, ["work", "send", patrol.leaderSessionKey, "--project", patrol.projectId, "--stdin"], { encoding: "utf8", input: text, maxBuffer: 32 << 20 });
}

const readState = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };

export async function patrolOnce({ config, patrol, adapter, execute, now = Date.now(), exec = execFileSync, write = writeFileSync, read = readState, reclaimFn = reclaim }) {
  const report = await reclaimFn({ adapter, config, execute, now, log: () => {} });
  const occurrences = readOccurrences({ ...patrol, nowMs: now }, exec);
  const state = read(patrol.stateFile);
  const decision = alertDecision({ lowSpace: report.lowSpace, skipped: occurrences.skipped, state, nowMs: now, intervalMinutes: patrol.alertIntervalMinutes });
  const problems = [...occurrences.problems];
  let sent = null;
  if (decision.send) {
    const generatedAt = new Date(now).toISOString();
    try {
      sent = sendAlert(patrol, `${patrol.messagePrefix ?? ""}${alertText({ report, fresh: decision.fresh, lowDue: decision.lowDue, generatedAt })}`, exec).trim().slice(0, 400);
      write(patrol.stateFile, JSON.stringify({ lastAlertAt: decision.lowDue ? generatedAt : (state.lastAlertAt ?? generatedAt), lastLow: report.lowSpace ? (decision.lowDue || state.lastLow === true) : false, toldOccurrences: [...new Set([...(state.toldOccurrences ?? []), ...decision.fresh.map(item => item.operationId).filter(Boolean)])].slice(-200) }));
    } catch (error) { problems.push(`发给 Leader 的告警没有送出(${String(error.message).split("\n")[0].slice(0, 100)}):下次巡检会再试`); }
  } else if (!report.lowSpace && state.lastLow) write(patrol.stateFile, JSON.stringify({ ...state, lastLow: false }));
  return { report, skipped: occurrences.skipped, decision, sent, problems, lastAlertAt: state.lastAlertAt ?? null };
}

export const exitCodeFor = result => (result.problems.length || result.report.failed.length ? 1 : result.report.lowSpace ? 3 : 0);

/** What the alert line says, from the actual state: sent now, not sent because it was told recently, or nothing to tell because space is fine. Never "normal" while space is low. */
export function statusText(result) {
  const gb = bytes => `${(bytes / GB).toFixed(1)} GB`;
  const { report, decision, skipped } = result;
  const state = report.lowSpace ? `空间仍低于阈值(${gb(report.freeBytes)} < ${gb(report.minFreeBytes)})` : `空间正常(${gb(report.freeBytes)} ≥ ${gb(report.minFreeBytes)})`;
  if (decision.send) return `已发给 Leader(${result.sent ?? "送出失败"});${state}`;
  const told = skipped.length ? `;回看窗口内 ${skipped.length} 个被跳过的时刻都已告知过` : ";没有新的被跳过的时刻";
  return report.lowSpace ? `本次不重复发送:${state},上一次告警在 ${result.lastAlertAt ?? "之前"},未满重复间隔${told}` : `本次不需要:${state}${told}`;
}

export function formatPatrol(result) {
  const lines = [];
  if (result.problems.length) lines.push(`⚠ 巡检不完整或告警未送出:${result.problems.join(";")}`, "");
  lines.push(`日程被跳过的时刻(回看窗口内):${result.skipped.length ? result.skipped.map(item => `${item.scheduleId.slice(0, 8)}@${item.plannedAtUtc}`).join("、") : "无"}`);
  lines.push(`告警:${statusText(result)}`, "");
  lines.push(formatReport(result.report));
  return lines.join("\n");
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values } = parseArgs({ options: { execute: { type: "boolean", default: false }, json: { type: "boolean", default: false }, config: { type: "string" } } });
  const path = values.config ?? process.env.EVOLOOP_DISK_CONFIG;
  if (!path) { console.error("usage: ops-patrol.mjs [--execute] [--json]   (EVOLOOP_DISK_CONFIG = private config with a `patrol` object)"); process.exit(2); }
  try {
    const text = readFileSync(path, "utf8");
    const config = loadConfig(text, resolve(path));
    const patrol = loadPatrol(JSON.parse(text), resolve(path));
    const result = await patrolOnce({ config, patrol, adapter: makeAdapters(config), execute: values.execute });
    console.log(values.json ? JSON.stringify(result, null, 2) : formatPatrol(result));
    process.exit(exitCodeFor(result));
  } catch (error) { console.error(error.message); process.exit(1); }
}
