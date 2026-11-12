// Pure parts of the daily boundary check (scripts/ops/boundary-check.mjs): who started each merge, which private files
// changed, which writes under the user's identity did not come from the workbench, and which Tasks were closed on a
// candidate-only observation. Everything here is a function of text and records, so the tests need no host.
// Evidence is stated as evidence: a transcript that ran a command is a session that ran it; a transcript that merely mentions
// a file near a write is a candidate. Nothing is guessed, and a record without evidence says so.

/** `HH:MM:SS    已合并 PR #N(sha)` lines of the merge train log, local time of `offsetMinutes` on `day` (YYYY-MM-DD). */
export function parseTrainLog(text, day, offsetMinutes, name = "") {
  const merges = [];
  for (const line of text.split("\n")) {
    const match = /^(\d\d):(\d\d):(\d\d)\s+已合并 PR #(\d+)/.exec(line);
    if (!match) continue;
    const [, h, m, s, pr] = match;
    const at = Date.parse(`${day}T${h}:${m}:${s}Z`) - offsetMinutes * 60_000;
    merges.push({ pr: Number(pr), at: new Date(at).toISOString(), log: name });
  }
  return merges;
}

/** Commands run by one transcript line (Codex function_call, Claude tool_use) with the line's UTC timestamp; [] for anything else. */
export function commandsOfLine(line) {
  if (!line.includes("function_call") && !line.includes("tool_use")) return [];
  let record; try { record = JSON.parse(line); } catch { return []; }
  const at = record.timestamp ?? record.payload?.timestamp;
  if (!at) return [];
  const commands = [];
  const payload = record.payload;
  if (payload?.type === "function_call" && typeof payload.arguments === "string") {
    try { const args = JSON.parse(payload.arguments); const command = args.cmd ?? args.command; if (typeof command === "string") commands.push(command); } catch { /* not JSON */ }
  }
  const content = record.message?.content;
  if (Array.isArray(content)) for (const part of content) if (part?.type === "tool_use" && typeof part.input?.command === "string") commands.push(part.input.command);
  return commands.map(command => ({ at: new Date(at).toISOString(), command }));
}

