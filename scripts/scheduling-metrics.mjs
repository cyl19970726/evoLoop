#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

export const TIMEZONE = "Asia/Tashkent";
const TASHKENT_OFFSET = "+05:00";
const DAY_MS = 86_400_000;

export class MetricsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "MetricsError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new MetricsError(code, message); };
const timestamp = value => value === null || value === undefined ? null : new Date(value).getTime();
const seconds = (from, to) => timestamp(to) === null || timestamp(from) === null ? null : (timestamp(to) - timestamp(from)) / 1000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 1) => value === null || value === undefined ? null : Number(value.toFixed(digits));

function tashkentDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayWindow(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) fail("INVALID_DATE", `invalid date: ${date}`);
  const start = new Date(`${date}T00:00:00${TASHKENT_OFFSET}`);
  if (Number.isNaN(start.getTime())) fail("INVALID_DATE", `invalid date: ${date}`);
  return { date, startUtc: start.toISOString(), endUtc: new Date(start.getTime() + DAY_MS).toISOString() };
}

export function completeDayWindows(now, count = 3, endDate = null) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 31) fail("INVALID_DAYS", "days must be between 1 and 31");
  const last = endDate ?? tashkentDate(new Date(timestamp(now) - DAY_MS));
  const end = new Date(`${last}T00:00:00${TASHKENT_OFFSET}`);
  if (Number.isNaN(end.getTime())) fail("INVALID_DATE", `invalid date: ${last}`);
  const windows = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = tashkentDate(end.getTime() - offset * DAY_MS);
    windows.push(dayWindow(date));
  }
  return windows;
}

export function percentile(values, ratio) {
  const clean = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
  if (!clean.length) return null;
  const position = (clean.length - 1) * clamp(ratio, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower);
}

export function summary(values) {
  const clean = values.filter(value => Number.isFinite(value));
  return {
    count: clean.length,
    median: round(percentile(clean, 0.5), 1),
    p90: round(percentile(clean, 0.9), 1),
    max: clean.length ? round(Math.max(...clean), 1) : null,
  };
}

export function mergeIntervals(intervals) {
  const ordered = intervals
    .map(interval => ({ start: timestamp(interval.start), end: timestamp(interval.end) }))
    .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export function intervalSeconds(intervals) {
  return mergeIntervals(intervals).reduce((total, interval) => total + (interval.end - interval.start) / 1000, 0);
}

export function overlapSeconds(interval, intervals) {
  const start = timestamp(interval.start);
  const end = timestamp(interval.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let total = 0;
  for (const other of mergeIntervals(intervals)) {
    const overlapStart = Math.max(start, other.start);
    const overlapEnd = Math.min(end, other.end);
    if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 1000;
  }
  return total;
}

export function subtractIntervals(base, exclusions) {
  const blocked = mergeIntervals(exclusions);
  let pieces = mergeIntervals(base);
  for (const interval of blocked) {
    const next = [];
    for (const piece of pieces) {
      if (interval.end <= piece.start || interval.start >= piece.end) { next.push(piece); continue; }
      if (interval.start > piece.start) next.push({ start: piece.start, end: interval.start });
      if (interval.end < piece.end) next.push({ start: interval.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

export function assertReadOnlySql(sql) {
  const normalized = String(sql).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) fail("SQL_NOT_READ_ONLY", "metrics only runs SELECT/WITH queries");
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|copy|vacuum|analyze|refresh)\b/.test(normalized))
    fail("SQL_NOT_READ_ONLY", "metrics only runs SELECT/WITH queries");
  return normalized;
}

export function parseRolloutLines(lines) {
  const turns = [];
  const calls = [];
  const compactions = [];
  let current = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === "compacted") compactions.push(record.timestamp);
    if (record?.type !== "event_msg") continue;
    const payload = record.payload ?? {};
    if (payload.type === "task_started") {
      current = {
        turnId: payload.turn_id ?? payload.turn_attribution?.turn_id ?? null,
        startedAt: record.timestamp,
        completedAt: null,
        calls: [],
      };
      if (current.turnId) turns.push(current);
      else current = null;
    } else if (payload.type === "token_count") {
      const usage = payload.info?.last_token_usage;
      if (!usage) continue;
      const call = {
        at: record.timestamp,
        inputTokens: Number(usage.input_tokens) || 0,
        cachedInputTokens: Number(usage.cached_input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
      };
      calls.push(call);
      if (current) current.calls.push(call);
    } else if (payload.type === "task_complete" && current) {
      current.completedAt = record.timestamp;
      current = null;
    }
  }
  return { turns, calls, compactions };
}

export function readRollout(paths) {
  const merged = { turns: [], calls: [], compactions: [] };
  for (const path of paths) {
    const parsed = parseRolloutLines(readFileSync(path, "utf8").split("\n"));
    merged.turns.push(...parsed.turns);
    merged.calls.push(...parsed.calls);
    merged.compactions.push(...parsed.compactions);
  }
  const seen = new Set();
  merged.turns = merged.turns.filter(turn => !seen.has(turn.turnId) && seen.add(turn.turnId));
  return merged;
}

export function summarizeRollout(parsed, window) {
  const start = timestamp(window.startUtc);
  const end = timestamp(window.endUtc);
  const turns = parsed.turns.filter(turn => timestamp(turn.startedAt) >= start && timestamp(turn.startedAt) < end);
  const calls = parsed.calls.filter(call => timestamp(call.at) >= start && timestamp(call.at) < end);
  const contexts = turns.map(turn => Math.max(0, ...turn.calls.map(call => call.inputTokens))).filter(value => value > 0);
  return {
    turns: turns.length,
    turnsWithUsage: contexts.length,
    inputTokens: calls.reduce((total, call) => total + call.inputTokens, 0),
    cachedInputTokens: calls.reduce((total, call) => total + call.cachedInputTokens, 0),
    outputTokens: calls.reduce((total, call) => total + call.outputTokens, 0),
    calls: calls.length,
    medianContextTokens: round(percentile(contexts, 0.5), 0),
    p90ContextTokens: round(percentile(contexts, 0.9), 0),
    medianCallInputTokens: round(percentile(calls.map(call => call.inputTokens), 0.5), 0),
    compactions: parsed.compactions.filter(value => timestamp(value) >= start && timestamp(value) < end).length,
  };
}

export function findRolloutFiles(root, threadIds) {
  const wanted = new Set(threadIds.filter(Boolean));
  if (!wanted.size) return [];
  const found = [];
  const walk = directory => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if ([...wanted].some(id => entry.name.includes(id))) found.push(path);
    }
  };
  walk(root);
  return found;
}

function recoveryIntervals(decisions, gates, runs, processings, window) {
  const windowStart = timestamp(window.startUtc);
  const windowEnd = timestamp(window.endUtc);
  const runById = new Map(runs.map(run => [run.run_id, run]));
  const processingByMessage = new Map(processings.map(item => [item.message_id, item]));
  const intervals = [];
  for (const decision of decisions) {
    let causeAt = null;
    if (decision.source_run_id) causeAt = timestamp(runById.get(decision.source_run_id)?.updated_at);
    if (causeAt === null && decision.cause_id) causeAt = timestamp(processingByMessage.get(decision.cause_id)?.updated_at);
    const end = timestamp(decision.created_at);
    if (Number.isFinite(causeAt) && Number.isFinite(end) && end > causeAt)
      intervals.push({ sessionId: decision.session_id, start: new Date(causeAt).toISOString(), end: decision.created_at,
        source: "recovery_decision", decisionId: decision.decision_id });
  }
  for (const gate of gates.filter(item => item.phase !== "open")) {
    const start = timestamp(gate.updated_at);
    const end = timestamp(window.endUtc);
    if (Number.isFinite(start) && end > start)
      intervals.push({ sessionId: gate.session_id, start: new Date(start).toISOString(), end: window.endUtc,
        source: "gate_current", phase: gate.phase, reason: gate.reason });
  }
  const grouped = new Map();
  for (const item of intervals)
    grouped.set(item.sessionId, [...(grouped.get(item.sessionId) ?? []), item]);
  return [...grouped.entries()].flatMap(([sessionId, items]) =>
    mergeIntervals(items)
      .map(interval => ({ sessionId, start: Math.max(interval.start, windowStart), end: Math.min(interval.end, windowEnd) }))
      .filter(interval => interval.end > interval.start));
}

function normalizeDowntime(input) {
  const items = Array.isArray(input) ? input : input?.intervals ?? [];
  return items.map(item => {
    const start = timestamp(item.start ?? item.from);
    const end = timestamp(item.end ?? item.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      fail("INVALID_DOWNTIME", "downtime intervals need start/end or from/to");
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), reason: item.reason ?? null };
  });
}

