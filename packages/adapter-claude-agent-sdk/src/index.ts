import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { query, type Options, type Query, type SDKAssistantMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NativeWorkspacePage, NativeWorkspaceReadOptions } from "@evoloop/contracts/session-timeline";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimeCapabilities, RuntimeEvent, RuntimeHistoryItem,
  RuntimeModelList, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeSkillPlan, RuntimeTurn } from "@evoloop/contracts/runtime";
import { ownerOf, RuntimeLocalBusyError, RuntimeNotSentError, RuntimeProtocolError, RuntimeUnknownError } from "@evoloop/contracts/runtime";
import type { ExecutionProfileSnapshot } from "@evoloop/contracts/session-recovery";
import { classifyResult, failure, thinkingTokensOf, turnCost, turnThinking, usageOf, usd, type ObservedResult } from "./classify.js";
import { readLedgerWorkspace } from "./workspace.js";
import { observeInit, planSkillsOf, readInstructions, skillSettingsOf, verifySkillPlan, type ContextMode, type TurnContext } from "./context.js";
import { TurnLedger, type LedgerTurn, type LedgerView, type TurnSettlement } from "./ledger.js";
import { signalGroup, spawnClaudeProcess } from "./process.js";

export { classifyResult, thinkingTokensOf, turnCost, turnThinking, usageOf } from "./classify.js";
export { CLAUDE_BUILTIN_PLUGIN_SKILLS, MAX_INSTRUCTION_BYTES, planSkillsOf, skillPlanHash, skillPluginManifest, skillSettingsOf,
  validSkillPlan, verifySkillPlan, type ContextMode } from "./context.js";
export { TurnLedger } from "./ledger.js";

const OWNER = ownerOf("claude");
const PAGE = 100;
const CLIENT_APP = "evoloop/0.1.0";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/**
 * Tools with no evoLoop surface, or whose effect outlives the per-Turn process: a question nobody can answer,
 * schedules and remote triggers the coordinator does not own, and notifications outside the workbench.
 */
export const DEFAULT_DISALLOWED_TOOLS = ["AskUserQuestion", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "RemoteTrigger", "PushNotification", "SendMessage", "ListAgents"] as const;
/**
 * Flag-layer settings for every child. The CLI binds a local messaging socket per process and, when
 * `crossSessionInbound` is unset, delivers a peer message that claims the same (bypass) permission class
 * straight into the running Turn. evoLoop Session messages are authorized by grants in PostgreSQL, so the
 * native channel stays closed in both directions (SendMessage/ListAgents are disallowed above).
 * With a claude.ai login the CLI also attaches the account's connectors as MCP servers (seen once on CLI 2.1.319
 * with the dedicated login); under bypassPermissions their tools would act on the account outside evoLoop's grants.
 * The setting turns that off, and ENABLE_CLAUDEAI_MCP_SERVERS=false in the child environment repeats it.
 */
export const CHILD_SETTINGS = { crossSessionInbound: "refuse", disableClaudeAiConnectors: true } as const;
// The child must not inherit coordinator secrets or Node flags. Claude credentials pass only by these names
// and are read by the CLI; the adapter never logs or stores them.
const CHILD_ENV_KEYS = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  // Operator bound on API retries. With the CLI default a rejected credential kept a Turn retrying for
  // minutes without a result (CLI 2.1.319 against a mock API); a low value settles it as authentication_failed.
  "CLAUDE_CODE_MAX_RETRIES",
] as const;
const FORCED_ENV = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_AGENT_SDK_CLIENT_APP", "ENABLE_CLAUDEAI_MCP_SERVERS", "NODE_OPTIONS"]);

export interface ClaudeAgentSdkAdapterOptions {
  /** Dedicated CLAUDE_CONFIG_DIR for every child (login, settings, transcripts); also holds the Turn ledger. */
  configDir: string;
  /** Claude Code executable; absent uses the one bundled with the pinned SDK. */
  executable?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Source for the allowlisted child variables; defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
  /** Further variable names passed to the child, such as a cloud-provider selection. */
  envPassthrough?: readonly string[];
  /** Trusted project-store check before a persisted binding is accepted again. */
  verifyBinding?: (binding: RuntimeBinding) => Promise<boolean>;
  disallowedTools?: readonly string[];
  /** How long the child may take to accept the prompt before the start is withdrawn as not sent. */
  startTimeoutMs?: number;
  /**
   * How long a Turn's process may keep running after its result is settled (default 5000). The CLI normally exits
   * once its prompt stream closes, but a tool it still waits on can keep it alive; past this bound the adapter
   * sends SIGTERM to its process group (the CLI then stops its own tool shells), and SIGKILL after the same bound again.
   */
  exitGraceMs?: number;
  /**
   * How many Turns this adapter runs at once across all Sessions (default 4); each Turn is one Claude Code process.
   * A start past the limit is refused as locally busy, so the caller retries it instead of failing it.
   */
  maxConcurrentTurns?: number;
  /**
   * The Role's skill plan, resolved before each Turn. Its plugins are loaded as local plugins (MCP discovery off)
   * and the skills it turns off, plus the bundled ones when it has no built-ins, are switched off in the CLI
   * settings. Null or absent keeps the CLI's own discovery. A plan that cannot be resolved or whose plugin
   * directories no longer match it stops the Turn before it is sent.
   */
  skillPlan?: (binding: RuntimeBinding) => Promise<RuntimeSkillPlan | null>;
  /**
   * project (default): the CLI reads the cwd's project settings: CLAUDE.md (AGENTS.md when there is none), `.claude/`
   * skills, agents, commands and hooks, which it runs. explicit: it reads none of them and the adapter passes the
   * cwd's AGENTS.md (else CLAUDE.md) itself.
   */
  contextMode?: ContextMode;
  now?: () => Date;
}

