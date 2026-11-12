#!/usr/bin/env node
// Daily boundary check, read only. Prints four tables for a day or a window so that a boundary crossed is seen the same day:
//   1. merged PRs and who actually started each merge (GitHub, the merge train log, and the merge commands found in session transcripts)
//   2. private runtime files modified in the window, their backups, whether they still parse, which key names changed,
//      and which transcripts ran a command mentioning the file around the modification
//   3. writes under the user's identity (owner-human), and whether a session touched an identity file around the write
//   4. Tasks closed on a candidate-only observation
// It blocks nothing and changes nothing: it opens the database in a read-only transaction, reads files and transcripts, and prints
// session ids, times and counts, never command text, file contents or token values. Private paths come from the config file
// EVOLOOP_BOUNDARY_CONFIG (an absolute path outside the repository); see docs/development/local-run.md.
import { createReadStream, realpathSync } from "node:fs";
import { glob, readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  commandsOfLine, configIdentity, day, declaredStage, dominantActor, jsonKeyDiff, mentionsCandidate, mentionsFormalReadback,
  mentionsNear, mergeInvocations, mergeRows, parseTrainLog,
} from "../lib/boundary-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MINUTE = 60_000;

export function loadConfig(text, path) {
  if (!isAbsolute(path) || resolve(path).startsWith(repoRoot + sep)) throw new Error("Boundary config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  if (!config.repo || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error("config.repo must be owner/name");
  if (!Number.isInteger(config.utcOffsetMinutes)) throw new Error("config.utcOffsetMinutes (the local time zone's offset, e.g. 300) is required");
  if (!Array.isArray(config.humanActors) || !config.humanActors.length) throw new Error("config.humanActors must list the user's identity names");
  return config;
}

const iso = ms => new Date(ms).toISOString();
const local = (ms, offset) => new Date(ms + offset * MINUTE).toISOString().replace("T", " ").slice(5, 19);

/** Transcripts (JSONL) modified since the window started: the commands each ran inside the window, and the identity it mostly acts as. */
async function readTranscripts(roots, fromMs, toMs) {
  const files = [];
  for (const root of roots ?? []) {
    try { for await (const entry of glob("**/*.jsonl", { cwd: root })) { const path = join(root, entry); if ((await stat(path)).mtimeMs >= fromMs - 15 * MINUTE) files.push(path); } } catch { /* a missing root is a missing source, reported by the caller */ }
  }
  const transcripts = [];
  for (const path of files) {
    const commands = [], all = [];
    for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
      if (!line.includes("function_call") && !line.includes("tool_use")) continue;
      for (const item of commandsOfLine(line)) {
        const at = Date.parse(item.at);
        all.push({ at: item.at, command: item.command.match(/agent-cli\/[A-Za-z0-9._-]+\/evoloop/g)?.join(" ") ?? "" });
        if (at >= fromMs - 15 * MINUTE && at < toMs + 15 * MINUTE) commands.push(item);
      }
    }
    if (!commands.length) continue;
    const id = basename(path, ".jsonl").replace(/^rollout-\d{4}-\d\d-\d\dT[\d-]+-/, "").slice(0, 8);
    transcripts.push({ id, commands, actor: dominantActor(all.map(item => ({ command: item.command }))), merges: [] });
  }
  return transcripts;
}

async function privateFileRows(config, fromMs, toMs, transcripts) {
  const rows = [];
  for (const spec of config.privateFiles ?? []) {
    const paths = [];
    for (const pattern of spec.globs ?? []) { try { for await (const path of glob(pattern)) paths.push(path); } catch { /* none */ } }
    const byDir = new Map();
    for (const path of paths) { const dir = dirname(path); byDir.set(dir, [...(byDir.get(dir) ?? []), path]); }
    for (const [dir, list] of byDir) {
      const infos = [];
      for (const path of list) { const info = await stat(path); infos.push({ path, name: basename(path), mtimeMs: info.mtimeMs, size: info.size }); }
      infos.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const [index, file] of infos.entries()) {
        if (file.mtimeMs < fromMs || file.mtimeMs >= toMs) continue;
        const base = file.name.split(".bak")[0].split(".before")[0];
        const earlier = infos.slice(0, index).reverse().find(other => other.name.startsWith(base) && other.name !== file.name) ?? null;
        let diff = null;
        if (/\.json/.test(file.name)) {
          const text = await readFile(file.path, "utf8");
          diff = earlier ? jsonKeyDiff(await readFile(earlier.path, "utf8"), text) : jsonKeyDiff("{}", text);
        }
        rows.push({ release: basename(dirname(dir)), file: file.name, modifiedAt: iso(file.mtimeMs), size: file.size, previous: earlier ? { name: earlier.name, modifiedAt: iso(earlier.mtimeMs), size: earlier.size } : null,
          parses: diff ? diff.afterParses : null, keysAdded: diff?.added ?? [], keysRemoved: diff?.removed ?? [], changedSizes: diff?.changedSizes ?? [],
          backups: infos.filter(other => other.name !== file.name && other.name.startsWith(base)).map(other => `${other.name} (${iso(other.mtimeMs).slice(11, 19)}Z)`),
          sessions: mentionsNear(transcripts, [base], file.mtimeMs, 5 * MINUTE) });
      }
    }
  }
  return rows;
}