function noticeRows(rows) {
  const byNotice = new Map();
  for (const row of rows) {
    const existing = byNotice.get(row.notice_id);
    if (!existing) { byNotice.set(row.notice_id, { ...row }); continue; }
    if (existing.processing_started_at === null && row.processing_started_at !== null)
      existing.processing_started_at = row.processing_started_at;
    if (existing.direct_input_created_at === null && row.direct_input_created_at !== null)
      existing.direct_input_created_at = row.direct_input_created_at;
  }
  return [...byNotice.values()];
}

export function summarizeNotices(rows, window, exclusions = []) {
  const items = noticeRows(rows).map(row => {
    const occurred = row.occurred_at;
    const queued = row.message_created_at;
    const turn = row.processing_started_at;
    const steer = row.direct_input_created_at;
    const rawQueue = seconds(occurred, queued);
    const rawTurn = seconds(occurred, turn);
    const rawSteer = seconds(occurred, steer);
    const queueExcluded = rawQueue === null ? 0 : overlapSeconds({ start: occurred, end: queued }, exclusions);
    const turnExcluded = rawTurn === null ? 0 : overlapSeconds({ start: occurred, end: turn }, exclusions);
    const steerExcluded = rawSteer === null ? 0 : overlapSeconds({ start: occurred, end: steer }, exclusions);
    return {
      noticeId: row.notice_id, kind: row.kind, state: row.state, occurredAt: occurred,
      messageId: row.message_id, messageCreatedAt: queued, turnStartedAt: turn, steerAt: steer,
      rawQueueSeconds: rawQueue === null ? null : round(rawQueue, 1),
      rawTurnSeconds: rawTurn === null ? null : round(rawTurn, 1),
      rawSteerSeconds: rawSteer === null ? null : round(rawSteer, 1),
      adjustedQueueSeconds: rawQueue === null ? null : round(Math.max(0, rawQueue - queueExcluded), 1),
      adjustedTurnSeconds: rawTurn === null ? null : round(Math.max(0, rawTurn - turnExcluded), 1),
      adjustedSteerSeconds: rawSteer === null ? null : round(Math.max(0, rawSteer - steerExcluded), 1),
      excludedSeconds: round(Math.max(queueExcluded, turnExcluded, steerExcluded), 1),
      pending: turn === null && steer === null,
    };
  });
  const delivered = items.filter(item => item.adjustedTurnSeconds !== null || item.adjustedSteerSeconds !== null);
  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return {
    total: items.length,
    linked: items.filter(item => item.messageCreatedAt).length,
    pending: items.filter(item => item.pending).length,
    byKind,
    toQueueSeconds: summary(items.map(item => item.adjustedQueueSeconds)),
    toNewRoundSeconds: summary(items.map(item => item.adjustedTurnSeconds)),
    toSteerSeconds: summary(items.map(item => item.adjustedSteerSeconds)),
    toQueueRawSeconds: summary(items.map(item => item.rawQueueSeconds)),
    toNewRoundRawSeconds: summary(items.map(item => item.rawTurnSeconds)),
    samples: delivered.slice(0, 20),
    items,
  };
}

