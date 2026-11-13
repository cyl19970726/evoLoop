// Fake Claude Code CLI for adapter tests. It speaks the stream-json control protocol the pinned SDK uses and
// never calls any model API. FAKE_CLAUDE_MODE selects the scripted behaviour; FAKE_CLAUDE_LOG records argv and
// the environment variable names (never values) this process received.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = name => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === `--${name}`) return args[index + 1] ?? "";
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return null;
};
const all = name => args.flatMap((arg, index) => arg === `--${name}` ? [args[index + 1] ?? ""] :
  arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : []);
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const settings = Object.assign({}, ...all("settings").map(value => { try { return JSON.parse(value); } catch { return {}; } }));
// Like the real CLI: bundled skills go with disableBundledSkills, the built-in plugin's stay; skillOverrides "off"
// hides bundled, built-in plugin and project `.claude/skills` skills but not skills of plugins passed in.
const BUNDLED_SKILLS = ["update-config", "simplify", "code-review"];
const BUILTIN_PLUGIN_SKILLS = ["doctor"];
const projectSkillsDir = join(process.cwd(), ".claude", "skills");
const projectSkills = (flag("setting-sources") ?? "").split(",").includes("project") && existsSync(projectSkillsDir)
  ? readdirSync(projectSkillsDir).filter(name => existsSync(join(projectSkillsDir, name, "SKILL.md"))).sort() : [];
const nativeSkills = [...(settings.disableBundledSkills === true ? [] : BUNDLED_SKILLS), ...BUILTIN_PLUGIN_SKILLS, ...projectSkills]
  .filter(name => settings.skillOverrides?.[name] !== "off");
// Plugin skills are reported as <plugin>:<skill>; a directory that does not load is an error entry.
const pluginDirs = [...all("plugin-dir"), ...all("plugin-dir-no-mcp")];
const plugins = [], pluginSkills = [], pluginErrors = [];
pluginDirs.forEach((dir, index) => {
  try {
    const { name } = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    plugins.push({ name, path: dir });
    for (const skill of readdirSync(join(dir, "skills"))) if (existsSync(join(dir, "skills", skill, "SKILL.md"))) pluginSkills.push(`${name}:${skill}`);
  } catch { pluginErrors.push({ plugin: `inline[${index}]`, type: "path-not-found", message: `not loaded: ${dir}`, path: dir }); }
});
// Like the real CLI with a claude.ai login: the account's connectors attach unless the setting or the variable is off.
const connectorsOff = process.env.ENABLE_CLAUDEAI_MCP_SERVERS === "false" || settings.disableClaudeAiConnectors === true;
const mcpServers = connectorsOff ? [] : [{ name: "claude.ai Fake Docs", status: "connected" }];
let initialized = false;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const resumed = flag("resume"), fixed = flag("session-id");
const sessionId = resumed ?? fixed ?? randomUUID();
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  pid: process.pid, argv: args, cwd: realpathSync(process.cwd()), envKeys: Object.keys(process.env).sort(), configDir,
  disableMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null, clientApp: process.env.CLAUDE_AGENT_SDK_CLIENT_APP ?? null,
  claudeAiConnectors: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
}) + "\n");

const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const sessions = join(configDir, "fake-sessions");
mkdirSync(sessions, { recursive: true });
const statePath = join(sessions, `${sessionId}.json`);
// Like the real CLI: the transcript lives under projects/<cwd with every non-alphanumeric character as "-">/<id>.jsonl,
// and its existence decides whether a fixed ID is taken or a resume finds the conversation.
const transcriptDir = join(configDir, "projects", realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, "-"));
const transcript = join(transcriptDir, `${sessionId}.jsonl`);
if (fixed && existsSync(transcript)) { process.stderr.write(`Session ID ${sessionId} is already in use\n`); process.exit(1); }
if (resumed && !existsSync(transcript)) { process.stderr.write(`No conversation found with session ID: ${resumed}\n`); process.exit(1); }
let total = resumed && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).total : 0;
let pending = null, current = null;

const assistant = (content, extra = {}) => out({ type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
  message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "claude-fake-1", content,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...extra });
// Like the real CLI 2.1.319: a result echoes the uuid of the prompt it answers; FAKE_CLAUDE_NO_ECHO=1 acts as an
// older producer that echoes nothing.
const echo = () => current && process.env.FAKE_CLAUDE_NO_ECHO !== "1" ? { user_message_uuid: current, user_message_uuids: [current] } : {};
const result = fields => out({ type: "result", duration_ms: 5, duration_api_ms: 4, num_turns: 1, stop_reason: "end_turn",
  total_cost_usd: total, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId, ...echo(), ...fields });
// FAKE_CLAUDE_QUEUED_NOTIFICATION=1: like a resumed real CLI holding a background-task notification queued after the
// previous Turn, it first answers that notification (no model call, no echo) and only then the prompt.
let notificationQueued = process.env.FAKE_CLAUDE_QUEUED_NOTIFICATION === "1";
const persist = () => {
  writeFileSync(statePath, JSON.stringify({ total }));
  mkdirSync(transcriptDir, { recursive: true });
  appendFileSync(transcript, JSON.stringify({ type: "fake-transcript-entry" }) + "\n");
};