interface LiveTurn {
  projectId: string; nativeSessionId: string; turnId: string;
  controller: AbortController;
  query: Query | null;
  child: ChildProcess | null;
  /** The user message reached the child's stdin; from here the Turn may have started. */
  sent: boolean;
  /** Set once the start is withdrawn; any later user-message write is suppressed. */
  blocked: boolean;
  onSent: (() => void) | null;
  interruptRequested: boolean;
  closing: boolean;
  context: TurnContext;
  /** The init report was recorded; later re-emitted inits are ignored. */
  observed: boolean;
  assistantError: string | null;
  /** The exact model ID the main thread's assistant messages carried (the last one), and the IDs a subagent's messages carried. */
  observedModel: string | null;
  subagentModels: Set<string>;
  previousCumulative: number | null;
  previousThinking: number | null;
  settled: boolean;
  release: () => void;
  done: Promise<void>;
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fullProfile = (value: { sandbox: string; approvalPolicy: string }): boolean =>
  value.sandbox === "danger-full-access" && value.approvalPolicy === "never";
const safeModel = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:[\]-]{0,99}$/.test(value) ? value : null;
const sameBinding = (a: RuntimeBinding, b: RuntimeBinding): boolean =>
  (["sessionId", "roleId", "projectId", "nativeThreadId", "nativeSessionId", "cwd", "authorizationScope", "owner"] as const).every(key => a[key] === b[key]) &&
  (["actorId", "model", "reasoningEffort", "sandbox", "approvalPolicy", "executionProfileRevisionId"] as const).every(key =>
    (a.resumeProfile?.[key] ?? null) === (b.resumeProfile?.[key] ?? null));
/** Same session and profile except the effort and the execution profile revision that carries it. */
const effortRevisionOnly = (a: RuntimeBinding, b: RuntimeBinding): boolean =>
  (["sessionId", "roleId", "projectId", "nativeThreadId", "nativeSessionId", "cwd", "authorizationScope", "owner"] as const).every(key => a[key] === b[key]) &&
  (["actorId", "model", "sandbox", "approvalPolicy"] as const).every(key => (a.resumeProfile?.[key] ?? null) === (b.resumeProfile?.[key] ?? null));
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out")), ms);
  promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
});
const settledWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  withTimeout(promise.then(() => true, () => true), ms).catch(() => false);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Claude Agent SDK adapter.
 *
 * One Claude Code process serves one Turn: the adapter starts it with the Session's fixed native ID
 * (`sessionId` for the first Turn, `resume` afterwards) and keeps the prompt stream open until the Turn's
 * result arrives so an interrupt can still reach it. Every Turn is recorded in the adapter-owned ledger
 * before any process starts; listTurns/listItems read that ledger. DEC-033: every Turn runs with full
 * access and no approval prompts (`bypassPermissions`).
 */
export class ClaudeAgentSdkAdapter implements RuntimePort {
  private readonly ledger: TurnLedger;
  private readonly configDir: string;
  private readonly childEnv: Record<string, string>;
  private readonly bindings = new Map<string, RuntimeBinding>();
  private readonly live = new Map<string, LiveTurn>();
  private readonly attempted = new Set<string>();
  /** Fresh ordinary-conversation admissions, keyed like live Turns; consumed by the next start. */
  private readonly conversationQualifications = new Map<string, { fingerprint: string; observedAt: number }>();
  private readonly conversationInFlight = new Set<string>();
  private readonly disconnects = new Set<(reason: string) => void>();
  private modelCache: { value: RuntimeModelList; expiresAt: number } | null = null;
  private ready = false;
  private closed = false;