export function readyToRun(runs, revisions, timing, window, exclusions = []) {
  const firstRevision = new Map();
  const inProgress = new Map();
  for (const revision of revisions) {
    const at = timestamp(revision.created_at);
    if (!firstRevision.has(revision.task_id) || at < firstRevision.get(revision.task_id))
      firstRevision.set(revision.task_id, at);
    if (revision.state === "in_progress" && (!inProgress.has(revision.task_id) || at < inProgress.get(revision.task_id)))
      inProgress.set(revision.task_id, at);
  }
  const planned = new Map(timing.map(item => [item.task_id, timestamp(item.planned_at_utc)]));
  const firstRun = new Map();
  for (const run of runs) {
    const at = timestamp(run.created_at);
    if (!firstRun.has(run.task_id) || at < firstRun.get(run.task_id)) firstRun.set(run.task_id, at);
  }
  const readyAt = taskId => {
    const started = inProgress.get(taskId) ?? firstRevision.get(taskId) ?? null;
    const scheduled = planned.get(taskId) ?? null;
    if (started === null) return scheduled;
    if (scheduled === null) return started;
    return Math.min(started, scheduled);
  };
  const start = timestamp(window.startUtc);
  const end = timestamp(window.endUtc);
  const items = runs
    .filter(run => timestamp(run.created_at) >= start && timestamp(run.created_at) < end)
    .map(run => {
      const ready = readyAt(run.task_id);
      const runAt = timestamp(run.created_at);
      const raw = ready === null ? null : (runAt - ready) / 1000;
      const excluded = ready === null ? 0 : overlapSeconds({ start: new Date(ready).toISOString(), end: run.created_at },
        exclusions.filter(item => !item.sessionId || item.sessionId === run.session_id));
      return {
        runId: run.run_id, taskId: run.task_id, sessionId: run.session_id,
        readyAt: ready === null ? null : new Date(ready).toISOString(), runAt: run.created_at,
        rawSeconds: raw === null ? null : round(raw, 1),
        excludedSeconds: round(excluded, 1),
        adjustedSeconds: raw === null ? null : round(Math.max(0, raw - excluded), 1),
        source: planned.has(run.task_id) ? "scheduled" : "leader",
      };
    });
  const bySource = {};
  for (const item of items) {
    bySource[item.source] ??= [];
    bySource[item.source].push(item.adjustedSeconds);
  }
  return {
    count: items.length,
    seconds: summary(items.map(item => item.adjustedSeconds)),
    bySource: Object.fromEntries(Object.entries(bySource).map(([key, values]) => [key, summary(values)])),
    samples: items.slice(0, 20),
    items,
  };
}

export function idleBySession({ sessions, runs, processings, tasks, revisions, window }) {
  const start = timestamp(window.startUtc);
  const end = timestamp(window.endUtc);
  const inProgress = new Map();
  const firstRevision = new Map();
  for (const revision of revisions) {
    const at = timestamp(revision.created_at);
    if (!firstRevision.has(revision.task_id) || at < firstRevision.get(revision.task_id))
      firstRevision.set(revision.task_id, at);
    if (revision.state === "in_progress" && (!inProgress.has(revision.task_id) || at < inProgress.get(revision.task_id)))
      inProgress.set(revision.task_id, at);
  }
  const firstRun = new Map();
  for (const run of runs) {
    const at = timestamp(run.created_at);
    if (!firstRun.has(run.task_id) || at < firstRun.get(run.task_id)) firstRun.set(run.task_id, at);
  }
  const roleReady = new Map();
  for (const task of tasks) {
    const ready = inProgress.get(task.task_id) ?? firstRevision.get(task.task_id);
    if (!ready || ready >= end) continue;
    const runAt = firstRun.get(task.task_id) ?? end;
    const finish = task.state === "done" || task.state === "cancelled" ? Math.min(runAt, end) : Math.min(runAt, end);
    if (finish <= Math.max(ready, start)) continue;
    roleReady.set(task.owner, [...(roleReady.get(task.owner) ?? []), { start: Math.max(ready, start), end: finish }]);
  }
  for (const [role, intervals] of roleReady) roleReady.set(role, mergeIntervals(intervals));
  const busyBySession = new Map();
  for (const run of runs) {
    const from = timestamp(run.created_at);
    const to = run.state === "running" ? end : timestamp(run.updated_at);
    const interval = { start: Math.max(from, start), end: Math.min(to, end) };
    if (interval.end > interval.start) busyBySession.set(run.session_id, [...(busyBySession.get(run.session_id) ?? []), interval]);
  }
  for (const item of processings) {
    const from = timestamp(item.started_at);
    const to = ["running", "dispatching", "unknown"].includes(item.state) ? end : timestamp(item.updated_at);
    const interval = { start: Math.max(from, start), end: Math.min(to, end) };
    if (interval.end > interval.start) busyBySession.set(item.session_id, [...(busyBySession.get(item.session_id) ?? []), interval]);
  }
  const rows = [];
  for (const session of sessions) {
    const availableStart = Math.max(start, timestamp(session.created_at));
    if (availableStart >= end) continue;
    const available = [{ start: availableStart, end }];
    const busy = mergeIntervals(busyBySession.get(session.session_id) ?? []);
    const idle = subtractIntervals(available, busy);
    const ready = roleReady.get(session.role_id) ?? [];
    rows.push({
      sessionId: session.session_id,
      roleId: session.role_id,
      roleTitle: session.role_title,
      approximate: true,
      availableSeconds: round(intervalSeconds(available), 1),
      busySeconds: round(intervalSeconds(busy), 1),
      idleSeconds: round(intervalSeconds(idle), 1),
      idleWithReadyWorkSeconds: round(idle.reduce((total, piece) => total + overlapSeconds(piece, ready), 0), 1),
      runs: runs.filter(run => run.session_id === session.session_id &&
        timestamp(run.created_at) >= start && timestamp(run.created_at) < end).length,
      messages: processings.filter(item => item.session_id === session.session_id &&
        timestamp(item.started_at) >= start && timestamp(item.started_at) < end).length,
    });
  }
  return {
    approximate: true,
    method: "runs and message processing intervals; ready work inferred from Task in_progress revisions",
    sessions: rows,
    totalIdleSeconds: round(rows.reduce((total, row) => total + row.idleSeconds, 0), 1),
    totalIdleWithReadyWorkSeconds: round(rows.reduce((total, row) => total + row.idleWithReadyWorkSeconds, 0), 1),
  };
}

