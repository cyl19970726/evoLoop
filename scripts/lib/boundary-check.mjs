// Pure parts of the daily boundary check (scripts/ops/boundary-check.mjs): who started each merge, which private files
// changed, which writes under the user's identity did not come from the workbench, and which Tasks were closed on a
// candidate-only observation. Everything here is a function of text and records, so the tests need no host.
// Evidence is stated as evidence: a transcript that ran a command is a session that ran it; a transcript that merely mentions
// a file near a write is a candidate. Nothing is guessed, and a record without evidence says so.

/**
 * `HH:MM:SS    已合并 PR #N(sha)` lines of the merge train log, local time of `offsetMinutes`. `day` (YYYY-MM-DD) is the day the log
 * was started (its file name); a train that runs past midnight has times that go back to 00:xx, and those lines belong to the next day.
 */
export function parseTrainLog(text, day, offsetMinutes, name = "") {
  const merges = [];
  let previous = -1, dayShift = 0;
  for (const line of text.split("\n")) {
    const stamp = /^(\d\d):(\d\d):(\d\d)\s/.exec(line);
    if (stamp) {
      const seconds = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
      if (seconds < previous) dayShift += 1; // the clock went backwards: it is after midnight now
      previous = seconds;
    }
    const match = /^(\d\d):(\d\d):(\d\d)\s+已合并 PR #(\d+)/.exec(line);
    if (!match) continue;
    const [, h, m, s, pr] = match;
    const at = Date.parse(`${day}T${h}:${m}:${s}Z`) + dayShift * 86_400_000 - offsetMinutes * 60_000;
    merges.push({ pr: Number(pr), at: new Date(at).toISOString(), log: name });
  }
  return merges;
}

/** Every string in a tool call's arguments (a command, a Read/Edit file_path, an array-form command), joined: what the call touched. */
const argumentText = value => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return [value.flatMap(argumentText).join(" ")];
  if (value && typeof value === "object") return Object.values(value).flatMap(argumentText);
  return [];
};

/**
 * What one transcript line did with tools (Codex function_call, Claude tool_use), with the line's UTC timestamp; [] for anything else.
 * The text is the call's whole argument list, so a file read through a Read/Edit tool's file_path or an array-form command counts
 * the same as a shell command; it is only ever matched against, never printed.
 */
export function commandsOfLine(line) {
  if (!line.includes("function_call") && !line.includes("tool_use")) return [];
  let record; try { record = JSON.parse(line); } catch { return []; }
  const at = record.timestamp ?? record.payload?.timestamp;
  if (!at) return [];
  const calls = [];
  const payload = record.payload;
  if (payload?.type === "function_call" && typeof payload.arguments === "string") {
    try { calls.push(argumentText(JSON.parse(payload.arguments)).join("\n")); } catch { calls.push(payload.arguments); }
  }
  const content = record.message?.content;
  if (Array.isArray(content)) for (const part of content) if (part?.type === "tool_use" && part.input) calls.push(argumentText(part.input).join("\n"));
  return calls.filter(Boolean).map(command => ({ at: new Date(at).toISOString(), command }));
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

/** `NAME=…merge-gate.mjs` assignments written into the later `$NAME` / `${NAME}` uses, so an indirect call still reads as a merge-gate call. */
export function resolveVariables(command) {
  let out = command;
  for (const match of command.matchAll(/\b(\w+)=(\S*merge-gate\.mjs)\b/g)) out = out.replaceAll("${" + match[1] + "}", match[2]).replaceAll("$" + match[1], match[2]);
  return out;
}

/** The PR number of `gh pr merge` arguments wherever the flags stand (`--squash 6`, `--auto 10`, `6 --merge`, a pull URL); options that take a value are skipped with it. */
export function ghMergeNumber(args) {
  const takesValue = new Set(["--match-head-commit", "--subject", "-t", "--body", "-b", "--body-file", "-F", "--author-email", "-A", "--repo", "-R"]);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (takesValue.has(token)) { index++; continue; }
    if (token.startsWith("-")) continue;
    if (/^\d+$/.test(token)) return Number(token);
    const url = /\/pull\/(\d+)/.exec(token);
    if (url) return Number(url[1]);
  }
  return null;
}