/** The identity a transcript mostly acts as: the agent-cli directory its commands use most (a count, not a claim). */
export function dominantActor(commands) {
  const counts = new Map();
  for (const { command } of commands) for (const match of command.matchAll(/agent-cli\/([A-Za-z0-9._-]+)\/evoloop/g)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked.length ? { actor: ranked[0][0], uses: ranked[0][1], others: ranked.slice(1).map(([actor, uses]) => `${actor}×${uses}`) } : null;
}

/**
 * Merge commands in a transcript's commands. One command line may run several: `merge-gate.mjs merge --pr N [--execute] [--config PATH]`
 * segments (each ends at ; & | or a newline), plus `gh pr merge N` and `gh api .../pulls/N/merge` (no merge-gate config involved).
 */
/** `for n in 1 2 3; do ... $n ... done` written out once per value, so the merge segments inside can be read. */
export function expandLoops(command) {
  return command.replace(/for\s+(\w+)\s+in\s+([\d\s]+);\s*do\b([\s\S]*?)\bdone\b/g, (_whole, name, values, body) =>
    values.trim().split(/\s+/).map(value => body.replaceAll("${" + name + "}", value).replaceAll("$" + name, value)).join("\n"));
}

export function mergeInvocations(commands) {
  const found = [];
  for (const { at, command: raw } of commands) {
    const command = expandLoops(raw);
    for (const match of command.matchAll(/merge-gate\.mjs\s+merge\b([^;&|\n]*)/g)) {
      const rest = match[1];
      if (!/--execute\b/.test(rest)) continue;
      const pr = /--pr[ =](\d+)/.exec(rest) ?? /^\s*(\d+)\b/.exec(rest);
      const config = /--config[ =]("[^"]+"|'[^']+'|\S+)/.exec(rest);
      if (pr) found.push({ at, pr: Number(pr[1]), config: config ? config[1].replace(/^["']|["']$/g, "") : null, via: "merge-gate" });
    }
    for (const match of command.matchAll(/\bgh\s+pr\s+merge\s+(\d+)/g)) found.push({ at, pr: Number(match[1]), config: null, via: "gh pr merge" });
    for (const match of command.matchAll(/\bgh\s+api\s+\S*pulls\/(\d+)\/merge/g)) found.push({ at, pr: Number(match[1]), config: null, via: "gh api merge" });
  }
  return found;
}

/** The identity a merge-gate config acts as, from its CLI path ( .../agent-cli/<actor>/evoloop ). */
export function configIdentity(config) {
  const first = Array.isArray(config?.cli) ? config.cli[0] : null;
  const match = typeof first === "string" ? /agent-cli\/([A-Za-z0-9._-]+)\//.exec(first) : null;
  return match ? match[1] : null;
}

/**
 * One row per merged PR in the window: who merged it on GitHub (always the one account), whether the merge train log holds it,
 * and which transcript ran the merge command, as which identity, with whose config. `transcripts` is
 * [{ id, actor, merges: [{ at, pr, configIdentity }] }].
 */
export function mergeRows({ merged, train, transcripts }) {
  const trainBy = new Map(train.map(item => [item.pr, item]));
  return merged.map(pr => {
    const runs = transcripts.flatMap(t => t.merges.filter(m => m.pr === pr.number).map(m => ({ transcript: t.id, actor: t.actor?.actor ?? null, config: m.configIdentity, at: m.at, via: m.via })));
    const own = trainBy.get(pr.number);
    let verdict, who;
    if (own) { verdict = "合并列车"; who = `合并列车日志 ${own.log}`; }
    else if (runs.length) {
      const borrowed = runs.find(run => run.actor && run.config && run.actor !== run.config);
      verdict = borrowed ? "借用他人合并配置" : "本人发起";
      const seen = new Set();
      who = runs.map(run => run.via === "merge-gate" ? `${run.actor ?? "身份未识别"} 用 ${run.config ?? "配置未识别"} 的配置（会话记录 ${run.transcript}）` : `${run.actor ?? "身份未识别"} 用 ${run.via}（会话记录 ${run.transcript}）`).filter(text => !seen.has(text) && seen.add(text)).join("；");
    } else { verdict = "发起者无记录"; who = "不在合并列车日志，也没有会话记录里的合并命令"; }
    return { pr: pr.number, mergedAt: pr.mergedAt, githubLogin: pr.mergedBy?.login ?? null, title: pr.title, verdict, who };
  });
}

const keyPaths = (value, prefix = "", depth = 0) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth >= 2) return [];
  return Object.keys(value).flatMap(key => [`${prefix}${key}`, ...keyPaths(value[key], `${prefix}${key}.`, depth + 1)]);
};
/** How many entries each array or object holds, by path, three levels down (counts only: no value is read out). */
const sizes = (value, prefix = "", depth = 0, out = new Map()) => {
  if (value === null || typeof value !== "object" || depth >= 3) return out;
  if (prefix) out.set(prefix, Array.isArray(value) ? value.length : Object.keys(value).length);
  if (!Array.isArray(value)) for (const key of Object.keys(value)) sizes(value[key], `${prefix}${prefix ? "." : ""}${key}`, depth + 1, out);
  return out;
};
/** Key NAMES and entry counts (never values) that differ between two JSON texts, and whether each parses. */
export function jsonKeyDiff(beforeText, afterText) {
  const parse = text => { try { const value = JSON.parse(text); return { ok: true, keys: new Set(keyPaths(value)), sizes: sizes(value) }; } catch { return { ok: false, keys: new Set(), sizes: new Map() }; } };
  const before = parse(beforeText), after = parse(afterText);
  const changedSizes = [...after.sizes].filter(([path, count]) => before.sizes.has(path) && before.sizes.get(path) !== count).map(([path, count]) => `${path} ${before.sizes.get(path)}→${count}`).sort();
  return { beforeParses: before.ok, afterParses: after.ok, changedSizes,
    added: [...after.keys].filter(key => !before.keys.has(key)).sort(), removed: [...before.keys].filter(key => !after.keys.has(key)).sort() };
}

/** Transcripts that ran a command mentioning one of `needles` within `windowMs` of `atMs`; counts only, never the command. */
export function mentionsNear(transcripts, needles, atMs, windowMs) {
  const result = [];
  for (const t of transcripts) {
    const hits = t.commands.filter(item => Math.abs(Date.parse(item.at) - atMs) <= windowMs && needles.some(needle => item.command.includes(needle)));
    if (hits.length) result.push({ transcript: t.id, actor: t.actor?.actor ?? null, commands: hits.length, first: hits.map(hit => hit.at).sort()[0] });
  }
  return result.sort((a, b) => b.commands - a.commands);
}

/** The two words an observation is judged by: it speaks of a candidate, and says it read the formal environment back. */
export const mentionsCandidate = text => /候选/.test(text ?? "");
export const mentionsFormalReadback = text => /正式[^。；\n]{0,25}(读回|已验证|验证通过|实测|已通过|通过)/.test(text ?? "");
export const declaredStage = body => { const match = /阶段\*{0,2}[:：]\*{0,2}\s*(正式|候选)/.exec(body ?? ""); return match ? match[1] : null; };

export const day = (value, offsetMinutes) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) throw new Error("--day must be YYYY-MM-DD");
  const from = Date.parse(`${value}T00:00:00Z`) - offsetMinutes * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(from + 86_400_000).toISOString() };
};