export function stoppedRuns(runs, deliveries, submissions, window) {
  const start = timestamp(window.startUtc);
  const end = timestamp(window.endUtc);
  const deliveryByRun = new Map(deliveries.filter(item => item.run_id).map(item => [item.run_id, item]));
  const submissionByRun = new Map(submissions.filter(item => item.run_id).map(item => [item.run_id, item]));
  const items = runs
    .filter(run => timestamp(run.updated_at) >= start && timestamp(run.updated_at) < end)
    .filter(run => run.state === "interrupted" || run.interrupt_requested)
    .map(run => {
      const delivery = deliveryByRun.get(run.run_id) ?? null;
      const submission = submissionByRun.get(run.run_id) ?? null;
      return {
        runId: run.run_id, taskId: run.task_id, sessionId: run.session_id, state: run.state,
        interruptRequested: Boolean(run.interrupt_requested), createdAt: run.created_at,
        delivered: Boolean(delivery || submission?.delivery_id),
        deliveryId: delivery?.delivery_id ?? submission?.delivery_id ?? null,
        submissionState: submission?.state ?? null,
      };
    });
  return {
    count: items.length,
    deliveredCount: items.filter(item => item.delivered).length,
    undeliveredCount: items.filter(item => !item.delivered).length,
    samples: items,
  };
}

export function businessMessages({ messages, sessions, runs, assignments = [], window, extraLeaderActors = [] }) {
  const leaderSessions = sessions.filter(session => /Leader/i.test(session.role_title ?? ""));
  const leaderIds = new Set(leaderSessions.map(session => session.session_id));
  const leaderActors = new Set([...leaderSessions.map(session => session.actor_id).filter(Boolean), ...extraLeaderActors]);
  const start = timestamp(window.startUtc);
  const end = timestamp(window.endUtc);
  const firstRun = new Map();
  const firstAssignment = new Map();
  for (const run of runs) {
    const at = timestamp(run.created_at);
    if (!firstRun.has(run.task_id) || at < firstRun.get(run.task_id)) firstRun.set(run.task_id, at);
  }
  for (const assignment of assignments) {
    const at = timestamp(assignment.updated_at ?? assignment.ack_at);
    if (!firstAssignment.has(assignment.task_id) || at < firstAssignment.get(assignment.task_id))
      firstAssignment.set(assignment.task_id, at);
  }
  const all = messages.filter(message => timestamp(message.created_at) >= start && timestamp(message.created_at) < end);
  const candidate = all.filter(message =>
    leaderActors.has(message.sender_actor_id) && !leaderIds.has(message.session_id) && message.context_task_id);
  const workLike = candidate.filter(message =>
    /(实现|修复|返工|开发|执行|请按|开始实现|开始修复)/.test(message.content ?? "") &&
    !/(验收|接手|确认|只回报|不要开始)/.test(message.content ?? ""));
  const beforeAnyRun = candidate.filter(message => {
    const first = firstRun.get(message.context_task_id) ?? null;
    return first === null || first >= timestamp(message.created_at);
  });
  const withoutAssignment = beforeAnyRun.filter(message => {
    const assigned = firstAssignment.get(message.context_task_id) ?? null;
    return assigned === null || assigned > timestamp(message.created_at);
  });
  const details = (list, keep = list) => list.map(message => {
    const firstAt = firstRun.get(message.context_task_id) ?? null;
    return {
      messageId: message.message_id, taskId: message.context_task_id, sessionId: message.session_id,
      senderActorId: message.sender_actor_id, createdAt: message.created_at,
      content: (message.content ?? "").replace(/\s+/g, " ").slice(0, 160),
      taskHasRun: firstAt !== null,
      firstRunAt: firstAt === null ? null : new Date(firstAt).toISOString(),
      runAtOrAfterMessage: firstAt !== null && firstAt >= timestamp(message.created_at),
      assignmentBeforeMessage: (firstAssignment.get(message.context_task_id) ?? Infinity) <= timestamp(message.created_at),
    };
  });
  return {
    allLeaderMessages: all.filter(message => leaderActors.has(message.sender_actor_id)).length,
    taskContextMessages: candidate.length,
    workLikeMessages: workLike.length,
    distinctTasks: new Set(candidate.map(message => message.context_task_id)).size,
    distinctWorkLikeTasks: new Set(workLike.map(message => message.context_task_id)).size,
    messagesBeforeAnyRun: beforeAnyRun.length,
    tasksWithFirstRunAfterMessage: new Set(beforeAnyRun.map(message => message.context_task_id)).size,
    messagesBeforeAnyRunWithoutAssignment: withoutAssignment.length,
    tasksFirstRunAfterMessageWithoutAssignment: new Set(withoutAssignment.map(message => message.context_task_id)).size,
    tasksWithoutAnyRun: new Set(candidate.filter(message => !firstRun.has(message.context_task_id))
      .map(message => message.context_task_id)).size,
    samples: details(withoutAssignment.length ? withoutAssignment : beforeAnyRun.length ? beforeAnyRun : candidate).slice(0, 20),
    allSamples: details(candidate),
  };
}