// FAKE_CLAUDE_ANSWER_BLOCK=1: like the real CLI, the closing answer is first streamed as an assistant text block and then
// repeated as the result text.
const answerBlock = answer => { if (process.env.FAKE_CLAUDE_ANSWER_BLOCK === "1") assistant([{ type: "text", text: answer }]); };

function turn(message) {
  const text = typeof message.message?.content === "string" ? message.message.content : "";
  if (!initialized) {
    initialized = true;
    out({ type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId, cwd: realpathSync(process.cwd()),
      apiKeySource: "none", claude_code_version: "0.0.0-fake", tools: [], mcp_servers: mcpServers, model: "claude-fake-1",
      permissionMode: "bypassPermissions", slash_commands: [], output_style: "default",
      skills: [...nativeSkills, ...pluginSkills], plugins, ...(pluginErrors.length ? { plugin_errors: pluginErrors } : {}) });
  }
  if (notificationQueued) {
    notificationQueued = false;
    out({ type: "result", subtype: "success", is_error: false, result: "", duration_ms: 1, duration_api_ms: 0, num_turns: 0,
      stop_reason: null, total_cost_usd: total, modelUsage: {}, permission_denials: [], origin: { kind: "task-notification" },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      uuid: randomUUID(), session_id: sessionId });
  }
  current = message.uuid ?? null;
  persist();
  if (mode === "crash") process.exit(3);
  if (mode === "hang") { assistant([{ type: "text", text: "Working on it" }]); pending = message; return; }
  if (mode === "auth") {
    assistant([{ type: "text", text: "API Error: 401 /private/credential/path" }], { error: "authentication_failed" });
    result({ subtype: "success", is_error: true, result: "API Error: 401 /private/credential/path", api_error_status: 401 });
    return;
  }
  if (mode === "budget") { total += 0.5; persist(); result({ subtype: "error_max_budget_usd", is_error: true, errors: ["budget reached in /private/work"] }); return; }
  if (mode === "context") { result({ subtype: "error_during_execution", is_error: true, terminal_reason: "prompt_too_long", errors: ["Prompt is too long"] }); return; }
  if (mode === "thinking") {
    // Like a real Turn with summarized thinking: readable thinking, an omitted (empty) block and a redacted one.
    // The cumulative thinking total grows by 40 per Turn and is reported per model, like the CLI's modelUsage.
    assistant([{ type: "thinking", thinking: "Plan: read the task first.", signature: "sig-private" }]);
    assistant([{ type: "text", text: "Reading the task" }]);
    assistant([{ type: "thinking", thinking: "", signature: "sig-omitted" }, { type: "redacted_thinking", data: "encrypted-private" }]);
    assistant([{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Read", input: { file_path: "/private/secret.txt" } }]);
    total += 0.01;
    persist();
    const thinkingTokens = Math.round(total * 100) * 40;
    answerBlock(`done: ${text.slice(0, 60)}`);
    result({ subtype: "success", is_error: false, result: `done: ${text.slice(0, 60)}`, terminal_reason: "completed",
      modelUsage: { "claude-fake-1": { inputTokens: 10, outputTokens: 5 + thinkingTokens, thinkingTokens, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: total, contextWindow: 200000, maxOutputTokens: 32000 } } });
    return;
  }
  assistant([{ type: "text", text: "Reading the task" }]);
  assistant([{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Read", input: { file_path: "/private/secret.txt" } }]);
  // A subagent answers under its own model: its assistant messages carry the parent tool use and a different model ID.
  if (process.env.FAKE_CLAUDE_SUBAGENT === "1")
    out({ type: "assistant", parent_tool_use_id: "toolu_subagent", uuid: randomUUID(), session_id: sessionId,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "claude-haiku-fake-1", content: [{ type: "text", text: "child" }],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  total += 0.01;
  persist();
  answerBlock(`done: ${text.slice(0, 60)}`);
  result({ subtype: "success", is_error: false, result: `done: ${text.slice(0, 60)}`, terminal_reason: "completed" });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    const reply = response => out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    if (subtype === "initialize") {
      if (process.env.FAKE_CLAUDE_LOG) appendFileSync(`${process.env.FAKE_CLAUDE_LOG}.init`, JSON.stringify({ pid: process.pid,
        skills: message.request.skills ?? null, appendSystemPrompt: message.request.appendSystemPrompt ?? null,
        systemPromptSnapshot: message.request.systemPromptSnapshot ?? null }) + "\n");
      reply({ commands: [], agents: [], output_style: "default", available_output_styles: [], account: {},
        models: [
          { value: "claude-fake-1", displayName: "Fake One", description: "fake", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
          { value: "not a model id!", displayName: "Bad", description: "rejected by the adapter" },
        ] });
      return;
    }
    reply({});
    if (subtype === "interrupt" && pending) {
      pending = null;
      result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: [] });
    }
    return;
  }
  if (message.type === "user") turn(message);
});
// FAKE_CLAUDE_LINGER_MS keeps the process alive after stdin closes, like a CLI still flushing after its result or
// waiting on a tool shell. FAKE_CLAUDE_IGNORE_SIGTERM makes it ignore SIGTERM, so only SIGKILL stops it.
lines.on("close", () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_LINGER_MS ?? 0)));
if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => undefined);