async function databaseRows(config, fromIso, toIso, transcripts) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: config.databaseUrl, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    const writes = (await client.query(`
      SELECT 'direct_input' AS source, created_at, mode AS detail, session_id::text AS target, actor_id FROM session_direct_input WHERE actor_id = ANY($1) AND created_at >= $2 AND created_at < $3
      UNION ALL SELECT 'operation_journal', created_at, command_type, '', actor_id FROM operation_journal WHERE actor_id = ANY($1) AND created_at >= $2 AND created_at < $3
      UNION ALL SELECT 'session_message', created_at, 'message', session_id::text, sender_actor_id FROM session_message WHERE sender_actor_id = ANY($1) AND created_at >= $2 AND created_at < $3
      ORDER BY 2`, [config.humanActors, fromIso, toIso])).rows;
    const closures = (await client.query(`
      WITH cl AS (SELECT * FROM task_closure WHERE created_at >= $1 AND created_at < $2)
      SELECT c.created_at, c.actor_id, c.task_id::text, (SELECT t.title FROM task t WHERE t.project_id = c.project_id AND t.task_id = c.task_id) AS title,
             (SELECT o.observer || ':' || o.result FROM consumer_observation o WHERE o.project_id = c.project_id AND o.delivery_id = c.delivery_id ORDER BY o.sequence DESC, o.created_at DESC LIMIT 1) AS observation,
             (SELECT coalesce(o.evidence, '') || ' ' || coalesce(o.reason, '') FROM consumer_observation o WHERE o.project_id = c.project_id AND o.delivery_id = c.delivery_id ORDER BY o.sequence DESC, o.created_at DESC LIMIT 1) AS evidence,
             (SELECT dr.body FROM document_revision dr WHERE dr.project_id = c.project_id AND dr.revision_id = (SELECT tr.content_revision_id FROM task_revision tr WHERE tr.project_id = c.project_id AND tr.revision_id = c.task_revision_id)) AS body
        FROM cl c ORDER BY c.created_at`, [fromIso, toIso])).rows;
    const needles = config.identityFiles ?? [];
    return {
      humanWrites: writes.map(row => {
        const sessions = needles.length ? mentionsNear(transcripts, needles, Date.parse(row.created_at), 10 * MINUTE) : [];
        return { at: new Date(row.created_at).toISOString(), source: row.source, detail: row.detail, target: row.target.slice(0, 8), actor: row.actor_id, identityFileSessions: sessions };
      }),
      closures: closures.map(row => ({ closedAt: new Date(row.created_at).toISOString(), by: row.actor_id, task: row.task_id.slice(0, 8), title: row.title, observation: row.observation,
        candidateOnly: mentionsCandidate(row.evidence) && !mentionsFormalReadback(row.evidence), mentionsCandidate: mentionsCandidate(row.evidence),
        formalReadback: mentionsFormalReadback(row.evidence), declaredStage: declaredStage(row.body) })),
    };
  } finally { await client.end(); }
}

async function trainMerges(config, fromMs, toMs) {
  const merges = [];
  const dir = config.mergeTrainLogs?.dir;
  if (!dir) return merges;
  for (const name of await readdir(dir).catch(() => [])) {
    const match = /^merge-train-(\d{4})(\d\d)(\d\d)-/.exec(name);
    if (!match) continue;
    for (const item of parseTrainLog(await readFile(join(dir, name), "utf8"), `${match[1]}-${match[2]}-${match[3]}`, config.utcOffsetMinutes, name)) {
      const at = Date.parse(item.at); if (at >= fromMs && at < toMs) merges.push(item);
    }
  }
  return merges;
}

export async function collect(config, { from, to }) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const sources = {};
  const transcripts = await readTranscripts(config.transcriptRoots, fromMs, toMs);
  sources.transcripts = `${transcripts.length} 个会话记录有窗口内的命令`;
  for (const t of transcripts) {
    for (const invocation of mergeInvocations(t.commands)) {
      let identity = null;
      if (invocation.config) { try { identity = configIdentity(JSON.parse(await readFile(invocation.config.replace(/^~/, process.env.HOME ?? "~"), "utf8"))); } catch { identity = null; } }
      t.merges.push({ ...invocation, configIdentity: identity });
    }
  }
  const slug = config.repo;
  const prs = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", slug, "--state", "merged", "--limit", "300", "--json", "number,title,mergedAt,mergedBy"], { encoding: "utf8", maxBuffer: 64 << 20 }));
  const merged = prs.filter(pr => { const at = Date.parse(pr.mergedAt); return at >= fromMs && at < toMs; }).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const train = await trainMerges(config, fromMs, toMs);
  const db = await databaseRows(config, from, to, transcripts);
  return { window: { from, to }, sources,
    merges: mergeRows({ merged, train, transcripts }),
    privateFiles: await privateFileRows(config, fromMs, toMs, transcripts),
    humanWrites: db.humanWrites, closures: db.closures };
}