function collectSamples(report, limit = 10) {
  const samples = [];
  const iso = value => value === null || value === undefined ? null : new Date(value).toISOString();
  for (const day of report.days) {
    for (const item of day.notices.samples) {
      if (samples.length >= limit) break;
      samples.push({
        kind: "notice", day: day.date, id: item.noticeId, taskId: item.kind,
        from: iso(item.occurredAt), to: iso(item.turnStartedAt ?? item.steerAt),
        rawSeconds: item.adjustedTurnSeconds === null ? item.adjustedSteerSeconds : item.adjustedTurnSeconds,
        adjustedSeconds: item.adjustedTurnSeconds === null ? item.adjustedSteerSeconds : item.adjustedTurnSeconds,
      });
    }
    for (const item of day.readyToRun.samples) {
      if (samples.length >= limit) break;
      samples.push({
        kind: "ready-to-run", day: day.date, id: item.runId, taskId: item.taskId,
        from: iso(item.readyAt), to: iso(item.runAt), rawSeconds: item.rawSeconds, adjustedSeconds: item.adjustedSeconds,
      });
    }
  }
  return samples;
}

const QUERIES = {
  sessions: `SELECT s.session_id,s.role_id,s.actor_id,s.state,s.model,s.native_thread_id,s.created_at,s.updated_at,
      COALESCE(rr.proposal->>'title','') AS role_title
    FROM runtime_session s
    LEFT JOIN role_definition rd ON rd.project_id=s.project_id AND rd.role_id::text=s.role_id
    LEFT JOIN role_revision rr ON rr.project_id=rd.project_id AND rr.revision_id=rd.current_revision_id
    WHERE s.project_id=$1 ORDER BY s.created_at`,
  runs: `SELECT run_id,task_id,session_id,state,created_at,updated_at,interrupt_requested,native_turn_id,usage,cost_usd
    FROM runtime_run WHERE project_id=$1 ORDER BY created_at`,
  tasks: `SELECT task_id,owner,state,title FROM task WHERE project_id=$1`,
  revisions: `SELECT task_id,revision_id,version,state,created_at FROM task_revision WHERE project_id=$1 ORDER BY created_at`,
  assignments: `SELECT task_id,version,state,target_kind,target_id,recipient_actor_id,ack_at,updated_at
    FROM task_session_assignment_revision WHERE project_id=$1`,
  timing: `SELECT task_id,planned_at_utc FROM task_timing WHERE project_id=$1`,
  deliveries: `SELECT delivery_id,task_id,run_id,created_at FROM delivery WHERE project_id=$1`,
  submissions: `SELECT submission_id,run_id,delivery_id,state,created_at_utc FROM ordinary_run_submission WHERE project_id=$1`,
  notices: `SELECT n.notice_id,n.kind,n.occurred_at,n.state,n.message_id,n.linked_session_id,
      sm.created_at AS message_created_at,sm.state AS message_state,
      p.processing_id,p.started_at AS processing_started_at,p.updated_at AS processing_updated_at,p.state AS processing_state,
      d.input_id AS direct_input_id,d.created_at AS direct_input_created_at
    FROM leader_result_notice n
    LEFT JOIN session_message sm ON sm.project_id=n.project_id AND sm.message_id=n.message_id
    LEFT JOIN session_message_processing p ON p.project_id=n.project_id AND p.message_id=n.message_id
    LEFT JOIN session_direct_input d ON d.project_id=n.project_id AND d.processing_id=p.processing_id
    WHERE n.project_id=$1 AND n.occurred_at >= $2 AND n.occurred_at < $3
    ORDER BY n.occurred_at`,
  messages: `SELECT sm.message_id,sm.sender_actor_id,sm.session_id,sm.context_task_id,sm.created_at,sm.state,sm.content,
      p.processing_id,p.started_at,p.updated_at AS processing_updated_at,p.state AS processing_state
    FROM session_message sm
    LEFT JOIN session_message_processing p ON p.project_id=sm.project_id AND p.message_id=sm.message_id
    WHERE sm.project_id=$1 AND sm.created_at >= $2 AND sm.created_at < $3
    ORDER BY sm.created_at`,
  processings: `SELECT processing_id,session_id,message_id,state,started_at,updated_at,native_turn_id
    FROM session_message_processing WHERE project_id=$1`,
  decisions: `SELECT decision_id,session_id,kind,cause_id,source_run_id,retry_run_id,resume_message_id,created_at
    FROM session_recovery_decision WHERE project_id=$1 ORDER BY created_at`,
  gates: `SELECT session_id,phase,cause_kind,cause_id,cause_state,reason,updated_at
    FROM session_recovery_gate WHERE project_id=$1`,
  leaderActors: `SELECT DISTINCT receiver_actor_id AS actor_id FROM leader_result_notice
    WHERE project_id=$1 AND receiver_actor_id IS NOT NULL`,
};

async function queryRows(client, sql, params) {
  assertReadOnlySql(sql);
  const result = await client.query(sql, params);
  return result.rows;
}

export async function collectDatabase(databaseUrl, projectId, range = null) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000,
    query_timeout: 30_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const data = {};
    for (const [key, sql] of Object.entries(QUERIES))
      data[key] = await queryRows(client, sql, key === "notices" || key === "messages"
        ? [projectId, range?.start ?? "1970-01-01", range?.end ?? "2100-01-01"] : [projectId]);
    const identity = await queryRows(client, "SELECT current_database() AS database, current_user AS user_name", []);
    await client.query("COMMIT");
    return { ...data, identity: identity[0] };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