/**
 * The part of a shell command that is run, not written: heredoc bodies (`cat > file <<'EOF' … EOF`, `python3 - <<'PY' …`) are text
 * being written or fed to an interpreter, and a test or note that quotes a merge command is not a merge.
 */
export function executedPart(command) {
  const start = /<<-?\s*['"]?\w+['"]?/.exec(command);
  return start ? command.slice(0, start.index) : command;
}

// A command starts at the beginning, after ; & | or a newline (and after VAR=value prefixes); a merge command mentioned inside
// another command's arguments (grep, echo, a quoted string) is not one.
const COMMAND_START = String.raw`(?:^|[;&|\n(])\s*(?:[A-Za-z_]\w*=\S+\s+)*`;

export function mergeInvocations(commands) {
  const found = [];
  for (const { at, command: raw } of commands) {
    const command = resolveVariables(expandLoops(executedPart(raw)));
    for (const match of command.matchAll(new RegExp(COMMAND_START + String.raw`(?:node|nodejs)\s+\S*merge-gate\.mjs\s+merge\b([^;&|\n]*)`, "g"))) {
      const rest = match[1];
      if (!/--execute\b/.test(rest)) continue;
      const pr = /--pr[ =](\d+)/.exec(rest) ?? /^\s*(\d+)\b/.exec(rest);
      const config = /--config[ =]("[^"]+"|'[^']+'|\S+)/.exec(rest);
      const viaEnvironment = /\bEVOLOOP_MERGE_CONFIG=("[^"]+"|'[^']+'|\S+)/.exec(command);
      const path = config ?? viaEnvironment; // the merge-gate reads EVOLOOP_MERGE_CONFIG when --config is not given
      if (pr) found.push({ at, pr: Number(pr[1]), config: path ? path[1].replace(/^["']|["']$/g, "") : null, via: "merge-gate" });
    }
    for (const match of command.matchAll(new RegExp(COMMAND_START + String.raw`gh\s+pr\s+merge\b([^;&|\n]*)`, "g"))) {
      const pr = ghMergeNumber(match[1]);
      if (pr) found.push({ at, pr, config: null, via: "gh pr merge" });
    }
    for (const match of command.matchAll(new RegExp(COMMAND_START + String.raw`gh\s+api\s+[^;&|\n]*?pulls\/(\d+)\/merge`, "g"))) found.push({ at, pr: Number(match[1]), config: null, via: "gh api merge" });
  }
  return found;
}

/** The identity a merge-gate config acts as, from its CLI path ( .../agent-cli/<actor>/evoloop ). */
export function configIdentity(config) {
  const first = Array.isArray(config?.cli) ? config.cli[0] : null;
  const match = typeof first === "string" ? /agent-cli\/([A-Za-z0-9._-]+)\//.exec(first) : null;
  return match ? match[1] : null;
}

/** The verdicts of merge rows that need a person to look: everything except a train merge or a merge-gate merge whose identities are known and equal. */
export const MERGE_OK = ["合并列车", "本人发起"];

/**
 * One row per merged PR in the window: who merged it on GitHub (always the one account), whether the merge train log holds it,
 * and which transcript ran the merge command, as which identity, with whose config. `transcripts` is
 * [{ id, actor, merges: [{ at, pr, via, configIdentity }] }]. Only two outcomes are "fine": a train merge no session also claims,
 * and a merge-gate merge where the session's identity and the config's identity are both known and the same. Everything else is listed:
 * an unknown identity or config, a merge that did not go through the merge gate, a train log that disagrees with the transcripts,
 * and a merge nobody has a record of.
 */
export function mergeRows({ merged, train, transcripts }) {
  const trainBy = new Map(train.map(item => [item.pr, item]));
  return merged.map(pr => {
    const runs = transcripts.flatMap(t => t.merges.filter(m => m.pr === pr.number).map(m => ({ transcript: t.id, actor: t.actor?.actor ?? null, config: m.configIdentity ?? null, at: m.at, via: m.via })));
    const own = trainBy.get(pr.number);
    const describe = run => run.via === "merge-gate"
      ? `${run.actor ?? "身份未识别"} 用 ${run.config ?? "配置未识别"} 的配置（会话记录 ${run.transcript}）`
      : `${run.actor ?? "身份未识别"} 用 ${run.via}（会话记录 ${run.transcript}）`;
    const seen = new Set();
    const who = runs.map(describe).filter(text => !seen.has(text) && seen.add(text)).join("；");
    let verdict, why = "";
    if (own && runs.length) { verdict = "合并列车与会话记录冲突"; why = `合并列车日志 ${own.log} 记了它，同时会话记录里有人运行了合并：`; }
    else if (own) { verdict = "合并列车"; why = `合并列车日志 ${own.log}`; }
    else if (!runs.length) { verdict = "发起者无记录"; why = "不在合并列车日志，也没有会话记录里的合并命令"; }
    else if (runs.some(run => run.via !== "merge-gate")) { verdict = "绕过合并门"; why = "没有经过合并门（合并门会核对验收）："; }
    else if (runs.some(run => !run.actor || !run.config)) {
      verdict = "发起者或配置认不出";
      why = `认不出的是${runs.some(run => !run.actor) ? "发起会话的身份" : ""}${runs.some(run => !run.actor) && runs.some(run => !run.config) ? "和" : ""}${runs.some(run => !run.config) ? "合并配置所属的身份" : ""}：`;
    }
    else if (runs.some(run => run.actor !== run.config)) { verdict = "借用他人合并配置"; why = ""; }
    else { verdict = "本人发起"; why = ""; }
    return { pr: pr.number, mergedAt: pr.mergedAt, githubLogin: pr.mergedBy?.login ?? null, title: pr.title, verdict, who: `${why}${own && !runs.length ? "" : who}` };
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

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does a tool call's text name the file? `config.json` is not found in `tsconfig.json`; `integrations.json.bak-1` still names `integrations.json`. */
export const mentionsFile = (text, name) => new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-])`).test(text);

/** Transcripts that ran a command mentioning one of `needles` within `windowMs` of `atMs`; counts only, never the command. */
export function mentionsNear(transcripts, needles, atMs, windowMs) {
  const result = [];
  for (const t of transcripts) {
    const hits = t.commands.filter(item => Math.abs(Date.parse(item.at) - atMs) <= windowMs && needles.some(needle => mentionsFile(item.command, needle)));
    if (hits.length) result.push({ transcript: t.id, actor: t.actor?.actor ?? null, commands: hits.length, first: hits.map(hit => hit.at).sort()[0] });
  }
  return result.sort((a, b) => b.commands - a.commands);
}

/**
 * Every transcript that touched one of `needles` anywhere in the commands it was given (the whole window, not a fixed distance from
 * the write): a session can read an identity file hours before it uses what it read. `nearestMinutes` says how far the closest
 * touch was from `atMs`, so the reader can weigh it; counts and times only.
 */
export function mentionsAnywhere(transcripts, needles, atMs) {
  const result = [];
  for (const t of transcripts) {
    const times = t.commands.filter(item => needles.some(needle => mentionsFile(item.command, needle))).map(item => Date.parse(item.at));
    if (times.length) result.push({ transcript: t.id, actor: t.actor?.actor ?? null, commands: times.length, nearestMinutes: Math.round(Math.min(...times.map(time => Math.abs(time - atMs))) / 60_000) });
  }
  return result.sort((a, b) => a.nearestMinutes - b.nearestMinutes || b.commands - a.commands);
}

/** The words an observation is judged by: it speaks of a candidate, and it says the formal environment was read back and it worked. */
export const mentionsCandidate = text => /候选/.test(text ?? "");
// Negation, to-do and failure in a clause: 未 不 没 待 尚 暂 缺 失败 TODO 等待 / “等正式读回”.
const NOT_DONE = /(未|不|没|待|尚|暂|缺|失败|失效|拒绝|TODO|todo|等待|等[^，。；]{0,4}(读回|正式))/;
const SUCCESS = /(读回(通过|成功|一致|正常|完成|可用)|已验证|验证通过|实测(通过|成功)|已通过|通过|成功)/;
/**
 * A formal read-back is a clause that speaks of 正式 and states success (读回通过/成功、已验证、实测通过、已通过…), with nothing in
 * that clause saying it did not happen, failed, is still to do or is being waited for. “读回” alone is not success:
 * “正式实例读回失败”, “等正式读回”, “正式读回 TODO”, “正式读回缺”, “正式未通过”, “正式读回待做” are all not read-backs.
 */
export const mentionsFormalReadback = text => (text ?? "").split(/[。；;，,\n]/).some(clause => /正式/.test(clause) && SUCCESS.test(clause) && !NOT_DONE.test(clause));

/**
 * What to say about one closure. `hasDelivery`: the closure was decided on a Delivery, so there is an observation to read; a closure
 * decided without one (delivery_id empty) has no basis to judge and is listed as such rather than passed over. A Task that itself
 * declares the candidate stage may be closed on a candidate observation: that is what its stage asks for.
 */
export function judgeClosure({ evidence, hasDelivery, stage }) {
  if (!hasDelivery || evidence === null || evidence === undefined) return { noBasis: true, candidateOnly: false, mentionsCandidate: false, formalReadback: false, flagged: true };
  const candidate = mentionsCandidate(evidence), formal = mentionsFormalReadback(evidence);
  const candidateOnly = candidate && !formal;
  return { noBasis: false, candidateOnly, mentionsCandidate: candidate, formalReadback: formal, flagged: candidateOnly && stage !== "候选" };
}

/**
 * Why a report would be incomplete before anything is read: a source that is not configured is a source that was not checked, and
 * “nothing found” from it would be a false all-clear.
 */
export function configProblems(config) {
  const problems = [];
  if (!(config.transcriptRoots ?? []).length) problems.push("transcriptRoots 没有配置：合并发起者和身份文件引用都无法核对");
  if (!(config.privateFiles ?? []).some(spec => (spec.globs ?? []).length)) problems.push("privateFiles 没有配置：私有文件改动无法核对");
  if (!(config.identityFiles ?? []).length) problems.push("identityFiles 没有配置：以使用者身份写入的来源无法核对");
  if (!config.mergeTrainLogs?.dir) problems.push("mergeTrainLogs.dir 没有配置：合并列车的合并无法区分");
  if (!config.databaseUrl) problems.push("databaseUrl 没有配置：写入与关闭记录无法核对");
  return problems;
}

/** A listing that hit its limit and still reaches into the window has lost rows. */
export const truncationProblem = (count, limit, oldestAtMs, fromMs) => count >= limit && oldestAtMs > fromMs
  ? `GitHub 合并列表达到上限 ${limit} 条，窗口起点之前的合并没有读全` : null;

export const declaredStage = body => { const match = /阶段\*{0,2}[:：]\*{0,2}\s*(正式|候选)/.exec(body ?? ""); return match ? match[1] : null; };

export const day = (value, offsetMinutes) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) throw new Error("--day must be YYYY-MM-DD");
  const from = Date.parse(`${value}T00:00:00Z`) - offsetMinutes * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(from + 86_400_000).toISOString() };
};

/** A write whose session is unknown (an external message has no session id) is still a row, not a crash. */
export const targetLabel = value => String(value ?? "").slice(0, 8) || "（无会话）";

/** Non-zero when any source was not read or not configured: an incomplete check must not look like a clean one. */
export const exitCodeFor = result => (result.problems?.length ? 2 : 0);