export function format(result, offset, { flaggedOnly = false } = {}) {
  const out = [], t = value => local(Date.parse(value), offset);
  const flagged = {
    merges: result.merges.filter(row => ["借用他人合并配置", "发起者无记录"].includes(row.verdict)),
    files: result.privateFiles.filter(row => row.parses === false || row.sessions.length || row.keysAdded.length || row.keysRemoved.length || row.changedSizes.length),
    writes: result.humanWrites.filter(row => row.identityFileSessions.length),
    closures: result.closures.filter(row => row.candidateOnly),
  };
  out.push(`边界核对 ${t(result.window.from)} — ${t(result.window.to)}（本地时间，UTC${offset >= 0 ? "+" : "-"}${Math.abs(offset) / 60}）`);
  out.push(`需要看的：合并 ${flagged.merges.length}（共 ${result.merges.length}）· 私有文件 ${flagged.files.length}（共 ${result.privateFiles.length}）· 以使用者身份写入 ${flagged.writes.length}（共 ${result.humanWrites.length}）· 候选观察下关闭 ${flagged.closures.length}（共 ${result.closures.length}）`);
  out.push(`数据来源：${Object.values(result.sources).join("；")}`, "");
  out.push("1. 合并（GitHub 合并者只有一个账号，实际发起者看后一列）");
  for (const row of flaggedOnly ? flagged.merges : result.merges) out.push(`  ${["借用他人合并配置", "发起者无记录"].includes(row.verdict) ? "⚠" : " "} ${t(row.mergedAt)} #${row.pr} ${row.verdict} — ${row.who}`);
  out.push("", "2. 私有运行文件（只读；只写键名、修改时间和会话编号，不写内容）");
  for (const row of flaggedOnly ? flagged.files : result.privateFiles) out.push(`  ${row.parses === false ? "⚠ 格式无效" : " "} ${t(row.modifiedAt)} ${row.release}/${row.file} ${row.size} 字节${row.previous ? `，上一份 ${row.previous.name}（${t(row.previous.modifiedAt)}）` : ""}`
    + `${row.keysAdded.length ? `，新增键 ${row.keysAdded.join("、")}` : ""}${row.keysRemoved.length ? `，去掉键 ${row.keysRemoved.join("、")}` : ""}${row.changedSizes.length ? `，条目数变化 ${row.changedSizes.join("、")}` : ""}`
    + `${row.backups.length ? `；备份 ${row.backups.join("、")}` : "；无备份"}${row.sessions.length ? `；±5 分钟内提到该文件的会话 ${row.sessions.map(s => `${s.transcript}（${s.actor ?? "?"}，${s.commands} 条）`).join("、")}` : ""}`);
  out.push("", "3. 以使用者身份写入（是否出自工作台，库里没有这一项；这里只给能核对的证据）");
  for (const row of flaggedOnly ? flagged.writes : result.humanWrites) out.push(`  ${row.identityFileSessions.length ? "⚠" : " "} ${t(row.at)} ${row.source}/${row.detail} → ${row.target} 身份 ${row.actor}；`
    + (row.identityFileSessions.length ? `±10 分钟内有会话的命令引用了身份文件：${row.identityFileSessions.map(s => `${s.transcript}（${s.actor ?? "?"}，${s.commands} 条）`).join("、")}` : "没有会话引用身份文件；来源未证实（可能是使用者本人，也可能是已登录页面里的自动化）"));
  out.push("", "4. 关闭记录与依据观察（只写“候选”的列出）");
  for (const row of flaggedOnly ? flagged.closures : result.closures) out.push(`  ${row.candidateOnly ? "⚠" : " "} ${t(row.closedAt)} ${row.task} ${row.title ?? ""} 由 ${row.by} 关闭；依据 ${row.observation ?? "无"}；`
    + `${row.candidateOnly ? "依据只写候选" : row.mentionsCandidate ? "依据同时提到候选与正式读回" : "依据没有候选字样"}${row.declaredStage ? `；任务声明阶段：${row.declaredStage}` : ""}`);
  return out.join("\n");
}

const isMain = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) {
  const { values } = parseArgs({ options: { day: { type: "string" }, from: { type: "string" }, to: { type: "string" }, json: { type: "boolean", default: false }, "flagged-only": { type: "boolean", default: false }, config: { type: "string" } } });
  const path = values.config ?? process.env.EVOLOOP_BOUNDARY_CONFIG;
  if (!path) throw new Error("Set EVOLOOP_BOUNDARY_CONFIG (or --config) to the private config file");
  const config = loadConfig(await readFile(path, "utf8"), path);
  const window = values.day ? day(values.day, config.utcOffsetMinutes) : { from: values.from, to: values.to };
  if (!window.from || !window.to || Number.isNaN(Date.parse(window.from)) || Number.isNaN(Date.parse(window.to))) throw new Error("Give --day YYYY-MM-DD, or --from and --to as ISO times");
  const result = await collect(config, window);
  console.log(values.json ? JSON.stringify(result, null, 2) : format(result, config.utcOffsetMinutes, { flaggedOnly: values["flagged-only"] }));
}