export function buildReport({ projectId, windows, data, rollout, downtime, generatedAt = new Date().toISOString(), sampleLimit = 10 }) {
  const sessions = data.sessions;
  const leaderSessions = sessions.filter(session => /Leader/i.test(session.role_title ?? ""));
  const businessSessions = sessions.filter(session => !/Leader/i.test(session.role_title ?? "") && !/模拟用户/i.test(session.role_title ?? ""));
  const extraLeaderActors = new Set((data.leaderActors ?? []).map(item => item.actor_id));
  const days = windows.map(window => {
    const leaderActorIds = new Set([...leaderSessions.map(item => item.actor_id).filter(Boolean), ...extraLeaderActors]);
    const leaderSessionIds = new Set(leaderSessions.map(item => item.session_id));
    const notices = data.notices.filter(item => timestamp(item.occurred_at) >= timestamp(window.startUtc) && timestamp(item.occurred_at) < timestamp(window.endUtc));
    const recovery = recoveryIntervals(data.decisions, data.gates, data.runs, data.processings, window);
    const leaderRecovery = recovery.filter(item => leaderSessionIds.has(item.sessionId));
    const exclusions = mergeIntervals([...leaderRecovery, ...downtime]);
    const noticeSummary = summarizeNotices(notices, window, exclusions);
    const ready = readyToRun(data.runs, data.revisions, data.timing, window, [...recovery, ...downtime]);
    const stopped = stoppedRuns(data.runs, data.deliveries, data.submissions, window);
    const messages = businessMessages({ messages: data.messages, sessions, runs: data.runs, assignments: data.assignments, window,
      extraLeaderActors: [...extraLeaderActors] });
    const idle = idleBySession({ sessions: businessSessions, runs: data.runs, processings: data.processings,
      tasks: data.tasks, revisions: data.revisions, window });
    const rolloutSummary = rollout ? summarizeRollout(rollout, window) : null;
    const leaderTurnsDb = new Set(data.processings
      .filter(item => leaderSessionIds.has(item.session_id))
      .filter(item => timestamp(item.started_at) >= timestamp(window.startUtc) && timestamp(item.started_at) < timestamp(window.endUtc))
      .map(item => item.native_turn_id ?? item.processing_id)).size;
    const leaderMessages = data.messages.filter(item => leaderActorIds.has(item.sender_actor_id))
      .filter(item => timestamp(item.created_at) >= timestamp(window.startUtc) && timestamp(item.created_at) < timestamp(window.endUtc));
    return {
      date: window.date, startUtc: window.startUtc, endUtc: window.endUtc,
      coverage: {
        sessionCount: sessions.length,
        leaderSessions: leaderSessions.map(item => ({ sessionId: item.session_id, actorId: item.actor_id, threadId: item.native_thread_id })),
        firstActivityAt: data.runs.filter(run => timestamp(run.created_at) >= timestamp(window.startUtc) && timestamp(run.created_at) < timestamp(window.endUtc))
          .map(run => run.created_at).sort()[0] ?? null,
      },
      leader: {
        turns: rolloutSummary?.turns ?? null,
        turnsDb: leaderTurnsDb,
        messagesSent: leaderMessages.length,
        inputTokens: rolloutSummary?.inputTokens ?? null,
        cachedInputTokens: rolloutSummary?.cachedInputTokens ?? null,
        outputTokens: rolloutSummary?.outputTokens ?? null,
        calls: rolloutSummary?.calls ?? null,
        medianContextTokens: rolloutSummary?.medianContextTokens ?? null,
        p90ContextTokens: rolloutSummary?.p90ContextTokens ?? null,
        medianCallInputTokens: rolloutSummary?.medianCallInputTokens ?? null,
        compactions: rolloutSummary?.compactions ?? null,
      },
      notices: noticeSummary,
      readyToRun: ready,
      idle,
      stoppedRuns: stopped,
      businessMessages: messages,
      exclusions: { recovery: recovery.map(item => ({ ...item, start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() })),
        downtime, recoverySeconds: round(recovery.reduce((total, item) => total + seconds(item.start, item.end), 0), 1),
        downtimeSeconds: round(downtime.reduce((total, item) => total + seconds(item.start, item.end), 0), 1) },
    };
  });
  const report = {
    schema: "evoloop-scheduling-metrics/v1",
    generatedAt,
    projectId,
    timezone: TIMEZONE,
    readOnly: true,
    database: data.identity ?? null,
    windows,
    days,
    warnings: [],
  };
  for (const day of days) {
    if (day.notices.total && day.notices.toNewRoundSeconds.count === 0)
      report.warnings.push(`${day.date}：${day.notices.total} 条通知没有任何已送达的 Leader 回合；等待不可用，不是 0。`);
    if (day.notices.toSteerSeconds.count === 0)
      report.warnings.push(`${day.date}：没有 session_direct_input 送入记录；送入等待不可用，不是 0。`);
    if (day.readyToRun.count && day.readyToRun.seconds.count < day.readyToRun.count)
      report.warnings.push(`${day.date}：部分 Run 没有 Task in_progress 修订；这些行的就绪时间缺失。`);
    if (!downtime.length)
      report.warnings.push(`${day.date}：没有提供服务停机区间；停机排除为空。`);
  }
  report.warnings = [...new Set(report.warnings)];
  report.samples = collectSamples(report, sampleLimit);
  return report;
}

function formatSeconds(value) {
  if (value === null || value === undefined) return "—";
  if (value < 90) return `${round(value, 0)} 秒`;
  if (value < 5400) return `${round(value / 60, 1)} 分`;
  return `${round(value / 3600, 2)} 时`;
}

