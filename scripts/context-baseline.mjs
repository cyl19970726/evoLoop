#!/usr/bin/env node
// Compare a long Session before and after a context change from its native Codex rollout.
// Input is a JSONL file under the user's private Codex session directory; nothing is sent anywhere.
import { readFileSync } from "node:fs";

const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function percentile(values, ratio) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))] ?? null;
}

/** Summarize one rollout's per-turn context size and where its bytes go. */
export function summarizeRollout(lines, limit = null) {
  const turns = [];
  const bytes = new Map();
  let current = null;
  let cumulative = null;
  let compactions = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload ?? {};
    const category = record?.type === "response_item" ? `response_item.${payload.type ?? "unknown"}`
      : record?.type === "event_msg" ? `event_msg.${payload.type ?? "unknown"}`
        : String(record?.type ?? "unknown");
    bytes.set(category, (bytes.get(category) ?? 0) + Buffer.byteLength(line, "utf8"));
    if (record?.type === "compacted") compactions++;
    if (record?.type === "event_msg" && payload.type === "task_started") current = { maxInputTokens: 0 };
    if (record?.type === "event_msg" && payload.type === "token_count") {
      const usage = payload.info?.total_token_usage;
      if (usage) cumulative = usage;
      const last = token(payload.info?.last_token_usage?.input_tokens);
      if (current && last !== null) current.maxInputTokens = Math.max(current.maxInputTokens, last);
    }
    if (record?.type === "event_msg" && payload.type === "task_complete" && current) {
      if (current.maxInputTokens > 0) turns.push(current.maxInputTokens);
      current = null;
    }
  }
  const totalBytes = [...bytes.values()].reduce((sum, value) => sum + value, 0);
  const categories = [...bytes.entries()].sort(([, left], [, right]) => right - left)
    .map(([category, value]) => ({ category, bytes: value,
      share: totalBytes ? Number((value / totalBytes).toFixed(3)) : 0 }));
  return {
    turns: turns.length,
    meanInputTokens: turns.length ? Math.round(turns.reduce((sum, value) => sum + value, 0) / turns.length) : null,
    medianInputTokens: percentile(turns, 0.5),
    p90InputTokens: percentile(turns, 0.9),
    maxInputTokens: turns.length ? Math.max(...turns) : null,
    limit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    turnsOverLimit: Number.isSafeInteger(limit) && limit > 0 ? turns.filter(value => value >= limit).length : null,
    cumulativeInputTokens: token(cumulative?.input_tokens),
    cumulativeOutputTokens: token(cumulative?.output_tokens),
    compactions,
    totalBytes,
    categories,
  };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/context-baseline.mjs <rollout.jsonl> [--json]");
    process.exit(2);
  }
  const limitArgument = process.argv.indexOf("--limit");
  const limit = limitArgument >= 0 ? Number(process.argv[limitArgument + 1]) : null;
  const summary = summarizeRollout(readFileSync(path, "utf8").split("\n"), limit);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`Turns: ${summary.turns} · compactions: ${summary.compactions}`);
  console.log(`Per-turn input: mean ${summary.meanInputTokens ?? "?"}, median ${summary.medianInputTokens ?? "?"}, p90 ${summary.p90InputTokens ?? "?"}, max ${summary.maxInputTokens ?? "?"}`);
  if (summary.limit !== null)
    console.log(`At or above ${summary.limit}: ${summary.turnsOverLimit} / ${summary.turns} turns`);
  console.log(`Cumulative: input ${summary.cumulativeInputTokens ?? "?"}, output ${summary.cumulativeOutputTokens ?? "?"}`);
  console.log(`Rollout: ${(summary.totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  for (const item of summary.categories.slice(0, 10))
    console.log(`  ${(item.bytes / 1024 / 1024).toFixed(2).padStart(7)} MiB  ${(item.share * 100).toFixed(1).padStart(5)}%  ${item.category}`);
}

if (process.argv[1]?.endsWith("context-baseline.mjs")) main();