  constructor(private readonly options: ClaudeAgentSdkAdapterOptions) {
    if (!isAbsolute(options.configDir) || resolve(options.configDir) !== options.configDir)
      throw new RuntimeProtocolError("Claude configDir must be an absolute normalized path");
    if (options.executable !== undefined && !isAbsolute(options.executable))
      throw new RuntimeProtocolError("Claude executable must be an absolute path");
    if (options.contextMode !== undefined && options.contextMode !== "project" && options.contextMode !== "explicit")
      throw new RuntimeProtocolError("Claude context mode must be project or explicit");
    if (options.exitGraceMs !== undefined && !(Number.isFinite(options.exitGraceMs) && options.exitGraceMs > 0))
      throw new RuntimeProtocolError("Claude exit grace must be a positive number of milliseconds");
    for (const name of options.envPassthrough ?? [])
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || FORCED_ENV.has(name))
        throw new RuntimeProtocolError(`environment variable ${name} cannot be passed to Claude`);
    this.configDir = options.configDir;
    this.ledger = new TurnLedger(join(options.configDir, "evoloop-ledger"));
    const source = options.environment ?? process.env;
    const env: Record<string, string> = {};
    for (const key of [...CHILD_ENV_KEYS, ...(options.envPassthrough ?? [])]) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
    env.CLAUDE_CONFIG_DIR = options.configDir;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    this.childEnv = env;
  }

  /** One process per Turn, ledger-backed history, adapter-owned archive. */
  capabilities(): RuntimeCapabilities {
    return {
      provider: "claude", process: "per_turn",
      delivery: { midTurnInput: false, idleTurnStart: false, callerAssignedTurnKey: false,
        callerAssignedSessionId: true },
      errors: { notSent: true, rejected: false },
      compaction: { autoCompacts: true, mode: "unavailable" },
      history: { workTrace: false, workspace: true },
      naming: false, archive: "adapter_ledger", nativeInput: false, executionProfileActivation: false,
      modelList: true, usage: "per_turn", cost: true,
    };
  }

  async open(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    this.closed = false;
    this.ready = true;
  }
  isReady(): boolean { return this.ready && !this.closed; }
  onDisconnect(listener: (reason: string) => void): () => void { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }
  onEvent(_listener: (event: RuntimeEvent) => void): () => void { return () => undefined; }
  /** bypassPermissions never asks; there is no approval stream to subscribe to. */
  onApprovalRequest(_listener: (request: RuntimeApprovalRequest) => void | Promise<void>): () => void { return () => undefined; }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private key(binding: RuntimeBinding): string { return `${binding.projectId}/${binding.nativeSessionId}`; }

  private validateBinding(binding: RuntimeBinding): void {
    if (binding.owner !== OWNER || !nonempty(binding.authorizationScope) || !nonempty(binding.projectId) ||
      !nonempty(binding.roleId) || !nonempty(binding.sessionId) || !uuid(binding.nativeSessionId) ||
      binding.nativeThreadId !== binding.nativeSessionId || !isAbsolute(binding.cwd) || resolve(binding.cwd) !== binding.cwd)
      throw new RuntimeProtocolError("invalid runtime binding");
  }
  private remember(binding: RuntimeBinding, replaceEffortRevision = false): void {
    this.validateBinding(binding);
    const existing = this.bindings.get(binding.nativeThreadId);
    if (existing && !sameBinding(existing, binding) && !(replaceEffortRevision && effortRevisionOnly(existing, binding)))
      throw new RuntimeProtocolError("conflicting runtime binding");
    this.bindings.set(binding.nativeThreadId, binding);
  }
  private owned(binding: RuntimeBinding): void {
    const saved = this.bindings.get(binding.nativeThreadId);
    if (!saved || !sameBinding(saved, binding)) throw new RuntimeProtocolError("thread is not registered to this adapter and scope");
    if (!this.isReady()) throw new RuntimeNotSentError("thread", "Claude runtime not ready");
  }

  /** Re-register only a binding verified against the trusted project store. */
  async registerBinding(binding: RuntimeBinding): Promise<void> {
    this.validateBinding(binding);
    if (!this.options.verifyBinding || !await this.options.verifyBinding(binding)) throw new RuntimeProtocolError("binding provenance not verified");
    // The trusted store has confirmed it: a revision that changed only the effort replaces the registered one (effort travels with each query).
    this.remember(binding, true);
  }
  /** Claude takes the effort with every query, so an effort-only revision needs no native activation: it applies from the next Turn. */
  appliesEffortWithNextTurn(_binding: RuntimeBinding): boolean { return true; }
  /** The effort levels Claude takes: its own set, which has no `none` or `minimal`. */
  allowedReasoningEfforts(_binding: RuntimeBinding): readonly string[] { return [...EFFORTS]; }

  /** Records the Session in the ledger. Claude creates its native session with the first Turn, under this ID. */
  async create(spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    if (!this.isReady()) throw new RuntimeProtocolError("Claude runtime not ready");
    if (!nonempty(spec.sessionId) || !nonempty(spec.roleId) || !nonempty(spec.projectId) || !nonempty(spec.authorizationScope) ||
      !isAbsolute(spec.cwd) || resolve(spec.cwd) !== spec.cwd) throw new RuntimeProtocolError("invalid session scope or cwd");
    if (!fullProfile(spec)) throw new RuntimeProtocolError("new Session requires danger-full-access and approval never");
    if (spec.reasoningEffort != null) throw new RuntimeProtocolError("reasoning effort can only be set by execution profile activation");
    if (spec.model != null && safeModel(spec.model) === null) throw new RuntimeProtocolError("invalid model identity");
    const nativeId = randomUUID();
    await this.ledger.append(spec.projectId, nativeId, { kind: "session", at: this.now(), projectId: spec.projectId,
      sessionId: spec.sessionId, nativeSessionId: nativeId, cwd: spec.cwd });
    const binding: RuntimeBinding = {
      sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId, authorizationScope: spec.authorizationScope,
      cwd: spec.cwd, nativeThreadId: nativeId, nativeSessionId: nativeId, owner: OWNER,
      // Nothing native has acknowledged a model or provider yet.
      observedModel: null, observedProvider: null,
      ...(spec.actorId ? { resumeProfile: { actorId: spec.actorId, model: spec.model ?? null, sandbox: spec.sandbox,
        approvalPolicy: spec.approvalPolicy, ...(spec.executionProfileRevisionId ? { executionProfileRevisionId: spec.executionProfileRevisionId } : {}) } } : {}),
    };
    this.remember(binding);
    return binding;
  }

  /** Local profile check only: each Turn starts its own process with the binding's exact profile. */
  async resume(binding: RuntimeBinding, spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    this.owned(binding);
    if (!spec || !nonempty(spec.actorId) || spec.sessionId !== binding.sessionId || spec.roleId !== binding.roleId ||
      spec.projectId !== binding.projectId || spec.authorizationScope !== binding.authorizationScope || spec.cwd !== binding.cwd ||
      !fullProfile(spec) || !binding.resumeProfile || binding.resumeProfile.actorId !== spec.actorId ||
      binding.resumeProfile.model !== (spec.model ?? null) ||
      (binding.resumeProfile.reasoningEffort ?? null) !== (spec.reasoningEffort ?? null) ||
      binding.resumeProfile.sandbox !== spec.sandbox || binding.resumeProfile.approvalPolicy !== spec.approvalPolicy ||
      (binding.resumeProfile.executionProfileRevisionId ?? null) !== (spec.executionProfileRevisionId ?? null))
      throw new RuntimeProtocolError("resume profile does not match registered binding");
    await this.view(binding);
    return binding;
  }

  /** Ledger read for an owned binding; orphaned Turns whose process is gone are settled once, durably. */
  private async view(binding: RuntimeBinding): Promise<LedgerView> {
    const view = await this.ledger.read(binding.projectId, binding.nativeSessionId);
    const session = view.session;
    if (!session || session.projectId !== binding.projectId || session.sessionId !== binding.sessionId ||
      session.nativeSessionId !== binding.nativeSessionId || session.cwd !== binding.cwd)
      throw new RuntimeProtocolError("Claude Session ledger does not match the binding");
    const live = this.live.get(this.key(binding));
    for (const turn of view.turns) {
      if (turn.withdrawn || turn.settled || turn.turnId === live?.turnId) continue;
      if (turn.pid !== null && alive(turn.pid)) continue;
      // The process that owned this Turn is gone and left no result here. Never inferred as completed.
      const settlement: TurnSettlement = { status: "failed", completedAtUtc: this.now(), usage: null, costUsd: null,
        cumulativeCostUsd: null, source: "orphan",
        error: failure("native_failure", "process_lost", null, "The Claude Turn process ended without a recorded result") };
      await this.ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.settled", at: this.now(), turnId: turn.turnId, ...settlement });
      turn.settled = settlement;
    }
    return view;
  }

  private visible(binding: RuntimeBinding, view: LedgerView): LedgerTurn[] {
    const live = this.live.get(this.key(binding));
    // A start that has not reached the child yet may still be withdrawn; it is not history.
    return view.turns.filter(turn => !turn.withdrawn && !(live && live.turnId === turn.turnId && !live.sent));
  }

  private turnOf(binding: RuntimeBinding, turn: LedgerTurn): RuntimeTurn {
    const settled = turn.settled;
    const observed = turn.capabilities ? { observedCapabilities: turn.capabilities } : {};
    if (settled) return { id: turn.turnId, status: settled.status, completedAtUtc: settled.completedAtUtc,
      ...(settled.error ? { error: settled.error } : {}), usage: settled.usage, costUsd: settled.costUsd,
      ...(settled.observedModel !== undefined ? { observedModel: settled.observedModel } : {}),
      ...(settled.subagentModels?.length ? { subagentModels: settled.subagentModels } : {}), ...observed };
    const live = this.live.get(this.key(binding));
    // An unsettled Turn whose process outlived this adapter instance is not known to be running here.
    return { id: turn.turnId, status: live?.turnId === turn.turnId ? "inProgress" : "unknown", completedAtUtc: null, ...observed };
  }

  /** Resolves and checks what this Turn is given besides its prompt. Throws only before anything is recorded. */
  private async turnContext(binding: RuntimeBinding): Promise<TurnContext> {
    const mode = this.options.contextMode ?? "project";
    let plan: RuntimeSkillPlan | null;
    try { plan = this.options.skillPlan ? await this.options.skillPlan(binding) : null; }
    catch { throw new RuntimeNotSentError("turn/start", "Role skills could not be prepared"); }
    if (plan && !await verifySkillPlan(plan))
      throw new RuntimeNotSentError("turn/start", "Role skill plugins do not match their plan");
    let instructions: TurnContext["instructions"] = null;
    if (mode === "explicit") {
      try { instructions = await readInstructions(binding.cwd); }
      catch { throw new RuntimeNotSentError("turn/start", "project instructions could not be read"); }
    }
    return { mode, plan, allowedSkills: plan ? planSkillsOf(plan) : null, instructions };
  }

  async inspect(binding: RuntimeBinding): Promise<unknown> {
    this.owned(binding);
    const view = await this.view(binding);
    const active = this.visible(binding, view).some(turn => !turn.settled);
    return { thread: { id: binding.nativeThreadId, sessionId: binding.nativeSessionId, cwd: binding.cwd,
      status: { type: active ? "active" : "idle" } }, provider: "claude", archived: view.archived };
  }

  /** Newest first, like the Codex history list. */
  async listTurns(binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>> {
    this.owned(binding);
    const turns = this.visible(binding, await this.view(binding)).reverse();
    const offset = this.offset(cursor);
    return { data: turns.slice(offset, offset + PAGE).map(turn => this.turnOf(binding, turn)),
      nextCursor: offset + PAGE < turns.length ? String(offset + PAGE) : null };
  }

  async listItems(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimePage<unknown>> {
    this.owned(binding);
    const turn = this.visible(binding, await this.view(binding)).find(candidate => candidate.turnId === turnId);
    if (!turn) throw new RuntimeProtocolError("Turn is not in this Session's history");
    const items: RuntimeHistoryItem[] = [{ id: turn.turnId, type: "userMessage", content: [{ type: "text", text: turn.input }] }, ...turn.items];
    const offset = this.offset(cursor);
    return { data: items.slice(offset, offset + PAGE), nextCursor: offset + PAGE < items.length ? String(offset + PAGE) : null };
  }

  /** Timeline history from the adapter ledger: inputs, replies, tool calls and thinking per Turn, with per-Turn usage. */
  async readWorkspaceHistory(binding: RuntimeBinding, options: NativeWorkspaceReadOptions = {}): Promise<NativeWorkspacePage> {
    this.owned(binding);
    const view = await this.view(binding);
    const live = this.live.get(this.key(binding));
    return readLedgerWorkspace(binding, this.visible(binding, view), options, this.now(),
      turnId => live?.turnId === turnId && !live.settled);
  }

  private offset(cursor?: string): number {
    if (cursor === undefined) return 0;
    if (!/^[1-9][0-9]{0,8}$/.test(cursor)) throw new RuntimeProtocolError("invalid history cursor");
    return Number(cursor);
  }

  private checkProfile(binding: RuntimeBinding, executionProfile?: ExecutionProfileSnapshot | null): string | null {
    const profile = binding.resumeProfile;
    if (profile?.executionProfileRevisionId) {
      if (!executionProfile || executionProfile.revisionId !== profile.executionProfileRevisionId ||
        executionProfile.model !== profile.model || executionProfile.sandbox !== profile.sandbox ||
        (executionProfile.reasoningEffort ?? null) !== (profile.reasoningEffort ?? null) ||
        executionProfile.approvalPolicy !== profile.approvalPolicy ||
        executionProfile.cwd !== binding.cwd || executionProfile.authorizationScope !== binding.authorizationScope)
        throw new RuntimeProtocolError("Run does not carry this exact immutable execution profile");
    }
    return this.profileEffort(binding);
  }

  /** The binding's own fixed profile: full access, a safe model and an effort Claude supports. */
  private profileEffort(binding: RuntimeBinding): string | null {
    const profile = binding.resumeProfile;
    if (!profile || !fullProfile(profile)) throw new RuntimeProtocolError("business Turn requires an active full execution profile");
    if (profile.model != null && safeModel(profile.model) === null) throw new RuntimeProtocolError("invalid model identity");
    const effort = profile.reasoningEffort ?? null;
    if (effort !== null && !EFFORTS.has(effort)) throw new RuntimeProtocolError("reasoning effort is not supported by Claude");
    return effort;
  }

  async startTurn(binding: RuntimeBinding, input: string, operationId: string,
    executionProfile?: ExecutionProfileSnapshot | null): Promise<RuntimeTurn> {
    this.owned(binding);
    return this.begin(binding, input, operationId, this.checkProfile(binding, executionProfile));
  }

  /**
   * Admission evidence for an ordinary Session message: an owned full-profile Session whose ledger is readable,
   * not archived and has no running or unsettled Turn. The exact profile is sent with the Turn itself.
   */
  async qualifyConversationThread(binding: RuntimeBinding): Promise<{ available: boolean; reason: string; fingerprint: string | null }> {
    this.owned(binding);
    const key = this.key(binding);
    const unavailable = (reason: string) => {
      this.conversationQualifications.delete(key);
      return { available: false, reason, fingerprint: null };
    };
    const profile = binding.resumeProfile;
    if (!profile || !fullProfile(profile)) return unavailable("Owned Session has no active full execution profile");
    try { this.profileEffort(binding); } catch { return unavailable("Owned Session profile is not supported by Claude"); }
    let view: LedgerView;
    try { view = await this.view(binding); } catch { return unavailable("Claude Session ledger could not be read"); }
    if (view.archived) return unavailable("Claude Session is archived");
    // A settled Turn whose process is only exiting is not running: the next start waits for that exit, bounded.
    const running = this.live.get(key);
    if ((running && !running.settled) || view.turns.some(turn => !turn.withdrawn && !turn.settled))
      return unavailable("A Claude Turn is running on this Session");
    const latest = view.turns.filter(turn => !turn.withdrawn).at(-1) ?? null;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      admission: "evoloop-claude-conversation-v1", projectId: binding.projectId, sessionId: binding.sessionId, roleId: binding.roleId,
      nativeSessionId: binding.nativeSessionId, cwd: binding.cwd, scope: binding.authorizationScope,
      profile: { actorId: profile.actorId, model: profile.model ?? null, reasoningEffort: profile.reasoningEffort ?? null, sandbox: profile.sandbox,
        approvalPolicy: profile.approvalPolicy, executionProfileRevisionId: profile.executionProfileRevisionId ?? null },
      latestTurn: latest ? { id: latest.turnId, completedAtUtc: latest.settled?.completedAtUtc ?? null } : null,
    })).digest("hex");
    const prior = this.conversationQualifications.get(key);
    if (prior && Date.now() - prior.observedAt <= 5_000 && prior.fingerprint !== fingerprint)
      return unavailable("Owned Session profile or history changed during admission");
    this.conversationQualifications.set(key, { fingerprint, observedAt: Date.now() });
    return { available: true, reason: "Owned full-profile Claude Session has no running Turn; the exact profile is sent with the Turn", fingerprint };
  }

  /** The caller first persists the ordinary message dispatch; one operation gets one native start. */
  async startConversationTurn(binding: RuntimeBinding, input: string, operationId: string): Promise<RuntimeTurn> {
    this.owned(binding);
    if (!nonempty(input) || !nonempty(operationId) || !binding.resumeProfile || !fullProfile(binding.resumeProfile))
      throw new RuntimeProtocolError("full Session profile, input and durable operation ID required");
    const key = this.key(binding);
    const prior = this.conversationQualifications.get(key);
    if (!prior || Date.now() - prior.observedAt > 5_000) throw new RuntimeProtocolError("ordinary Turn requires fresh owned full-profile admission");
    if (this.conversationInFlight.has(key)) throw new RuntimeProtocolError("ordinary Turn start is already in flight on this Session");
    this.conversationInFlight.add(key);
    try {
      const rechecked = await this.qualifyConversationThread(binding);
      if (!rechecked.available || rechecked.fingerprint !== prior.fingerprint)
        throw new RuntimeProtocolError("owned full-profile Session changed before ordinary Turn");
      this.conversationQualifications.delete(key);
      return await this.begin(binding, input, operationId, this.profileEffort(binding));
    } finally {
      // A changed readback must not leave an implicit admission for another start.
      this.conversationQualifications.delete(key);
      this.conversationInFlight.delete(key);
    }
  }

  /** Whether Claude already wrote this Session's transcript under the dedicated config directory. */
  private async transcriptExists(nativeSessionId: string): Promise<boolean> {
    const projects = join(this.configDir, "projects");
    let entries: string[];
    try { entries = await readdir(projects); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      try { await access(join(projects, entry, `${nativeSessionId}.jsonl`)); return true; }
      catch { /* not in this project directory */ }
    }
    return false;
  }

  private async begin(binding: RuntimeBinding, input: string, operationId: string, effort: string | null): Promise<RuntimeTurn> {
    if (!nonempty(input) || !nonempty(operationId)) throw new RuntimeProtocolError("input and durable operation ID required");
    const key = this.key(binding), attempt = `${key}/${operationId}`;
    if (this.attempted.has(attempt)) throw new RuntimeProtocolError("this Turn operation was already attempted; reconcile its original result");
    const previous = this.live.get(key);
    if (previous?.settled) {
      // The previous Turn is already settled in the ledger and its process is only exiting. Wait for it (bounded)
      // instead of refusing, but never let two processes write the same transcript.
      if (!await settledWithin(previous.done, this.exitGraceMs()) && previous.child) {
        signalGroup(previous.child, "SIGTERM");
        await settledWithin(previous.done, this.exitGraceMs());
      }
      // Re-checked after the wait, in the same synchronous step that registers this start.
      if (this.attempted.has(attempt)) throw new RuntimeProtocolError("this Turn operation was already attempted; reconcile its original result");
    }
    // Both refusals are transient and happen before this start is registered or anything is written, so the caller
    // keeps its durable intent and retries once a slot frees: a queued message stays queued with its recovery gate
    // open, a Run returns to requested. Raising a plain "not sent" here made an ordinary message fail for good.
    if (this.live.has(key)) throw new RuntimeLocalBusyError("turn/start", "another Turn is running on this Session");
    if (this.live.size >= (this.options.maxConcurrentTurns ?? 4)) throw new RuntimeLocalBusyError("turn/start", "concurrent Turn limit reached");
    let release!: () => void;
    const released = new Promise<void>(resolveRelease => { release = resolveRelease; });
    const live: LiveTurn = { projectId: binding.projectId, nativeSessionId: binding.nativeSessionId, turnId: randomUUID(),
      controller: new AbortController(), query: null, child: null, sent: false, blocked: false, onSent: null,
      interruptRequested: false, closing: false, assistantError: null, observedModel: null, subagentModels: new Set<string>(), previousCumulative: null, previousThinking: null, settled: false,
      context: { mode: this.options.contextMode ?? "project", plan: null, allowedSkills: null, instructions: null }, observed: false,
      release, done: Promise.resolve() };
    // Registered before any await so a concurrent read never mistakes this start for an orphan.
    this.live.set(key, live);
    this.attempted.add(attempt);
    let keep = false;
    try {
      let view: LedgerView;
      try { view = await this.view(binding); }
      catch (error) {
        if (error instanceof RuntimeProtocolError) throw error;
        throw new RuntimeNotSentError("turn/start", "Turn ledger unavailable");
      }
      if (view.archived) throw new RuntimeProtocolError("Session is archived");
      if (view.turns.some(turn => turn.operationId === operationId && !turn.withdrawn))
        throw new RuntimeProtocolError("this Turn operation was already attempted; reconcile its original result");
      if (view.turns.some(turn => !turn.withdrawn && !turn.settled && turn.turnId !== live.turnId))
        throw new RuntimeNotSentError("turn/start", "an earlier Turn process is still running");
      live.context = await this.turnContext(binding);
      const prior = view.turns.filter(turn => !turn.withdrawn);
      // Resume only when the native transcript exists: Claude answered an earlier Turn, or an earlier prompt reached
      // a process that wrote the transcript before it was lost. Reusing the ID as a new session would be refused.
      let resume = prior.some(turn => turn.items.length > 0 || turn.settled?.source === "result");
      if (!resume && prior.some(turn => turn.sent)) {
        try { resume = await this.transcriptExists(binding.nativeSessionId); }
        catch { throw new RuntimeNotSentError("turn/start", "Claude transcript directory could not be read"); }
      }
      live.previousCumulative = resume ? prior.at(-1)?.settled?.cumulativeCostUsd ?? null : 0;
      live.previousThinking = resume ? prior.at(-1)?.settled?.cumulativeThinkingTokens ?? null : 0;
      try {
        await this.ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.started", at: this.now(),
          turnId: live.turnId, operationId, input, resume });
      } catch {
        await this.withdraw(binding, live, "ledger write failed").catch(() => undefined);
        throw new RuntimeNotSentError("turn/start", "Turn ledger write failed");
      }
      const message: SDKUserMessage = { type: "user", message: { role: "user", content: input }, parent_tool_use_id: null,
        uuid: live.turnId as NonNullable<SDKUserMessage["uuid"]>, session_id: binding.nativeSessionId };
      // The prompt stays open until the result arrives, so an interrupt can still reach the child.
      const prompt = async function* (): AsyncGenerator<SDKUserMessage> { yield message; await released; };
      let started = true;
      try {
        live.query = query({ prompt: prompt(), options: this.turnOptions(binding, live, resume, effort) });
        live.done = this.drive(binding, live);
      } catch {
        // query() spawns synchronously; the prompt is only written later by its input stream, so a synchronous
        // failure here (spawn refused, bad executable) cannot have delivered it.
        started = false;
        live.blocked = true;
        if (live.child) signalGroup(live.child, "SIGKILL");
        if (live.sent) {
          // Not reachable with the pinned SDK; if it ever is, the process outcome is unknown and later reads settle it.
          keep = true;
          this.live.delete(key);
          throw new RuntimeUnknownError("turn/start", null, "Claude process failed after the prompt was written");
        }
      }
      if (started && await this.accepted(live)) {
        keep = true;
        return { id: live.turnId, status: "inProgress", completedAtUtc: null };
      }
      live.controller.abort();
      if (!await settledWithin(live.done, 5_000) && live.child) signalGroup(live.child, "SIGKILL");
      try { await this.withdraw(binding, live, "prompt not accepted"); }
      catch {
        keep = true;
        throw new RuntimeUnknownError("turn/start", null, "withdrawal could not be recorded");
      }
      throw new RuntimeNotSentError("turn/start", "Claude process did not accept the prompt");
    } finally {
      if (!keep) this.attempted.delete(attempt);
      // An unsent start has no process left to own; a sent one is released by its drive loop.
      if (!live.sent && this.live.get(key) === live) this.live.delete(key);
    }
  }

  private withdraw(binding: RuntimeBinding, live: LiveTurn, reason: string): Promise<void> {
    return this.ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.withdrawn", at: this.now(), turnId: live.turnId, reason });
  }

  /** Resolves true once the prompt was written, false once it provably never will be. */
  private accepted(live: LiveTurn): Promise<boolean> {
    return new Promise(resolveAccepted => {
      const finish = () => {
        clearTimeout(timer);
        if (live.sent) { resolveAccepted(true); return; }
        live.blocked = true;
        resolveAccepted(false);
      };
      const timer = setTimeout(finish, this.options.startTimeoutMs ?? 60_000);
      live.onSent = finish;
      void live.done.then(finish, finish);
    });
  }

  private turnOptions(binding: RuntimeBinding, live: LiveTurn, resume: boolean, effort: string | null): Options {
    const model = binding.resumeProfile?.model ?? null;
    return {
      abortController: live.controller,
      cwd: binding.cwd,
      env: { ...this.childEnv },
      ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      spawnClaudeCodeProcess: spawnOptions => {
        const child = spawnClaudeProcess(spawnOptions, {
          beforeUserWrite: () => {
            if (live.blocked) return false;
            if (!live.sent) {
              live.sent = true;
              void this.ledger.append(live.projectId, live.nativeSessionId, { kind: "turn.sent", at: this.now(), turnId: live.turnId }).catch(() => undefined);
              live.onSent?.();
            }
            return true;
          },
          onPid: pid => {
            void this.ledger.append(live.projectId, live.nativeSessionId, { kind: "turn.process", at: this.now(), turnId: live.turnId, pid }).catch(() => undefined);
          },
        });
        live.child = child;
        return child;
      },
      ...(resume ? { resume: binding.nativeSessionId } : { sessionId: binding.nativeSessionId }),
      settingSources: live.context.mode === "explicit" ? [] : ["project"],
      // Plan plugins carry skills only; their MCP discovery stays off so a plugin can never add a server.
      ...(live.context.plan?.plugins.length ? { plugins: live.context.plan.plugins.map(plugin =>
        ({ type: "local" as const, path: plugin.root, skipMcpDiscovery: true })) } : {}),
      // Not recorded as a snapshot, so each Turn's request carries the instructions recorded for that Turn.
      ...(live.context.instructions ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const,
        append: live.context.instructions.text, snapshot: false } } : {}),
      settings: { ...CHILD_SETTINGS, ...(live.context.plan ? skillSettingsOf(live.context.plan) : {}) },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: [...(this.options.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS)],
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as NonNullable<Options["effort"]> } : {}),
      // Readable thinking: the CLI's default display can omit thinking text. This only selects the summarized text the
      // API returns; it does not turn thinking on or change its budget, so billed thinking tokens are unchanged.
      extraArgs: { "thinking-display": "summarized" },
      // By default the SDK forwards only a subagent's tool_use/tool_result blocks; its assistant messages (the ones that carry the model it answered
      // with) reach this adapter only with this option. A subagent that answers in plain text, without a tool call, was invisible: subagentModels
      // stayed empty. The adapter keeps only the model from those messages, never their content (see drive()).
      forwardSubagentText: true,
      ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
      ...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
    };
  }

  private async drive(binding: RuntimeBinding, live: LiveTurn): Promise<void> {
    try {
      for await (const message of live.query!) {
        if (message.type === "system" && message.subtype === "init") await this.observeCapabilities(live, message);
        else if (message.type === "assistant" && message.parent_tool_use_id === null) await this.observeAssistant(live, message);
        // A subagent's own messages carry the model it answered with; only its model is kept, never its content.
        else if (message.type === "assistant") { const child = safeModel((message as { message?: { model?: unknown } }).message?.model); if (child) live.subagentModels.add(child); }
        else if (message.type === "result" && !live.settled && live.sent && this.answers(live, message)) {
          await this.settle(live, this.fromResult(live, message as ObservedResult), message.subtype === "success" &&
            message.is_error !== true && typeof message.result === "string" && message.result.length > 0
            ? { id: message.uuid, text: message.result } : null);
          live.release();
          this.boundExit(live);
        }
      }
    } catch { /* the stream ended without a result; settled below */ }
    finally {
      live.release();
      if (live.sent && !live.settled) {
        const reason = live.closing ? "adapter_closed" : "process_lost";
        try {
          await this.settle(live, { status: live.interruptRequested ? "interrupted" : "failed", completedAtUtc: this.now(),
            usage: null, costUsd: null, cumulativeCostUsd: null, source: "process_exit",
            ...(live.interruptRequested ? {} : { error: failure("native_failure", reason, null, live.closing
              ? "The adapter closed while the Claude Turn was running" : "The Claude Turn process ended without a result") }) }, null);
        } catch { /* ledger unavailable: the unsettled Turn is reconciled as an orphan later */ }
      }
      if (live.child && live.child.exitCode === null && live.child.signalCode === null) signalGroup(live.child, "SIGTERM");
      if (live.sent && this.live.get(this.key(binding)) === live) this.live.delete(this.key(binding));
    }
  }

  /**
   * Whether a result answers this Turn's prompt, which is sent with the Turn ID as its uuid. The CLI echoes the
   * uuids of the prompts a result consumed. A resumed Session may first replay a background-task notification
   * queued after the previous Turn: that result has no echo, no model call and origin `task-notification`, and the
   * prompt is only processed after it. A producer that echoes nothing is trusted unless the result is such a
   * notification.
   */
  private answers(live: LiveTurn, message: SDKResultMessage): boolean {
    const echoed = [...message.user_message_uuids ?? [], ...message.user_message_uuid ? [message.user_message_uuid] : []];
    return echoed.length ? echoed.includes(live.turnId) : message.origin?.kind !== "task-notification";
  }

  private exitGraceMs(): number { return this.options.exitGraceMs ?? 5_000; }

  /**
   * After the result the process should exit on its own once the prompt stream closes. A tool it still waits on
   * (seen live: a shell that kept a settled Turn's CLI alive for minutes) must not keep it, and the Session, busy.
   */
  private boundExit(live: LiveTurn): void {
    const child = live.child;
    const exited = () => !child || child.exitCode !== null || child.signalCode !== null;
    if (exited()) return;
    const grace = this.exitGraceMs();
    let kill: NodeJS.Timeout | undefined;
    const term = setTimeout(() => {
      if (exited()) return;
      signalGroup(child!, "SIGTERM");
      kill = setTimeout(() => { if (!exited()) signalGroup(child!, "SIGKILL"); }, grace);
      kill.unref();
    }, grace);
    term.unref();
    child!.once("exit", () => { clearTimeout(term); if (kill) clearTimeout(kill); });
  }

  /** The first init report of the Turn process: what it actually loaded, next to what it was given. */
  private async observeCapabilities(live: LiveTurn, message: { skills?: unknown; plugins?: unknown; plugin_errors?: unknown }): Promise<void> {
    if (live.observed || live.settled) return;
    live.observed = true;
    try {
      await this.ledger.append(live.projectId, live.nativeSessionId, { kind: "turn.capabilities", at: this.now(), turnId: live.turnId,
        observed: observeInit(live.context, message, this.now()) });
    } catch { /* a missing observation reads as not observed; it never changes the Turn outcome */ }
  }

  private async observeAssistant(live: LiveTurn, message: SDKAssistantMessage): Promise<void> {
    if (typeof message.error === "string") { live.assistantError = message.error; return; } // synthetic API-error text is not recorded
    // The exact model the API answered with, from the native message itself (an alias such as "opus" in the configuration is resolved here).
    const answered = safeModel(message.message?.model);
    if (answered) live.observedModel = answered;
    const content: unknown[] = Array.isArray(message.message?.content) ? message.message.content : [];
    const items: RuntimeHistoryItem[] = [];
    content.forEach((block, index) => {
      const value = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; thinking?: unknown };
      // Thinking text exactly as Claude returned it. Omitted (empty) or redacted thinking is recorded as unreadable,
      // never filled in; the signature and redacted data are not stored.
      if (value.type === "thinking" || value.type === "redacted_thinking") items.push({ id: `${message.uuid}:${index}`, type: "reasoning",
        source: "thinking", text: value.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim() ? value.thinking : null,
        redacted: value.type === "redacted_thinking" });
      else if (value.type === "text" && nonempty(value.text)) items.push({ id: `${message.uuid}:${index}`, type: "agentMessage", text: value.text, phase: "commentary" });
      // Tool input can carry file contents or secrets; only the call identity is kept.
      else if (value.type === "tool_use" && nonempty(value.id)) items.push({ id: value.id, type: "toolCall", name: nonempty(value.name) ? value.name : null });
    });
    for (const item of items) {
      try { await this.ledger.append(live.projectId, live.nativeSessionId, { kind: "item", at: this.now(), turnId: live.turnId, item }); }
      catch { /* a missing progress item does not change the Turn outcome */ }
    }
  }

  private fromResult(live: LiveTurn, result: ObservedResult): TurnSettlement {
    const completedAtUtc = this.now();
    if (result.session_id !== live.nativeSessionId)
      return { status: "failed", completedAtUtc, usage: null, costUsd: null, cumulativeCostUsd: null, source: "result",
        error: failure("native_failure", "session_mismatch", null, "Claude answered under a different session") };
    const classified = classifyResult(result, { assistantError: live.assistantError, interruptRequested: live.interruptRequested });
    const cumulative = usd(result.total_cost_usd);
    const thinking = thinkingTokensOf(result.modelUsage);
    return { status: classified.status, completedAtUtc, usage: usageOf(result.usage),
      costUsd: turnCost(cumulative, live.previousCumulative), cumulativeCostUsd: cumulative,
      thinkingTokens: turnThinking(thinking, live.previousThinking), cumulativeThinkingTokens: thinking, source: "result",
      observedModel: live.observedModel, // A subagent that answered under the main Turn's own model is still a subagent that ran: its model is kept (the list is the set of models subagents
      // answered with, not "the ones that differ"), or the record would say no subagent was read exactly when the common case happened.
      subagentModels: [...live.subagentModels].sort(),
      ...(classified.status === "failed" ? { error: classified.error } : {}) };
  }

  private async settle(live: LiveTurn, settlement: TurnSettlement, answer: { id: string; text: string } | null): Promise<void> {
    if (answer && settlement.status === "completed")
      await this.ledger.append(live.projectId, live.nativeSessionId, { kind: "item", at: this.now(), turnId: live.turnId,
        item: { id: answer.id, type: "agentMessage", text: answer.text, phase: "final_answer" } });
    await this.ledger.append(live.projectId, live.nativeSessionId, { kind: "turn.settled", at: this.now(), turnId: live.turnId, ...settlement });
    live.settled = true;
  }

  /** Stop request only; the final ledger status is authoritative. */
  async interruptTurn(binding: RuntimeBinding, turnId: string): Promise<void> {
    this.owned(binding);
    const live = this.live.get(this.key(binding));
    if (!live || live.turnId !== turnId || !live.sent) throw new RuntimeProtocolError("Turn is not running in this adapter");
    if (live.settled) return;
    live.interruptRequested = true;
    try { await withTimeout(live.query!.interrupt(), 10_000); }
    catch { live.controller.abort(); }
  }

  /** Adapter-owned archive: durably refuses further Turns. The native transcript is kept. */
  async archiveThread(binding: RuntimeBinding): Promise<void> {
    this.owned(binding);
    if (this.live.has(this.key(binding))) throw new RuntimeProtocolError("cannot archive a Session with a running Turn");
    const view = await this.view(binding);
    if (view.turns.some(turn => !turn.withdrawn && !turn.settled)) throw new RuntimeProtocolError("cannot archive a Session with a running Turn");
    if (!view.archived) await this.ledger.append(binding.projectId, binding.nativeSessionId, { kind: "session.archived", at: this.now() });
  }

  async isThreadArchived(binding: RuntimeBinding): Promise<boolean> {
    this.owned(binding);
    return (await this.view(binding)).archived;
  }

  /** Models the pinned CLI reports for the configured login. Starts a process without any prompt. */
  async listModels(): Promise<RuntimeModelList> {
    const observedAtUtc = this.now();
    const unavailable = (error: string): RuntimeModelList => ({ status: "unavailable", models: [], options: [], error, observedAtUtc });
    if (!this.isReady()) return unavailable("Claude runtime is not ready");
    if (this.modelCache && Date.now() < this.modelCache.expiresAt) return this.modelCache.value;
    const controller = new AbortController();
    let release!: () => void;
    const hold = new Promise<void>(resolveHold => { release = resolveHold; });
    const idle = async function* (): AsyncGenerator<SDKUserMessage> { await hold; };
    const spawned: { child: ChildProcess | null } = { child: null };
    const listing = query({ prompt: idle(), options: {
      abortController: controller, cwd: this.configDir, env: { ...this.childEnv }, persistSession: false, settingSources: [], settings: { ...CHILD_SETTINGS },
      ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      spawnClaudeCodeProcess: spawnOptions => (spawned.child = spawnClaudeProcess(spawnOptions, { beforeUserWrite: () => false })),
    } });
    try {
      const reported = await withTimeout(listing.supportedModels(), this.options.startTimeoutMs ?? 60_000);
      const options = reported.flatMap(info => {
        const model = safeModel(info.value);
        if (!model) return [];
        const efforts = (info.supportedEffortLevels ?? []).filter(level => EFFORTS.has(level));
        return [{ model, supportedReasoningEfforts: efforts, defaultReasoningEffort: null,
          ...(typeof info.displayName === "string" && info.displayName.trim() && info.displayName.length <= 120 ? { displayName: info.displayName.trim() } : {}) }];
      });
      const value: RuntimeModelList = { status: options.length ? "available" : "empty", models: options.map(option => option.model),
        options, error: null, observedAtUtc };
      this.modelCache = { value, expiresAt: Date.now() + 60_000 };
      return value;
    } catch {
      return unavailable("Claude model list could not be read");
    } finally {
      release();
      listing.close();
      controller.abort();
      if (spawned.child) signalGroup(spawned.child, "SIGTERM");
    }
  }

  async close(): Promise<void> {
    const wasReady = this.isReady();
    this.ready = false;
    this.closed = true;
    const turns = [...this.live.values()];
    for (const live of turns) { live.closing = true; live.blocked = true; live.release(); live.controller.abort(); }
    if (!await settledWithin(Promise.allSettled(turns.map(live => live.done)), 3_000))
      for (const live of turns) if (live.child) signalGroup(live.child, "SIGKILL");
    if (wasReady) for (const listener of this.disconnects) { try { listener("adapter closed"); } catch { /* teardown continues */ } }
  }
}