function formatCount(summaryValue) {
  return `${summaryValue.count} 项 · 中位 ${formatSeconds(summaryValue.median)} · p90 ${formatSeconds(summaryValue.p90)}`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 调度质量指标基线（${report.windows[0]?.date ?? "?"} 至 ${report.windows.at(-1)?.date ?? "?"}）`, "");
  lines.push(`时区：${report.timezone}；生成时间：${report.generatedAt}；项目：\`${report.projectId}\`；只读：是。`, "");
  lines.push("## 日窗口总表", "");
  lines.push("| 日期 | Leader 回合 | 输入 token | 上下文中位 | 通知 | 开新一轮中位 | 就绪→Run 中位 | 停跑 | 停跑有交付 | 普通消息 Task |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const day of report.days) {
    lines.push(`| ${day.date} | ${day.leader.turns ?? "—"} / ${day.leader.turnsDb} | ${day.leader.inputTokens ?? "—"} | ${day.leader.medianContextTokens ?? "—"} | ${day.notices.total} | ${formatSeconds(day.notices.toNewRoundSeconds.median)} | ${formatSeconds(day.readyToRun.seconds.median)} | ${day.stoppedRuns.count} | ${day.stoppedRuns.deliveredCount} | ${day.businessMessages.distinctTasks} |`);
  }
  lines.push("", "## 通知等待", "");
  for (const day of report.days) {
    lines.push(`### ${day.date}`, "");
    lines.push(`- 通知 ${day.notices.total} 条；已关联消息 ${day.notices.linked} 条；仍无回合 ${day.notices.pending} 条。`);
    lines.push(`- 到队列：${formatCount(day.notices.toQueueSeconds)}。`);
    lines.push(`- 开新一轮：${formatCount(day.notices.toNewRoundSeconds)}。`);
    lines.push(`- 送入（steer）：${formatCount(day.notices.toSteerSeconds)}。`);
    lines.push("");
  }
  lines.push("## 就绪到开 Run", "");
  for (const day of report.days) {
    lines.push(`- ${day.date}：${formatCount(day.readyToRun.seconds)}；按来源 ${Object.entries(day.readyToRun.bySource).map(([key, value]) => `${key} ${formatCount(value)}`).join("；") || "无"}。`);
  }
  lines.push("", "## Session 空转（近似）", "");
  for (const day of report.days) {
    lines.push(`### ${day.date}`, "");
    lines.push("| Session | 角色 | 空闲 | 同 Role 有就绪工作时空闲 | Run | 消息回合 |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
    for (const row of day.idle.sessions)
      lines.push(`| \`${row.sessionId.slice(0, 8)}\` | ${row.roleTitle} | ${formatSeconds(row.idleSeconds)} | ${formatSeconds(row.idleWithReadyWorkSeconds)} | ${row.runs} | ${row.messages} |`);
    lines.push("");
  }
  lines.push("## 被叫停的 Run", "");
  for (const day of report.days) {
    lines.push(`- ${day.date}：${day.stoppedRuns.count} 个；产生交付 ${day.stoppedRuns.deliveredCount} 个；无交付 ${day.stoppedRuns.undeliveredCount} 个。`);
    for (const item of day.stoppedRuns.samples)
      lines.push(`  - \`${item.runId}\` Task \`${item.taskId}\` 状态 ${item.state}，交付 ${item.delivered ? `\`${item.deliveryId}\`` : "无"}`);
  }
  lines.push("", "## 普通消息派发", "");
  for (const day of report.days) {
    lines.push(`- ${day.date}：Leader 发给业务 Session 且带 Task 的消息 ${day.businessMessages.taskContextMessages} 条，涉及 ${day.businessMessages.distinctTasks} 个 Task；在任何 Run 之前且此前没有 assignment 的 ${day.businessMessages.messagesBeforeAnyRunWithoutAssignment} 条（${day.businessMessages.tasksFirstRunAfterMessageWithoutAssignment} 个 Task）；Task 完全没有 Run 的 ${day.businessMessages.tasksWithoutAnyRun} 个；疑似实现/返工指令 ${day.businessMessages.workLikeMessages} 条。`);
  }
  lines.push("", "## 排除时段", "");
  for (const day of report.days) {
    lines.push(`- ${day.date}：恢复门 ${day.exclusions.recovery.length} 段（${formatSeconds(day.exclusions.recoverySeconds)}）；服务停机 ${day.exclusions.downtime.length} 段（${formatSeconds(day.exclusions.downtimeSeconds)}）。`);
    if (day.exclusions.recovery.length) {
      lines.push("");
      lines.push("| Session | 开始 | 结束 | 来源 |");
      lines.push("| --- | --- | --- | --- |");
      for (const item of day.exclusions.recovery)
        lines.push(`| \`${item.sessionId.slice(0, 8)}\` | ${new Date(item.start).toISOString()} | ${new Date(item.end).toISOString()} | ${item.source ?? "recovery"} |`);
      lines.push("");
    }
  }
  lines.push("", "## 抽查样本（最多 10 条）", "");
  lines.push("| # | 类型 | ID | 起点 | 终点 | 调整后等待 |");
  lines.push("| ---: | --- | --- | --- | --- | ---: |");
  report.samples.forEach((sample, index) => {
    lines.push(`| ${index + 1} | ${sample.kind} | \`${sample.id}\` | ${sample.from ?? "—"} | ${sample.to ?? "—"} | ${formatSeconds(sample.adjustedSeconds)} |`);
  });
  lines.push("", "## 方法说明与缺口", "");
  lines.push("- 日窗口按 Asia/Tashkent（UTC+05:00）固定 00:00 至次日 00:00，UTC 边界为前一日 19:00Z 至当日 19:00Z。");
  lines.push("- 通知等待按 `leader_result_notice.occurred_at` 到关联消息创建、发送回合开始、或 `session_direct_input` 创建计算；当前没有 steer 行时明确列为不可用，不按 0 计。");
  lines.push("- 就绪到开 Run 以 Task 首次 `in_progress` 修订（定时 Task 取计划时间与修订时间的较早者）到 `runtime_run.created_at` 计算。");
  lines.push("- Session 空转用 Run 与消息回合区间近似；同 Role 就绪工作按 Task 首次 `in_progress` 到首个 Run（或窗口末）近似，事件流上线后应替换。");
  lines.push("- 恢复门关闭由恢复决定与其失败原因回溯近似；服务停机只认 `--downtime-file`，没有文件时明确为空，不把静默当成停机。");
  lines.push("- 普通消息派发用 Leader 发给业务 Session 且带 `context_task_id` 的消息与 Task 首个 Run、首个 assignment 对照；“在任何 Run 之前发出且此前没有 assignment”才是绕过正式安排的主要候选；关键词只作辅助，保留候选样本供复核。");
  for (const warning of report.warnings) lines.push(`- 缺口：${warning}`);
  return `${lines.join("\n")}\n`;
}

export function renderText(report) {
  const lines = [];
  lines.push(`调度质量指标 ${report.windows[0]?.date} → ${report.windows.at(-1)?.date} (${report.timezone})`);
  for (const day of report.days) {
    lines.push("");
    lines.push(`[${day.date}] Leader 回合 ${day.leader.turns ?? "—"}（消息回合 ${day.leader.turnsDb}）；输入 token ${day.leader.inputTokens ?? "—"}；上下文中位 ${day.leader.medianContextTokens ?? "—"}`);
    lines.push(`  通知 ${day.notices.total}（开新一轮 ${formatCount(day.notices.toNewRoundSeconds)}；送入 ${formatCount(day.notices.toSteerSeconds)}）`);
    lines.push(`  就绪→Run ${formatCount(day.readyToRun.seconds)}；空转 ${formatSeconds(day.idle.totalIdleSeconds)}，同 Role 有就绪工作 ${formatSeconds(day.idle.totalIdleWithReadyWorkSeconds)}`);
    lines.push(`  停跑 ${day.stoppedRuns.count}，有交付 ${day.stoppedRuns.deliveredCount}；普通消息 Task ${day.businessMessages.distinctTasks}（无 assignment 且 Run 前 ${day.businessMessages.messagesBeforeAnyRunWithoutAssignment} 条）`);
    lines.push(`  排除：恢复门 ${formatSeconds(day.exclusions.recoverySeconds)}，停机 ${formatSeconds(day.exclusions.downtimeSeconds)}`);
  }
  lines.push("");
  lines.push(`抽查样本 ${report.samples.length} 条；警告 ${report.warnings.length} 条。`);
  return `${lines.join("\n")}\n`;
}

function help() {
  return `Usage:
  EVOLOOP_METRICS_DATABASE_URL=postgres://... node scripts/scheduling-metrics.mjs --project UUID [options]

Options:
  --days N             Number of complete days (default 3)
  --end YYYY-MM-DD     Last complete day in Asia/Tashkent (default yesterday)
  --start YYYY-MM-DD   First day; overrides --days
  --format text|json|markdown  Output format (default text)
  --out FILE           Write JSON report to FILE
  --markdown-out FILE  Write markdown report to FILE
  --samples N          Accepted for report shape; samples are capped at 10 in markdown
  --rollout FILE       Codex rollout JSONL (repeatable)
  --rollout-dir DIR    Rollout search root (default $CODEX_HOME/sessions or ~/.codex/sessions)
  --leader-thread ID   Leader native thread id (repeatable; default from runtime_session)
  --downtime-file FILE JSON [{start,end,reason}] or {intervals:[...]}
  --database-url URL   Overrides EVOLOOP_METRICS_DATABASE_URL
  --help               Show this help
`;
}

async function main() {
  const { values } = parseArgs({ allowPositionals: false, options: {
    project: { type: "string" }, "database-url": { type: "string" }, days: { type: "string" },
    end: { type: "string" }, start: { type: "string" }, format: { type: "string" }, json: { type: "boolean" },
    out: { type: "string" }, "markdown-out": { type: "string" }, samples: { type: "string" },
    rollout: { type: "string", multiple: true }, "rollout-dir": { type: "string" },
    "leader-thread": { type: "string", multiple: true }, "downtime-file": { type: "string" },
    help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(help()); return; }
  const projectId = values.project ?? process.env.EVOLOOP_PROJECT;
  if (!projectId) fail("PROJECT_REQUIRED", "--project is required");
  const databaseUrl = values["database-url"] ?? process.env.EVOLOOP_METRICS_DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL_REQUIRED", "set EVOLOOP_METRICS_DATABASE_URL or pass --database-url");
  const days = values.days ? Number(values.days) : 3;
  let windows;
  if (values.start) {
    const first = dayWindow(values.start);
    const last = dayWindow(values.end ?? values.start);
    if (timestamp(first.startUtc) > timestamp(last.startUtc)) fail("INVALID_RANGE", "--start must not be after --end");
    windows = [];
    for (let at = timestamp(first.startUtc); at <= timestamp(last.startUtc); at += DAY_MS)
      windows.push(dayWindow(tashkentDate(at)));
  } else {
    windows = completeDayWindows(new Date(), days, values.end ?? null);
  }
  const data = await collectDatabase(databaseUrl, projectId,
    { start: windows[0].startUtc, end: windows.at(-1).endUtc });
  const leaderSessions = data.sessions.filter(session => /Leader/i.test(session.role_title ?? ""));
  const leaderThreads = values["leader-thread"]?.length ? values["leader-thread"]
    : leaderSessions.map(session => session.native_thread_id).filter(Boolean);
  let rolloutPaths = values.rollout ?? [];
  if (!rolloutPaths.length) {
    const root = values["rollout-dir"] ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    rolloutPaths = findRolloutFiles(root, leaderThreads);
  }
  const parsedRollout = rolloutPaths.length ? readRollout(rolloutPaths) : null;
  const downtime = values["downtime-file"] ? normalizeDowntime(JSON.parse(readFileSync(values["downtime-file"], "utf8"))) : [];
  const report = buildReport({ projectId, windows, data, rollout: parsedRollout, downtime,
    sampleLimit: values.samples ? Number(values.samples) : 10 });
  const format = values.json ? "json" : values.format ?? "text";
  if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  if (values["markdown-out"]) writeFileSync(values["markdown-out"], renderMarkdown(report));
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(renderMarkdown(report));
  else process.stdout.write(renderText(report));
}

if (process.argv[1]?.endsWith("scheduling-metrics.mjs")) {
  main().catch(error => {
    const code = error?.code ?? "METRICS_FAILED";
    process.stderr.write(`${JSON.stringify({ error: { code, message: error?.message ?? String(error) } })}\n`);
    process.exitCode = 2;
  });
}
