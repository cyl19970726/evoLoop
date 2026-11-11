import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimeCapabilities, RuntimeCapabilityListing, RuntimeCompactionObservation, RuntimeEvent, RuntimeModelList, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn, RuntimeTurnFailure, RuntimeWorkPage } from "@evoloop/contracts/runtime";
import { ownerOf, RuntimeLocalBusyError, RuntimeNotSentError, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/contracts/runtime";
import type { ExecutionProfileSnapshot } from "@evoloop/contracts/session-recovery";
import type { NativeInputCapture, NativeInputEvent, NativeInputQuestion } from "@evoloop/contracts/native-input";
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, WorkspaceRuntimeUpdate } from "@evoloop/contracts/session-timeline";
import { mapWorkItem } from "./work-trace.js";
import { mapWorkspaceEvent } from "./workspace-map.js";
import { WorkspaceHistoryReader } from "./workspace-read.js";
import { checkUsedSurface, compareCodexVersions, pinnedFeatures, versionAllowed, type ProtocolCheck, type ProtocolFeatures } from "./protocol-surface.js";
export { checkUsedSurface, compareCodexVersions, pinnedFeatures, versionAllowed, type ProtocolCheck, type ProtocolFeatures } from "./protocol-surface.js";

const OWNER = ownerOf("codex");
const PINNED_PROTOCOLS = {
  "codex-cli 0.154.0": {
    standard: "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9",
    experimental: "7b9e7d385fffef8d428cc5490b56ce9c393bd3ed7bc7ccd730956387e723ec05",
  },
  "codex-cli 0.164.0-alpha.11.1": {
    standard: "8fe0d6335768743b8388dfdbe95fef85303524093e2dffc301704555e73e718f",
    experimental: "3b9df7cbe5659538e7162e1f8fdadcad42badc08bfeac2fe617ede44ca057b12",
  },
  "codex-cli 0.166.0-alpha.5.1": {
    standard: "3164e5e1b190371566a3c163f6f4e56ee75552b5652ece246149e028cbabf23d",
    experimental: "ab788279bb5212b13701b505f7d8f119a71705d91f46e6e09c1e893e98c4a541",
  },
  "codex-cli 0.166.0-alpha.6": {
    standard: "e025e54fb11354eb82767ea040b40efa17b34dfc706c9433a6115b5f4771c465",
    experimental: "f72bb03a3f519cd19b37a030b42453128ff5b88abaad8c1264cf1ca197dbbed0",
  },
  "codex-cli 0.167.0-alpha.3.2": {
    standard: "f2576ca5d46be4cfb159906264fbc173efcfcc917ea8fdc38323770e7b657b5a",
    experimental: "b1e5d17224b9d9732b5976012438ba78e2cf7e418b67f8f8a5f5cffe301b875d",
  },
} as const;
type PinnedProtocolVersion = keyof typeof PINNED_PROTOCOLS;
/** Reviewed v2 schema hashes for one pinned version, or null; read by the conformance script. */
export const pinnedSchemaHashes = (version: string): { standard: string; experimental: string } | null =>
  Object.hasOwn(PINNED_PROTOCOLS, version) ? { ...PINNED_PROTOCOLS[version as PinnedProtocolVersion] } : null;
const execFileAsync = promisify(execFile);
const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "applyPatchApproval", "execCommandApproval"]);
// The App Server and its probes must not inherit coordinator credentials or Node execution flags.
// CODEX_HOME (or HOME) carries the existing Codex ChatGPT login; no API key is required.
const CHILD_ENV_KEYS = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CODEX_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;
function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return environment;
}
const finite = (value: number): boolean => Number.isFinite(value) && value > 0;
const FULL_SANDBOX = "danger-full-access" as const;
const FULL_POLICY = {type:"dangerFullAccess"} as const;
const CONNECTOR_SCOPE = /^connector-receiver:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const connectorReceiver = (value:{authorizationScope:string;sandbox:string;approvalPolicy:string}):boolean =>
  CONNECTOR_SCOPE.test(value.authorizationScope)&&value.sandbox==='read-only'&&value.approvalPolicy==='never';
const fullProfile = (value:{sandbox:string;approvalPolicy:string}):boolean =>
  value.sandbox===FULL_SANDBOX&&value.approvalPolicy==='never';
const nativeProfile = (value:{authorizationScope:string;sandbox:string;approvalPolicy:string},version:PinnedProtocolVersion):boolean =>
  (!value.authorizationScope.startsWith('connector-receiver:')&&fullProfile(value))||
    (version==='codex-cli 0.166.0-alpha.6'&&connectorReceiver(value));
const nativeSandboxConfirmed=(sandbox:Record<string,unknown>|null,requested:string):boolean=>
  requested===FULL_SANDBOX?sandbox?.type==='dangerFullAccess':
    requested==='read-only'&&sandbox?.type==='readOnly'&&sandbox.networkAccess===false;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const policyJson=(value:unknown):string=>JSON.stringify(value,(_key,current)=>object(current)?
  Object.fromEntries(Object.entries(current).sort(([a],[b])=>a.localeCompare(b))):current);
const sameBinding = (a: RuntimeBinding, b: RuntimeBinding): boolean =>
  (["sessionId", "roleId", "projectId", "nativeThreadId", "nativeSessionId", "cwd", "authorizationScope", "owner"] as const).every(key => a[key] === b[key]) &&
  (["actorId","model","reasoningEffort","sandbox","approvalPolicy","executionProfileRevisionId"] as const).every(key =>
    (a.resumeProfile?.[key] ?? null) === (b.resumeProfile?.[key] ?? null));
/** Same Thread, scope and profile except the effort and the execution profile revision that carries it. */
const effortRevisionOnly = (a: RuntimeBinding, b: RuntimeBinding): boolean =>
  (["sessionId", "roleId", "projectId", "nativeThreadId", "nativeSessionId", "cwd", "authorizationScope", "owner"] as const).every(key => a[key] === b[key]) &&
  (["actorId", "model", "sandbox", "approvalPolicy"] as const).every(key => (a.resumeProfile?.[key] ?? null) === (b.resumeProfile?.[key] ?? null));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const safeModelIdentity = (value:unknown):string|null => typeof value==="string"&&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value)?value:null;
const safeProviderCode = (value: unknown): string | null => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
/** Native classification first: the App Server reports overflow as a typed codexErrorInfo, not an HTTP status. */
const contextWindowExceeded = (info: unknown): boolean =>
  info === "contextWindowExceeded" || (!!object(info) && Object.hasOwn(object(info)!, "contextWindowExceeded"));
function turnFailure(value: unknown): RuntimeTurnFailure | undefined {
  const native = object(value);
  if (!native) return undefined;
  if (contextWindowExceeded(native.codexErrorInfo))
    return { category: "context_window_exceeded", providerCode: null, httpStatus: null,
      summary: "Context exceeded the model window; retry on the same Session after native compaction" };
  const raw = typeof native.message === "string" ? native.message : "";
  let parsed: Record<string, unknown> | null = null;
  try { parsed = object(JSON.parse(raw)); } catch { /* Native error text is not necessarily JSON. */ }
  const provider = object(parsed?.error);
  const providerMessage = typeof provider?.message === "string" ? provider.message : "";
  const status = typeof parsed?.status === "number" && Number.isInteger(parsed.status) && parsed.status >= 100 && parsed.status <= 599 ? parsed.status : null;
  const providerCode = safeProviderCode(provider?.type);
  const unsupportedModel = /model is not supported.{0,100}ChatGPT account/i.test(providerMessage);
  const category: RuntimeTurnFailure["category"] = unsupportedModel ? "unsupported_model" : status === 429 ? "rate_limited"
    : status !== null && status >= 500 ? "provider_unavailable" : status !== null && status >= 400 ? "provider_rejected" : "native_failure";
  const summary = category === "unsupported_model" ? "Configured model is not supported with this Codex ChatGPT account"
    : category === "rate_limited" ? "Model provider rate limit" : category === "provider_unavailable" ? "Model provider unavailable"
    : category === "provider_rejected" ? "Model provider rejected the request" : "Native turn failed";
  return { category, providerCode, httpStatus: status, summary };
}
function runtimeTurn(value: unknown): RuntimeTurn | null {
  const turn = object(value);
  if (!nonempty(turn?.id) || !nonempty(turn.status)) return null;
  // App Server Turn.completedAt is Unix seconds, or null until the persisted turn settles.
  // A history projection can report "interrupted" during an active turn with no timestamp.
  const completedAt = turn.completedAt;
  if (completedAt !== null && completedAt !== undefined && (!Number.isSafeInteger(completedAt) || (completedAt as number) <= 0)) return null;
  const timestamp = completedAt == null ? null : new Date((completedAt as number) * 1000);
  if (timestamp && !Number.isFinite(timestamp.valueOf())) return null;
  const error = turnFailure(turn.error);
  return { id: turn.id, status: turn.status, completedAtUtc: timestamp?.toISOString() ?? null, ...(error ? { error } : {}) };
}

// Provider-neutral outcome errors live in contracts; re-exported for existing importers.
export { RuntimeLocalBusyError, RuntimeNotSentError, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError };
export type { RuntimeServerErrorCategory } from "@evoloop/contracts/runtime";

export type RuntimeCompactionPreflightStage = "request_validation" | "owner_resume" | "thread_read" | "history" | "send_connection";
/**
 * A known failure before `thread/compact/start` was sent. The stage and safe
 * cause distinguish this from a lost compaction acknowledgement.
 */
export class RuntimeCompactionPreflightError extends RuntimeProtocolError {
  readonly code: string;
  constructor(readonly stage: RuntimeCompactionPreflightStage, cause: unknown) {
    const result = cause instanceof RuntimeUnknownError ? "unknown" :
      cause instanceof RuntimeServerError ? cause.category : "rejected";
    super(`thread/compact/start was not sent (${stage}, ${result})`);
    this.name = "RuntimeCompactionPreflightError";
    this.code = `${stage}_${result}`;
  }
}


/** POSIX: the App Server leads its own process group so close reaches tools it spawned. */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && Number.isSafeInteger(pid) && pid! > 0) {
    try { process.kill(-pid!, signal); return; } catch { /* group already empty; fall back to the direct child */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_SEEN_TOOL_CALLS = 10_000;
// Bounded wait for the post-turn/start history attach window of thread/turns/list (about 1.5 s in total).
const TURN_LIST_ATTACH_RETRIES = 5;
const TURN_LIST_ATTACH_DELAY_MS = 100;

export type NativeChildStopReason = 'adapter_closed' | 'stdout_closed' | 'stdin_error' | 'process_exited' | 'spawn_error' | 'protocol_error';
/** Transport loss and child exit are separate observations. Neither proves a native Turn result. */
export interface NativeChildDiagnostic {
  startId: string;
  pid: number | null;
  startedAtUtc: string;
  observedAtUtc: string;
  firstLossAtUtc: string;
  firstLossReason: NativeChildStopReason;
  stopReason: NativeChildStopReason;
  exitObserved: boolean;
  exitedAtUtc: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  nativeTurnOutcome: 'unknown';
}

export interface CodexAppServerOptions {
  executable?: string;
  expectedVersion?: string;
  requestTimeoutMs?: number;
  /** Optional startup handshake deadline; other RPCs retain requestTimeoutMs. */
  initializationTimeoutMs?: number;
  dynamicToolTimeoutMs?: number;
  clientVersion?: string;
  /** Enable pinned modern native request_user_input on this child only; never writes user configuration. */
  nativeUserInput?: boolean;
  /** Experimental workspace history needs explicit owner-connection opt-in after wire/store validation. */
  workspaceExperimental?: boolean;
  /** For fixtures only; production uses `app-server --stdio`. */
  spawnArgs?: string[];
  /**
   * `exact` (default): the CLI must be expectedVersion and its schema must hash to the reviewed value.
   * `surface`: the CLI must be at least minimumVersion, not blocked, and its generated schema must still
   * carry every method and request parameter evoLoop uses; optional features follow the schema.
   */
  protocolCheck?: ProtocolCheck;
  /** Surface check only; defaults to expectedVersion. */
  minimumVersion?: string;
  /** Surface check only; exact `codex-cli X.Y.Z[-pre]` versions that must never run. */
  blockedVersions?: readonly string[];
  /** One JSON-RPC line larger than this loses protocol sync and disconnects. Default 64 MiB. */
  maxLineBytes?: number;
  /** Actual child exit evidence, independent of a transport EOF. */
  onExited?: (receipt:{pid:number;code:number|null;signal:NodeJS.Signals|null})=>void|Promise<void>;
  /** Explicit per-request approval, never a session-wide grant. Default is deny. */
  decideApproval?: (request: RuntimeApprovalRequest, binding: RuntimeBinding) => Promise<"accept" | "decline">;
  /** Required to restore a persisted binding after restart. Must consult the trusted project store. */
  verifyBinding?: (binding: RuntimeBinding) => Promise<boolean>;
  /** Trusted, persisted activation permit for exactly one adopted Session execution profile revision. */
  authorizeExecutionProfileActivation?: (current: RuntimeBinding, target: RuntimeSessionSpec,
    revisionId: string, operationId: string) => Promise<boolean>;
  /**
   * Dedicated Codex state directory (config, login, sessions) for this coordinator's App Server and probes.
   * When absent the inherited CODEX_HOME or ~/.codex is shared with the user's own Codex use.
   */
  codexHome?: string;
  /** Synthetic parent environment for process-boundary tests; all values still pass through the allowlist. */
  environment?: NodeJS.ProcessEnv;
  /** Trusted local profile configuration, never accepted from a worker's request. */
  threadConfig?: (spec: RuntimeSessionSpec) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  /** Experimental protocol, opt-in only. Declaration is checked before native thread creation. */
  dynamicTools?: (spec: RuntimeSessionSpec) => Promise<DynamicToolSpec[] | undefined>;
  /** The coordinator rechecks persisted Run and reader authority for every call. */
  callDynamicTool?: (call: DynamicToolCall, binding: RuntimeBinding) => Promise<DynamicToolResult>;
  /** Close the scoped backend if a native tool call exceeds its deadline. */
  cancelDynamicTool?: (call: DynamicToolCall, binding: RuntimeBinding) => void | Promise<void>;
}

export interface DynamicToolSpec { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> }
export interface DynamicToolCall { threadId: string; turnId: string; callId: string; tool: string; arguments: Record<string, unknown>; signal?: AbortSignal }
export interface DynamicToolResult { contentItems: ({type:"inputText";text:string}|{type:"inputImage";imageUrl:string})[]; success: boolean }

interface Pending { method: string; threadId: string | null; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const MAX_CHILD_DIAGNOSTICS = 16;
type ModelListResult = RuntimeModelList;
const MODEL_LIST_PAGE_SIZE = 100;
const MODEL_LIST_MAX_PAGES = 5;
const MODEL_LIST_CACHE_MS = 10_000;
const CAPABILITY_LIST_TIMEOUT_MS = 5_000;
const CAPABILITY_LIST_MAX = 512;
/** A listed name or id: bounded, printable, no line breaks. */
const listedName = (value: unknown): value is string => typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,160}$/u.test(value);
interface PendingNativeInput { capture: NativeInputCapture; requestId: string | number; attempted: boolean }

const nativeRequestKey=(value:unknown):string|null=>
  typeof value==='string'&&value.length>0&&value.trim().length>0&&value.length<=1024?`s:${value}`:
    typeof value==='number'&&Number.isSafeInteger(value)?`n:${value}`:null;
const boundedText=(value:unknown,max:number):value is string=>
  typeof value==='string'&&value.length>0&&value.trim().length>0&&value.length<=max;

/** Parse only the pinned text/options subset. Secret or oversized prompts never enter a capture. */
function nativeInputQuestions(value:unknown):NativeInputQuestion[]|null{
  if(!Array.isArray(value)||value.length<1||value.length>3)return null;
  const questions:NativeInputQuestion[]=[];
  const ids=new Set<string>();
  for(const entry of value){
    const question=object(entry);
    if(!question||!boundedText(question.id,120)||ids.has(question.id)||
      !boundedText(question.header,120)||!boundedText(question.question,4000)||
      question.isSecret===true||question.isSecret!=null&&question.isSecret!==false||
      question.isOther!=null&&typeof question.isOther!=='boolean')return null;
    ids.add(question.id);
    let options:NativeInputQuestion['options']=null;
    if(question.options!=null){
      if(!Array.isArray(question.options)||question.options.length>8)return null;
      options=question.options.length?[]:null;
      const labels=new Set<string>();
      for(const value of question.options){
        const option=object(value);
        if(!option||!boundedText(option.label,240)||
          typeof option.description!=='string'||option.description.length>1000||labels.has(option.label))return null;
        labels.add(option.label);
        options!.push({label:option.label,description:option.description});
      }
    }
    questions.push({id:question.id,header:question.header,question:question.question,
      isOther:question.isOther===true,options});
  }
  return questions;
}

export class CodexAppServerAdapter implements RuntimePort {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ownedProcess: ChildProcessWithoutNullStreams | null = null;
  private processExit: Promise<void> | null = null;
  private exitDelivery: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private bindings = new Map<string, RuntimeBinding>();
  /** A create hint is only for durable denial evidence; it never registers native ownership. */
  private pendingCreate: RuntimeSessionSpec | null = null;
  private events = new Set<(event: RuntimeEvent) => void>();
  private workspaceUpdates = new Set<(event: WorkspaceRuntimeUpdate) => void>();
  private readonly workspaceReader = new WorkspaceHistoryReader((method, params) => this.request(method, params),
    () => this.experimental && this.options.workspaceExperimental === true && this.features.workspace);
  private approvals = new Set<(request: RuntimeApprovalRequest) => void | Promise<void>>();
  private declaredTools = new Map<string, Set<string>>();
  private profileTransitionThreads = new Set<string>();
  private conversationQualifications = new Map<string,{fingerprint:string;observedAt:number;model:string|null;status:string}>();
  /** Ephemeral thread/start proof; never reconstructed from a persisted binding or history. */
  private freshThreads = new Map<string,{connectionId:string;binding:RuntimeBinding;config:string;tools:string;claimed:boolean}>();
  private fullTurnAttempts = new Map<string,Set<string>>();
  private conversationTurnInFlight = new Set<string>();
  private seenToolCalls = new Set<string>();
  private disconnects = new Set<(reason: string) => void>();
  private nativeInputListeners = new Set<(event:NativeInputEvent)=>void|Promise<void>>();
  private pendingNativeInputs = new Map<string,PendingNativeInput>();
  private nativeRequestHandles = new Map<string,string>();
  private seenNativeRequestIds = new Set<string>();
  private connectionId: string | null = null;
  private childStartedAtUtc: string | null = null;
  private childDiagnostics: NativeChildDiagnostic[] = [];
  private childDiagnosticListeners = new Set<(diagnostic:NativeChildDiagnostic)=>void|Promise<void>>();
  private diagnosticDelivery:Promise<void> = Promise.resolve();
  private diagnosticDeliveryFailed = false;
  private experimental = false;
  private closed = false;
  private ready = false;
  private readonly executable: string;
  private readonly timeout: number;
  private readonly initializationTimeout: number;
  private readonly dynamicToolTimeout: number;
  private readonly maxLineBytes: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly expectedVersion: PinnedProtocolVersion;
  private readonly protocolCheck: ProtocolCheck;
  private readonly minimumVersion: string;
  private readonly blockedVersions: readonly string[];
  /** Reviewed table for exact pinning; replaced by schema detection on each surface-checked open. */
  private features: ProtocolFeatures;
  /** The protocol a conversation admission was qualified under: the pinned or observed CLI version. */
  private protocolIdentity: string;
  private modelListCache: {value:ModelListResult;expiresAt:number}|null = null;
  private modelListPending: Promise<ModelListResult>|null = null;

  constructor(private readonly options: CodexAppServerOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.timeout = options.requestTimeoutMs ?? 15_000;
    this.initializationTimeout = options.initializationTimeoutMs ?? this.timeout;
    this.dynamicToolTimeout = options.dynamicToolTimeoutMs ?? 30_000;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.environment = childEnvironment(options.environment ?? process.env);
    if (options.codexHome !== undefined) {
      if (typeof options.codexHome !== "string" || !isAbsolute(options.codexHome)) throw new RuntimeProtocolError("codexHome must be an absolute path");
      this.environment.CODEX_HOME = options.codexHome;
    }
    const expectedVersion = options.expectedVersion ?? "codex-cli 0.154.0";
    if (!(expectedVersion in PINNED_PROTOCOLS)) throw new RuntimeProtocolError("unsupported Codex CLI protocol version");
    this.expectedVersion = expectedVersion as PinnedProtocolVersion;
    this.features = pinnedFeatures(this.expectedVersion)!;
    this.protocolIdentity = this.expectedVersion;
    this.protocolCheck = options.protocolCheck ?? "exact";
    if (this.protocolCheck !== "exact" && this.protocolCheck !== "surface") throw new RuntimeProtocolError("protocolCheck must be exact or surface");
    this.minimumVersion = options.minimumVersion ?? this.expectedVersion;
    if (compareCodexVersions(this.minimumVersion, this.minimumVersion) === null) throw new RuntimeProtocolError("minimumVersion must be a codex-cli version");
    this.blockedVersions = [...(options.blockedVersions ?? [])];
    if (this.blockedVersions.some(version => compareCodexVersions(version, version) === null))
      throw new RuntimeProtocolError("blockedVersions must list codex-cli versions");
    if(options.nativeUserInput!==undefined&&typeof options.nativeUserInput!=='boolean')
      throw new RuntimeProtocolError('nativeUserInput must be boolean');
    if(options.nativeUserInput&&!this.features.modern)
      throw new RuntimeProtocolError('nativeUserInput requires a pinned modern Codex CLI protocol');
    if(options.workspaceExperimental!==undefined&&typeof options.workspaceExperimental!=='boolean')
      throw new RuntimeProtocolError('workspaceExperimental must be boolean');
    if(options.workspaceExperimental&&!this.features.workspace)
      throw new RuntimeProtocolError('workspaceExperimental requires a pinned experimental workspace protocol');
    if (!finite(this.timeout)) throw new Error("requestTimeoutMs must be positive");
    if (!finite(this.initializationTimeout)) throw new Error("initializationTimeoutMs must be positive");
    if (!finite(this.dynamicToolTimeout)) throw new Error("dynamicToolTimeoutMs must be positive");
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes <= 0) throw new Error("maxLineBytes must be a positive integer");
  }
  /** One shared stdio child serves every Session; a transport loss affects all in-flight Turns. */
  capabilities(): RuntimeCapabilities {
    const modern = this.features.modern;
    return {
      provider: "codex", process: "shared",
      delivery: { midTurnInput: this.features.midTurnInput, idleTurnStart: modern,
        callerAssignedTurnKey: false, callerAssignedSessionId: false },
      errors: { notSent: true, rejected: true },
      compaction: { autoCompacts: true, mode: this.features.compaction ? "owned_request" : "unavailable" },
      history: { workTrace: true, workspace: this.options.workspaceExperimental === true && this.features.workspace },
      naming: modern, archive: "native", nativeInput: this.options.nativeUserInput === true && modern,
      executionProfileActivation: modern && this.features.executionProfileSwitch,
      modelList: true, usage: "unavailable", cost: false,
    };
  }
  /** This adapter serves one pinned protocol; a binding owned by another runtime is not its to describe. */
  capabilitiesFor(binding: RuntimeBinding): RuntimeCapabilities {
    if (binding.owner !== ownerOf("codex"))
      throw new RuntimeProtocolError("binding owner is not the Codex App Server runtime");
    return this.capabilities();
  }
  isReady(): boolean { return this.ready && !!this.child; }
  hasProcessHandle():boolean{return this.ownedProcess!==null;}
  /** Last loss of the owned native connection, retained after close or a later open. */
  lastChildDiagnostic(): NativeChildDiagnostic | null {
    const last=this.childDiagnostics.at(-1);
    return last ? {...last} : null;
  }
  /** Bounded newest-first history for an owner status projection. */
  listChildDiagnostics(): NativeChildDiagnostic[] {
    return this.childDiagnostics.toReversed().map(entry=>({...entry}));
  }
  /** Receives first loss and confirmed exit as ordered snapshots of the same startId. */
  onChildDiagnostic(listener:(diagnostic:NativeChildDiagnostic)=>void|Promise<void>):()=>void{
    this.childDiagnosticListeners.add(listener);
    return ()=>this.childDiagnosticListeners.delete(listener);
  }
  /** A caller can await this before claiming that its diagnostic observer persisted the snapshots. */
  async flushChildDiagnostics():Promise<void>{
    await this.diagnosticDelivery;
    if(this.diagnosticDeliveryFailed)
      throw new RuntimeUnknownError('child-diagnostic',null,'diagnostic observer failed');
  }
  private emitChildDiagnostic(diagnostic:NativeChildDiagnostic):void{
    const snapshot={...diagnostic};
    const listeners=[...this.childDiagnosticListeners];
    this.diagnosticDelivery=this.diagnosticDelivery.then(async()=>{
      for(const listener of listeners){
        try{await listener({...snapshot});}
        catch{this.diagnosticDeliveryFailed=true;}
      }
    });
  }
  nativeInputConnectionId():string|null{return this.isReady()?this.connectionId:null;}
  onNativeInput(listener:(event:NativeInputEvent)=>void|Promise<void>):()=>void{
    this.nativeInputListeners.add(listener);
    return ()=>this.nativeInputListeners.delete(listener);
  }
  hasPendingInput(id:string,connectionId:string):boolean{
    const pending=this.pendingNativeInputs.get(id);
    return !!pending&&!pending.attempted&&pending.capture.connectionId===connectionId&&
      this.connectionId===connectionId&&this.isReady();
  }
  async respondToInput(id:string,connectionId:string,answers:Record<string,string[]>):Promise<void>{
    if(!this.hasPendingInput(id,connectionId))throw new RuntimeProtocolError('native input handle is no longer pending on this connection');
    const pending=this.pendingNativeInputs.get(id)!;
    const questions=pending.capture.questions;
    if(!object(answers)||Object.keys(answers).length!==questions.length||
      questions.some(question=>!Object.hasOwn(answers,question.id)))
      throw new RuntimeProtocolError('native input answers do not match the captured questions');
    const response:Record<string,{answers:string[]}>=Object.create(null) as Record<string,{answers:string[]}>;
    for(const question of questions){
      const values=answers[question.id];
      if(!Array.isArray(values)||values.length<1||values.length>8||
        values.some(value=>!boundedText(value,4000))||
        (question.options?.length&&!question.isOther&&values.some(value=>
          !question.options!.some(option=>option.label===value))))
        throw new RuntimeProtocolError('native input answer is invalid');
      response[question.id]={answers:[...values]};
    }
    // JSON-RPC responses have no acknowledgement. Mark before writing, including on a transport failure.
    pending.attempted=true;
    try{this.send({id:pending.requestId,result:{answers:response}});}
    catch{throw new RuntimeUnknownError('item/tool/requestUserInput',null,'native input response write outcome unknown');}
  }
  onDisconnect(listener: (reason: string) => void): () => void { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }

  /** Catalog observation only; a listed slug does not prove a Turn can use it. */
  /**
   * Skills the App Server discovers for `cwd` and, unless skillsOnly, its installed plugins and MCP servers.
   * Read-only and bounded; skills are reloaded from disk. Plugin and MCP lists are best effort.
   */
  async listCapabilities(cwd: string, options: { skillsOnly?: boolean } = {}): Promise<RuntimeCapabilityListing> {
    if (!this.isReady()) throw new RuntimeProtocolError("App Server not ready");
    if (!this.features.capabilityLists) throw new RuntimeProtocolError("capability lists require a newer Codex protocol");
    if (!cwd.startsWith("/") || resolve(cwd) !== cwd) throw new RuntimeProtocolError("invalid cwd");
    const timeout = Math.min(this.timeout, CAPABILITY_LIST_TIMEOUT_MS);
    const listed = object(await this.request("skills/list", { cwds: [cwd], forceReload: true }, timeout, undefined, undefined, true));
    if (!Array.isArray(listed?.data)) throw new RuntimeProtocolError("invalid skills/list response");
    const skills: RuntimeCapabilityListing["skills"] = [];
    for (const entry of listed.data) {
      for (const value of Array.isArray(object(entry)?.skills) ? object(entry)!.skills as unknown[] : []) {
        const skill = object(value);
        if (!skill || !listedName(skill.name) || typeof skill.path !== "string" || !skill.path.startsWith("/") ||
          !["user", "repo", "system", "admin"].includes(String(skill.scope)) || typeof skill.enabled !== "boolean") continue;
        if (skills.length >= CAPABILITY_LIST_MAX) break;
        skills.push({ name: skill.name, path: skill.path, scope: skill.scope as RuntimeCapabilityListing["skills"][number]["scope"],
          enabled: skill.enabled, description: typeof skill.description === "string" ? skill.description.slice(0, 500) : null,
          pluginId: listedName(skill.pluginId) ? skill.pluginId : null });
      }
    }
    if (options.skillsOnly) return { skills, plugins: null, mcpServers: null, errors: [] };
    const errors: string[] = [];
    let plugins: RuntimeCapabilityListing["plugins"] = null, mcpServers: RuntimeCapabilityListing["mcpServers"] = null;
    try {
      const result = object(await this.request("plugin/list", { cwds: [cwd] }, timeout, undefined, undefined, true));
      if (!Array.isArray(result?.marketplaces)) throw new Error("invalid");
      plugins = result.marketplaces.flatMap(market => Array.isArray(object(market)?.plugins) ? object(market)!.plugins as unknown[] : [])
        .map(object).filter(plugin => plugin?.installed === true && listedName(plugin.name))
        .map(plugin => ({ name: plugin!.name as string, enabled: plugin!.enabled === true })).slice(0, CAPABILITY_LIST_MAX);
    } catch { errors.push("plugin/list"); }
    try {
      const result = object(await this.request("mcpServerStatus/list", { limit: 50 }, timeout, undefined, undefined, true));
      if (!Array.isArray(result?.data)) throw new Error("invalid");
      mcpServers = result.data.map(object).filter(server => listedName(server?.name))
        .map(server => ({ name: server!.name as string, auth: typeof server!.authStatus === "string" ? server!.authStatus : null }));
    } catch { errors.push("mcpServerStatus/list"); }
    return { skills, plugins, mcpServers, errors };
  }

  async listModels():Promise<ModelListResult>{
    const now=Date.now();
    if(this.modelListCache&&now<this.modelListCache.expiresAt&&this.isReady())
      return {...this.modelListCache.value,models:[...this.modelListCache.value.models],
        options:this.modelListCache.value.options.map(option=>({...option,supportedReasoningEfforts:[...option.supportedReasoningEfforts]}))};
    if(this.modelListPending){
      const value=await this.modelListPending;
      return {...value,models:[...value.models],options:value.options.map(option=>({...option,supportedReasoningEfforts:[...option.supportedReasoningEfforts]}))};
    }
    const connection=this.connectionId;
    const read=async():Promise<ModelListResult>=>{
      const models:string[]=[];
      const options:ModelListResult['options']=[];
      const seenModels=new Set<string>();
      const seenCursors=new Set<string>();
      let cursor:string|undefined;
      const deadline=Date.now()+this.timeout;
      try{
        if(!this.isReady())throw new RuntimeProtocolError('App Server not ready');
        for(let page=0;page<MODEL_LIST_MAX_PAGES;page++){
          const remaining=deadline-Date.now();
          if(remaining<=0)throw new RuntimeUnknownError('model/list',null,'response timeout');
          const result=object(await this.request('model/list',{
            limit:MODEL_LIST_PAGE_SIZE,...(cursor?{cursor}:{})},remaining));
          if(!result||!Array.isArray(result.data)||result.data.length>MODEL_LIST_PAGE_SIZE||
            result.nextCursor!==null&&result.nextCursor!==undefined&&
              (typeof result.nextCursor!=='string'||!result.nextCursor.length))
            throw new RuntimeProtocolError('invalid model/list response');
          for(const entry of result.data){
            const model=object(entry)?.model;
            if(typeof model!=='string'||!model.length||model.length>256||model.trim()!==model)
              throw new RuntimeProtocolError('invalid model/list entry');
            const source=object(entry)!;
            const effortOptions=Array.isArray(source.supportedReasoningEfforts)?source.supportedReasoningEfforts:[];
            const efforts=effortOptions.map(value=>object(value)?.reasoningEffort).filter((value):value is string=>
              typeof value==='string'&&/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(value));
            const defaultEffort=typeof source.defaultReasoningEffort==='string'?source.defaultReasoningEffort:null;
            if(!seenModels.has(model)){seenModels.add(model);models.push(model);
              options.push({model,supportedReasoningEfforts:[...new Set(efforts)],defaultReasoningEffort:defaultEffort});}
          }
          if(result.nextCursor==null){
            return {status:models.length?'available':'empty',models,options,error:null,observedAtUtc:new Date().toISOString()};
          }
          if(seenCursors.has(result.nextCursor))throw new RuntimeProtocolError('repeated model/list cursor');
          seenCursors.add(result.nextCursor);
          cursor=result.nextCursor;
        }
        throw new RuntimeProtocolError('model/list pagination limit reached');
      }catch(error){
        const code=error instanceof RuntimeUnknownError&&error.message.includes('timeout')?'model_list_timeout':
          error instanceof RuntimeServerError?'model_list_rejected':
          error instanceof RuntimeProtocolError&&/pagination limit|cursor/.test(error.message)?'model_list_incomplete':
          error instanceof RuntimeProtocolError&&/invalid model\/list/.test(error.message)?'model_list_invalid_response':
          'model_list_unavailable';
        return {status:'unavailable',models:[],options:[],error:code,observedAtUtc:new Date().toISOString()};
      }
    };
    const pending=read();
    this.modelListPending=pending;
    try{
      const value=await pending;
      if(connection===this.connectionId&&this.isReady())
        this.modelListCache={value,expiresAt:Date.now()+MODEL_LIST_CACHE_MS};
      return {...value,models:[...value.models],options:value.options.map(option=>({...option,supportedReasoningEfforts:[...option.supportedReasoningEfforts]}))};
    }finally{if(this.modelListPending===pending)this.modelListPending=null;}
  }

  private appServerArguments():string[]{
    return this.options.nativeUserInput===true?
      ['-c','features.default_mode_request_user_input=true','app-server','--stdio']:
      ['app-server','--stdio'];
  }

  /** Probe the installed CLI before it can receive any project request. */
  async open(): Promise<void> {
    if (this.closed) throw new RuntimeProtocolError("adapter closed");
    if (this.ready) return;
    if (this.child) throw new RuntimeProtocolError("adapter opening");
    if(this.ownedProcess?.pid&&this.ownedProcess.exitCode===null&&this.ownedProcess.signalCode===null)
      throw new RuntimeProtocolError('previous App Server process has not exited');
    this.experimental=this.options.workspaceExperimental===true||!!(this.options.dynamicTools&&this.options.callDynamicTool)||
      (this.features.modern&&this.nativeInputListeners.size>0);
    if (!this.options.spawnArgs) {
      const version = await this.probeVersion();
      if (this.protocolCheck === "exact") {
        if (version !== this.expectedVersion) throw new RuntimeProtocolError(`Codex CLI version mismatch: expected ${this.expectedVersion}, got ${version}`);
        await this.probeSchema();
      } else {
        if (!versionAllowed(version, this.minimumVersion, this.blockedVersions))
          throw new RuntimeProtocolError(`Codex CLI version ${version} is below ${this.minimumVersion} or blocked`);
        const features = await this.probeSurface();
        if (this.options.nativeUserInput && !features.modern) throw new RuntimeProtocolError("nativeUserInput requires a modern Codex CLI protocol");
        if (this.options.workspaceExperimental && !features.workspace) throw new RuntimeProtocolError("workspaceExperimental requires the workspace timeline protocol");
        this.features = features;
        this.protocolIdentity = version;
      }
    }
    const child = spawn(this.executable, this.options.spawnArgs ?? this.appServerArguments(), {
      // detached: own process group, so close() also stops shells and tools the App Server started.
      stdio: ["pipe", "pipe", "pipe"], env: this.environment, detached: process.platform !== "win32",
    });
    this.child = child;
    this.connectionId=randomUUID();
    this.childStartedAtUtc=new Date().toISOString();
    const startId=this.connectionId;
    this.seenNativeRequestIds.clear();
    this.seenToolCalls.clear(); // Duplicate callId detection only spans one connection's Turns.
    this.ownedProcess=child;
    this.processExit=new Promise<void>(resolveExit=>{
      child.once('exit',()=>resolveExit());
      child.once('error',()=>{if(!child.pid)resolveExit();});
    });
    child.stderr.resume(); // Do not persist stderr: it may contain private paths or content.
    child.on("error", () => {if(this.child===child)this.disconnect('child process error','spawn_error');});
    // EPIPE after the child stops reading must not become an uncaught coordinator exception.
    child.stdin.on("error", () => {if(this.child===child)this.disconnect('stdin error','stdin_error');});
    child.on("exit", (code, signal) => {
      if(Number.isSafeInteger(child.pid)&&this.options.onExited){
        this.exitDelivery=Promise.resolve().then(()=>this.options.onExited!({pid:child.pid!,code,signal}));
        void this.exitDelivery.catch(()=>undefined);
      }
      if(this.child===child)this.disconnect(`process exited (${code ?? signal ?? "unknown"})`,'process_exited');
      const diagnostic=this.childDiagnostics.find(entry=>entry.startId===startId);
      if(diagnostic){
        diagnostic.stopReason=diagnostic.firstLossReason==='adapter_closed'?'adapter_closed':'process_exited';
        diagnostic.exitObserved=true;
        diagnostic.exitedAtUtc=new Date().toISOString();
        diagnostic.exitCode=code;
        diagnostic.exitSignal=signal;
        this.emitChildDiagnostic(diagnostic);
      }
    });
    this.readLines(child);
    try {
      const result = object(await this.request("initialize", { clientInfo: { name: "evoloop", title: "evoLoop", version: this.options.clientVersion ?? "0.1.0" },
        ...(this.experimental ?
          {capabilities:{experimentalApi:true}} : {}) }, this.initializationTimeout));
      if (!result || !nonempty(result.userAgent) || !nonempty(result.platformFamily)) throw new RuntimeProtocolError("invalid initialize response");
      this.send({ method: "initialized" });
      this.ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Newline-delimited JSON with a per-line ceiling; an oversized line cannot be resynchronized. */
  private readLines(child: ChildProcessWithoutNullStreams): void {
    let buffered: Buffer[] = [], bufferedBytes = 0;
    const overflow = (): void => { buffered = []; bufferedBytes = 0; if (this.child === child) this.disconnect("stdout line exceeded limit", "protocol_error"); };
    const emit = (bytes: Buffer): void => {
      const text = bytes.toString("utf8");
      this.receive(text.endsWith("\r") ? text.slice(0, -1) : text);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      let start = 0;
      for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, newline);
        start = newline + 1;
        if (bufferedBytes + part.length > this.maxLineBytes) { overflow(); return; }
        const line = bufferedBytes ? Buffer.concat([...buffered, part]) : part;
        buffered = []; bufferedBytes = 0;
        emit(line);
        if (this.child !== child) return;
      }
      const rest = chunk.subarray(start);
      if (!rest.length) return;
      if (bufferedBytes + rest.length > this.maxLineBytes) { overflow(); return; }
      buffered.push(Buffer.from(rest)); bufferedBytes += rest.length;
    });
    child.stdout.once("end", () => {
      if (this.child === child && bufferedBytes) { const last = Buffer.concat(buffered); buffered = []; bufferedBytes = 0; emit(last); }
      if (this.child === child) this.disconnect("stdout closed", "stdout_closed");
    });
    child.stdout.once("close", () => { if (this.child === child) this.disconnect("stdout closed", "stdout_closed"); });
  }

  private probeVersion(): Promise<string> {
    return new Promise((resolveVersion, reject) => {
      const child = spawn(this.executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: this.environment });
      let output = "";
      const timer = setTimeout(() => { child.kill(); reject(new RuntimeProtocolError("version probe timed out")); }, this.timeout);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 256) child.kill(); });
      child.stderr.resume();
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolveVersion(output.trim()) : reject(new RuntimeProtocolError("version probe failed")); });
    });
  }

  private async generateSchema(): Promise<Buffer> {
    const directory = await mkdtemp(resolve(tmpdir(), "evoloop-codex-schema-"));
    try {
      await execFileAsync(this.executable, ["app-server", "generate-json-schema", ...(this.experimental ? ["--experimental"] : []), "--out", directory], {
        timeout: this.timeout, maxBuffer: 64 * 1024, env: this.environment,
      });
      return await readFile(resolve(directory, "codex_app_server_protocol.v2.schemas.json"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async probeSchema(): Promise<void> {
    const schema = await this.generateSchema();
    const expected = PINNED_PROTOCOLS[this.expectedVersion][this.experimental ? "experimental" : "standard"];
    if (createHash("sha256").update(schema).digest("hex") !== expected) throw new RuntimeProtocolError("Codex App Server schema changed; review capabilities before use");
  }

  /** Used-surface check: the schema must still accept every request evoLoop sends. */
  private async probeSurface(): Promise<ProtocolFeatures> {
    const schema = await this.generateSchema();
    let parsed: unknown;
    try { parsed = JSON.parse(schema.toString("utf8")); } catch { throw new RuntimeProtocolError("Codex App Server schema is not JSON"); }
    const report = checkUsedSurface(parsed);
    if (report.problems.length)
      throw new RuntimeProtocolError(`Codex App Server schema no longer covers the used surface: ${report.problems.slice(0, 5).join("; ")}`);
    return report.features;
  }

  /**
   * Throws RuntimeNotSentError only from checks that run before stdin.write(). After write() is
   * called the bytes may reach the App Server, so any later loss stays an unknown outcome.
   */
  private send(message: unknown): void {
    const method = nonempty(object(message)?.method) ? object(message)!.method as string : "response";
    if (!this.child || !this.child.stdin.writable || this.child.stdin.destroyed)
      throw new RuntimeNotSentError(method, "App Server disconnected");
    let line: string;
    try { line = `${JSON.stringify(message)}\n`; }
    catch { throw new RuntimeNotSentError(method, "message is not serializable"); }
    this.child.stdin.write(line);
  }

  /** readOnly: a list request that cannot change a thread, so its timeout or failure keeps fresh-start proofs. */
  private request(method: string, params: unknown, timeoutMs = this.timeout,
    beforeSend?: (requestId: number) => Promise<void>, afterSend?: () => void, readOnly = false): Promise<unknown> {
    if (!this.child) return Promise.reject(new RuntimeNotSentError(method, "App Server not open"));
    const threadId=object(params)?.threadId;
    // Invalidate before sending, including rejected or unknown native operations.
    if(nonempty(threadId)&&['turn/start','turn/interrupt','thread/resume','thread/archive'].includes(method))
      this.freshThreads.delete(threadId);
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!readOnly) this.freshThreads.clear();
        reject(new RuntimeUnknownError(method, id, "response timeout"));
      }, timeoutMs);
      this.pending.set(id, { method, threadId: nonempty(threadId) ? threadId : null, resolve: value => {
        const result=object(value),thread=object(result?.thread);
        const saved=nonempty(threadId)?this.bindings.get(threadId):undefined;
        // notLoaded and missing rollout are legal zero-Turn read observations.
        if(nonempty(threadId)&&(
          (thread&&saved&&(thread.id!==threadId||thread.sessionId!==saved.nativeSessionId||thread.cwd!==saved.cwd))||
          (Array.isArray(thread?.turns)&&thread.turns.length>0)||
          ['active','systemError','unknown'].includes(String(object(thread?.status)?.type))||
          (method==='thread/turns/list'&&Array.isArray(result?.data)&&result.data.length>0)))
          this.freshThreads.delete(threadId);
        resolveResult(value);
      }, reject, timer });
      const fail = (error: unknown) => {
        clearTimeout(timer); this.pending.delete(id);
        if (!readOnly) this.freshThreads.clear();
        // Only a pre-write refusal from send() proves nothing reached the App Server.
        reject(error instanceof RuntimeNotSentError ? error :
          new RuntimeUnknownError(method, id, error instanceof Error ? error.message : "send failed"));
      };
      const write=()=>{this.send({ id, method, params });afterSend?.()};
      if (beforeSend) void beforeSend(id).then(() => {
        if (this.pending.has(id)) write();
      }).catch(fail);
      else try { write(); } catch (error) { fail(error); }
    });
  }

  private receive(line: string): void {
    let message: Record<string, unknown> | null;
    try { message = object(JSON.parse(line)); } catch { this.disconnect("malformed JSON"); return; }
    if (!message) { this.disconnect("non-object message"); return; }
    if ("method" in message) {
      if (!nonempty(message.method)) { this.disconnect("invalid method"); return; }
      if ("id" in message) { void this.serverRequest(message).catch(() => this.disconnect("server request response failed")); return; }
      if(message.method==='serverRequest/resolved'){
        this.resolveNativeInput(message.params);
        return;
      }
      const params = object(message.params);
      const threadId = params?.threadId;
      if (!nonempty(threadId) || !this.bindings.has(threadId)) return;
      const turn = object(params?.turn);
      const status=object(params?.status)?.type??params?.status;
      if(nonempty(params?.turnId)||nonempty(turn?.id)||
        message.method==='thread/status/changed'&&['active','systemError','unknown'].includes(String(status)))
        this.freshThreads.delete(threadId);
      const binding = this.bindings.get(threadId)!;
      const event: RuntimeEvent = { method: message.method, projectId: binding.projectId, sessionId: binding.sessionId,
        threadId, params: message.params, ...(nonempty(params?.turnId) ? { turnId: params.turnId } : nonempty(turn?.id) ? { turnId: turn.id } : {}) };
      for (const listener of this.events) { try { listener(event); } catch { /* observers cannot break transport */ } }
      const update=mapWorkspaceEvent(message.method,message.params,binding,new Date().toISOString(),this.connectionId);
      if(update)for(const listener of this.workspaceUpdates){try{listener(update);}catch{/* observers cannot break transport */}}
      return;
    }
    if (typeof message.id !== "number" || !Number.isInteger(message.id)) { this.disconnect("invalid response id"); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return; // A late reply to a timed-out request does not turn an unknown operation into a retry.
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if ("error" in message) {
      const error = object(message.error);
      const code = typeof error?.code === "number" && Number.isInteger(error.code) ? error.code : -32000;
      const nativeMessage = typeof error?.message === "string" ? error.message : "";
      pending.reject(new RuntimeServerError(pending.method, message.id, code, nativeMessage,
        pending.threadId ?? undefined, error?.data));
    }
    else if ("result" in message) pending.resolve(message.result);
    else { pending.reject(new RuntimeProtocolError(`${pending.method}: response lacks result`)); this.disconnect("malformed response"); }
  }

  private async emitNativeInput(event:NativeInputEvent):Promise<void>{
    for(const listener of this.nativeInputListeners)await listener(event);
  }

  private closeNativeInput(handle:string,reason:'native_resolved'|'disconnected'|'unsupported'):void{
    const pending=this.pendingNativeInputs.get(handle);
    if(!pending)return;
    this.pendingNativeInputs.delete(handle);
    this.nativeRequestHandles.delete(nativeRequestKey(pending.requestId)!);
    void this.emitNativeInput({type:'closed',projectId:pending.capture.projectId,id:handle,
      connectionId:pending.capture.connectionId,reason,observedAt:new Date().toISOString()}).catch(()=>undefined);
  }

  private resolveNativeInput(value:unknown):void{
    const params=object(value),key=nativeRequestKey(params?.requestId);
    if(!key||!nonempty(params?.threadId))return;
    const handle=this.nativeRequestHandles.get(key);
    const pending=handle?this.pendingNativeInputs.get(handle):null;
    if(pending?.capture.threadId===params.threadId)this.closeNativeInput(handle!,'native_resolved');
  }

  private async handleNativeInput(message:Record<string,unknown>,binding:RuntimeBinding|undefined):Promise<void>{
    const id=message.id,key=nativeRequestKey(id),method=message.method;
    if(!key){this.disconnect('unsafe native input request id');return;}
    if(this.seenNativeRequestIds.has(key))return; // Never issue two responses for one typed JSON-RPC id.
    this.seenNativeRequestIds.add(key);
    const unsupported=(reason:string):void=>{
      if(method==='mcpServer/elicitation/request')this.send({id,result:{action:'decline'}});
      else this.send({id,error:{code:-32601,message:reason}});
    };
    if(!binding||!this.connectionId||!this.ready){unsupported('Unregistered thread');return;}
    const params=object(message.params);
    const isTool=method==='item/tool/requestUserInput';
    const validIdentity=params?.threadId===binding.nativeThreadId;
    if(!validIdentity){unsupported('Unregistered thread');return;}
    if(!boundedText(binding.nativeThreadId,1024)||
      (isTool&&!boundedText(params?.turnId,1024))||
      (params?.turnId!=null&&!boundedText(params.turnId,1024))){
      unsupported('Native input identity is unavailable');return;
    }
    const supportedProtocol=this.features.modern&&this.experimental;
    const observer=this.nativeInputListeners.size>0;
    const questions=isTool?nativeInputQuestions(params?.questions):null;
    const secret=isTool&&Array.isArray(params?.questions)&&params.questions.some(value=>object(value)?.isSecret===true);
    let supported=!!(isTool&&supportedProtocol&&observer&&
      boundedText(params?.itemId,1024)&&typeof params?.isBlocking==='boolean'&&questions);
    let reason=supported?null:!isTool?'MCP_ELICITATION_UNSUPPORTED':
      secret?'SECRET_INPUT_UNSUPPORTED':!supportedProtocol?'NATIVE_INPUT_PROTOCOL_UNAVAILABLE':
      !observer?'NATIVE_INPUT_OBSERVER_UNAVAILABLE':'NATIVE_INPUT_SHAPE_UNSUPPORTED';
    const capture:NativeInputCapture={
      projectId:binding.projectId,sessionId:binding.sessionId,id:randomUUID(),connectionId:this.connectionId,
      nativeRequestId:id as string|number,threadId:binding.nativeThreadId,
      turnId:boundedText(params?.turnId,1024)?params.turnId:null,
      itemId:boundedText(params?.itemId,1024)?params.itemId:null,
      method:method as NativeInputCapture['method'],questions:supported?questions!:[],
      isBlocking:typeof params?.isBlocking==='boolean'?params.isBlocking:false,
      supported,unavailableReason:reason,observedAt:new Date().toISOString(),
    };
    if(supported&&new TextEncoder().encode(JSON.stringify(capture)).byteLength>32768){
      supported=false;reason='NATIVE_INPUT_TOO_LARGE';
      capture.supported=false;capture.questions=[];capture.unavailableReason=reason;
    }
    if(!observer){unsupported(reason!);return;}
    if(supported){
      this.pendingNativeInputs.set(capture.id,{capture,requestId:id as string|number,attempted:false});
      this.nativeRequestHandles.set(key,capture.id);
    }
    try{await this.emitNativeInput({type:'requested',request:capture});}
    catch{
      if(supported)this.closeNativeInput(capture.id,'unsupported');
      unsupported('Native input capture unavailable');
      return;
    }
    if(!supported){
      unsupported(reason!);
      void this.emitNativeInput({type:'closed',projectId:capture.projectId,id:capture.id,
        connectionId:capture.connectionId,reason:'unsupported',observedAt:new Date().toISOString()}).catch(()=>undefined);
    }
  }

  private async serverRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    // An invalid request is answered alone; the shared connection and other Sessions' Turns stay up.
    if ((typeof id !== "number" && typeof id !== "string") || !nonempty(message.method)) {
      this.send({ id: null, error: { code: -32600, message: "Invalid request" } }); return;
    }
    const params = object(message.params);
    const threadId = params?.threadId ?? params?.conversationId;
    const binding = nonempty(threadId) ? this.bindings.get(threadId) : undefined;
    if(message.method==='item/tool/requestUserInput'||message.method==='mcpServer/elicitation/request'){
      await this.handleNativeInput(message,binding);
      return;
    }
    const creating = !binding && nonempty(threadId) && APPROVAL_METHODS.has(message.method) ? this.pendingCreate : null;
    const request: RuntimeApprovalRequest = { id, method: message.method, params: message.params,
      ...(binding ? { projectId: binding.projectId, sessionId: binding.sessionId } :
        creating ? { projectId: creating.projectId, sessionId: creating.sessionId } : {}),
      ...(nonempty(threadId) ? { threadId } : {}), ...(nonempty(params?.turnId) ? { turnId: params.turnId } : {}) };
    if (message.method === "currentTime/read") {
      if (!this.features.modern) {
        this.send({ id, error: { code: -32601, message: "Unsupported server request" } }); return;
      }
      if (!binding || params?.threadId !== binding.nativeThreadId) {
        this.send({ id, error: { code: -32000, message: "Unregistered thread" } }); return;
      }
      this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }); return;
    }
    if (creating && this.approvals.size === 0) { this.disconnect("approval evidence observer unavailable"); return; }
    if (message.method === "item/tool/call") {
      const call = params;
      const key = nonempty(call?.threadId) && nonempty(call?.callId) ? `${call.threadId}\0${call.callId}` : null;
      const valid = !!binding && !binding.authorizationScope.startsWith('connector-receiver:') &&
        !!key && !this.seenToolCalls.has(key) && call?.namespace == null &&
        nonempty(call?.turnId) && nonempty(call?.tool) && !!object(call?.arguments) &&
        this.declaredTools.get(binding.nativeThreadId)?.has(call.tool) && !!this.options.callDynamicTool;
      if (!valid) { this.send({id,result:{contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false}}); return; }
      this.seenToolCalls.add(key!);
      if (this.seenToolCalls.size > MAX_SEEN_TOOL_CALLS) this.seenToolCalls.delete(this.seenToolCalls.values().next().value!);
      const failed: DynamicToolResult = {contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false};
      const controller=new AbortController();
      const request:DynamicToolCall={threadId:call!.threadId as string,turnId:call!.turnId as string,
        callId:call!.callId as string,tool:call!.tool as string,arguments:call!.arguments as Record<string,unknown>,signal:controller.signal};
      let timer:NodeJS.Timeout|undefined;
      let result:DynamicToolResult=failed;
      try {
        result = await Promise.race([
          this.options.callDynamicTool!(request,binding!),
          new Promise<DynamicToolResult>(resolveTimedOut=>{timer=setTimeout(()=>{
            controller.abort();
            try { void Promise.resolve(this.options.cancelDynamicTool?.(request,binding!)).catch(()=>{}); }
            catch { /* Timeout still returns a denial. */ }
            resolveTimedOut(failed);
          },this.dynamicToolTimeout);}),
        ]);
      } catch { /* Never expose raw browser, credential, or database errors to the model. */ }
      finally { if(timer)clearTimeout(timer); }
      if (controller.signal.aborted) result=failed;
      this.send({id,result}); return;
    }
    if ((binding || creating) && APPROVAL_METHODS.has(message.method)) {
      try { for (const listener of this.approvals) await listener(request); }
      catch { this.disconnect("approval evidence unavailable"); return; }
    }
    if (creating) {
      // Even a successful observer cannot authenticate a thread until thread/start replies.
      const legacy = message.method === "applyPatchApproval" || message.method === "execCommandApproval";
      this.send({ id, result: { decision: legacy ? "denied" : "decline" } });
      return;
    }
    if (!binding) { this.send({ id, error: { code: -32000, message: "Unregistered thread" } }); return; }
    if (!APPROVAL_METHODS.has(message.method)) {
      // Unknown requests cannot be silently answered as consent. Native input is handled above.
      this.send({ id, error: { code: -32601, message: "Unsupported server request" } });
      return;
    }
    let decision: "accept" | "decline" = "decline";
    if (this.options.decideApproval && !binding.authorizationScope.startsWith('connector-receiver:')) {
      let timer: NodeJS.Timeout | undefined;
      try {
        decision = await Promise.race([
          this.options.decideApproval(request, binding),
          new Promise<"decline">(resolveDecision => { timer = setTimeout(() => resolveDecision("decline"), this.timeout); }),
        ]);
      } catch { /* deny */ }
      finally { if (timer) clearTimeout(timer); }
    }
    if (decision !== "accept") decision = "decline";
    const legacy = message.method === "applyPatchApproval" || message.method === "execCommandApproval";
    this.send({ id, result: { decision: legacy ? decision === "accept" ? "approved" : "denied" : decision } });
  }

  private disconnect(reason: string, stopReason: NativeChildStopReason = 'protocol_error'): void {
    const wasConnected = this.ready || !!this.child;
    if(this.child&&this.connectionId&&this.childStartedAtUtc){
      const observedAtUtc=new Date().toISOString();
      this.childDiagnostics.push({startId:this.connectionId,
        pid:Number.isSafeInteger(this.child.pid)?this.child.pid!:null,
        startedAtUtc:this.childStartedAtUtc,observedAtUtc,firstLossAtUtc:observedAtUtc,
        firstLossReason:stopReason,stopReason,exitObserved:false,exitedAtUtc:null,
        exitCode:null,exitSignal:null,nativeTurnOutcome:'unknown'});
      if(this.childDiagnostics.length>MAX_CHILD_DIAGNOSTICS)this.childDiagnostics.shift();
      this.emitChildDiagnostic(this.childDiagnostics.at(-1)!);
    }
    if(wasConnected)for(const binding of this.bindings.values()){
      const update:WorkspaceRuntimeUpdate={kind:'reset',projectId:binding.projectId,sessionId:binding.sessionId,
        threadId:binding.nativeThreadId,turnId:null,observedAt:new Date().toISOString(),reason:'owner connection changed'};
      for(const listener of this.workspaceUpdates){try{listener(update);}catch{/* observers cannot break transport */}}
    }
    this.ready = false;
    this.modelListCache=null;
    this.modelListPending=null;
    this.conversationQualifications.clear();
    this.freshThreads.clear();
    for(const handle of [...this.pendingNativeInputs.keys()])this.closeNativeInput(handle,'disconnected');
    this.connectionId=null;
    const child = this.child; this.child = null;
    // Signal the group even when the leader already exited: tools it started may still run.
    if (child) signalProcessGroup(child, "SIGTERM");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeUnknownError(pending.method, id, reason));
    }
    this.pending.clear();
    if (wasConnected) for (const listener of this.disconnects) { try { listener(reason); } catch { /* transport teardown continues */ } }
  }

  /** Re-register only a binding verified against the trusted project store. */
  async registerBinding(binding: RuntimeBinding): Promise<void> {
    this.validateBinding(binding);
    if (!this.options.verifyBinding || !await this.options.verifyBinding(binding)) throw new RuntimeProtocolError("binding provenance not verified");
    // The trusted store has confirmed this binding. Where effort rides on each turn/start (no thread/settings/update), a revision that
    // changed only the effort replaces the registered one; any other difference is still a conflict.
    this.rememberBinding(binding, true);
  }

  /** Exact, unused thread/start proof on this owner connection; no native Turn has been attempted. */
  /** Without thread/settings/update (Codex 0.167 and others) effort cannot change on a live Thread; it rides on each turn/start. */
  appliesEffortWithNextTurn(_binding: RuntimeBinding): boolean { return !this.features.executionProfileSwitch; }
  hasFreshStartProof(binding: RuntimeBinding): boolean {
    this.owned(binding);
    const fresh=this.freshThreads.get(binding.nativeThreadId);
    return !!fresh&&!fresh.claimed&&fresh.connectionId===this.connectionId&&
      sameBinding(fresh.binding,binding);
  }

  private validateBinding(binding: RuntimeBinding): void {
    if (binding.owner !== OWNER || !nonempty(binding.authorizationScope) || !nonempty(binding.projectId) || !nonempty(binding.roleId) || !nonempty(binding.sessionId) || !nonempty(binding.nativeThreadId) || !binding.cwd.startsWith("/") || resolve(binding.cwd) !== binding.cwd) throw new RuntimeProtocolError("invalid runtime binding");
    if(binding.authorizationScope.startsWith('connector-receiver:')&&
      (this.expectedVersion!=='codex-cli 0.166.0-alpha.6'||!binding.resumeProfile||
        !nonempty(binding.resumeProfile.actorId)||!connectorReceiver({...binding.resumeProfile,authorizationScope:binding.authorizationScope})))
      throw new RuntimeProtocolError('connector receiver binding requires the pinned restricted native profile');
  }

  private rememberBinding(binding: RuntimeBinding, replaceEffortRevision = false): void {
    this.validateBinding(binding);
    const existing = this.bindings.get(binding.nativeThreadId);
    if (existing && !sameBinding(existing, binding) &&
      !(replaceEffortRevision && !this.features.executionProfileSwitch && effortRevisionOnly(existing, binding)))
      throw new RuntimeProtocolError("conflicting runtime binding");
    this.bindings.set(binding.nativeThreadId, binding);
  }

  private owned(binding: RuntimeBinding): void {
    const saved = this.bindings.get(binding.nativeThreadId);
    if (!saved || !sameBinding(saved, binding)) throw new RuntimeProtocolError("thread is not registered to this adapter and scope");
    // No connection: nothing for this call can have been written.
    if (!this.ready) throw new RuntimeNotSentError("thread", "App Server not ready");
  }

  async create(spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    if (!this.ready) throw new RuntimeProtocolError("App Server not ready");
    if (!nonempty(spec.sessionId) || !nonempty(spec.roleId) || !nonempty(spec.projectId) || !nonempty(spec.authorizationScope) || !spec.cwd.startsWith("/") || resolve(spec.cwd) !== spec.cwd) throw new RuntimeProtocolError("invalid session scope or cwd");
    if(!nativeProfile(spec,this.expectedVersion))throw new RuntimeProtocolError('new Session requires full policy or an exact alpha.6 connector receiver read-only/never scope');
    if(connectorReceiver(spec)&&!nonempty(spec.actorId))throw new RuntimeProtocolError('connector receiver requires a fixed actor before native creation');
    // thread/start carries no effort; a requested effort would otherwise be silently dropped.
    if(spec.reasoningEffort!=null)throw new RuntimeProtocolError('reasoning effort can only be set by execution profile activation');
    if (this.pendingCreate) throw new RuntimeProtocolError("another thread creation is pending");
    this.pendingCreate = { ...spec };
    const connectionId=this.connectionId;
    try {
      const restricted=connectorReceiver(spec);
      // Do not add host config or dynamic tools to a restricted Thread.
      // Native built-in shell disablement is not proven, so its Turn start remains closed.
      const config = restricted?undefined:await this.options.threadConfig?.(spec);
      const dynamicTools = !restricted&&this.options.dynamicTools && this.options.callDynamicTool ? await this.options.dynamicTools(spec) : undefined;
      // Freeze provider-owned objects before awaiting the native acknowledgement.
      const launchConfig=policyJson(config??null),launchTools=policyJson(dynamicTools??[]);
      const result = object(await this.request("thread/start", { cwd: spec.cwd, ...(spec.model ? { model: spec.model } : {}), sandbox: spec.sandbox, approvalPolicy: spec.approvalPolicy, serviceName: "evoloop", ...(config ? {config} : {}), ...(dynamicTools?.length ? {dynamicTools} : {}) }));
      const thread = object(result?.thread);
      if (!nonempty(thread?.id) || !nonempty(thread?.sessionId) || thread?.cwd !== spec.cwd) throw new RuntimeUnknownError("thread/start", null, "invalid acknowledgement; native thread may exist");
      const sandbox=object(result?.sandbox);
      if(result?.cwd!==spec.cwd||result?.approvalPolicy!=='never'||!nativeSandboxConfirmed(sandbox,spec.sandbox)||
        !nonempty(result?.model)||!nonempty(result?.modelProvider)||
        (spec.model!=null&&result.model!==spec.model)||
        (thread.model!=null&&thread.model!==result.model))
        throw new RuntimeUnknownError('thread/start',null,'Session creation acknowledgement did not confirm exact native policy');
      const binding: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId, authorizationScope: spec.authorizationScope, cwd: spec.cwd, nativeThreadId: thread.id, nativeSessionId: thread.sessionId, owner: OWNER,
        observedModel:safeModelIdentity(result.model),observedProvider:safeModelIdentity(result.modelProvider),
        ...(spec.actorId ? {resumeProfile:{actorId:spec.actorId,model:spec.model??null,sandbox:spec.sandbox,
          approvalPolicy:spec.approvalPolicy,...(spec.executionProfileRevisionId?
            {executionProfileRevisionId:spec.executionProfileRevisionId}:{})}} : {}) };
      this.rememberBinding(binding);
      if (dynamicTools?.length) this.declaredTools.set(binding.nativeThreadId,new Set(dynamicTools.map(tool=>tool.name)));
      if(connectionId&&connectionId===this.connectionId&&this.ready&&
        (!Array.isArray(thread.turns)||thread.turns.length===0))
        this.freshThreads.set(binding.nativeThreadId,{connectionId,binding,
          config:launchConfig,tools:launchTools,claimed:false});
      return binding;
    } finally { this.pendingCreate = null; }
  }

  async resume(binding: RuntimeBinding, spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    return (await this.resumeBinding(binding,spec)).binding;
  }

  private async resumeBinding(binding:RuntimeBinding,spec:RuntimeSessionSpec):Promise<{binding:RuntimeBinding;usedStartProof:boolean}> {
    const fresh=this.freshThreads.get(binding.nativeThreadId);
    const first=fresh&&!fresh.claimed;
    if(fresh)fresh.claimed=true; // Reserve once, before any provider await or validation failure.
    try {
      this.owned(binding);
      this.conversationQualifications.delete(binding.nativeThreadId);
      if (!spec || !nonempty(spec.actorId) || spec.sessionId !== binding.sessionId || spec.roleId !== binding.roleId ||
        spec.projectId !== binding.projectId || spec.authorizationScope !== binding.authorizationScope ||
        spec.cwd !== binding.cwd || resolve(spec.cwd) !== spec.cwd ||
        !nativeProfile(spec,this.expectedVersion) ||
        !binding.resumeProfile || binding.resumeProfile.actorId !== spec.actorId ||
        binding.resumeProfile.model !== (spec.model??null) ||
        (binding.resumeProfile.reasoningEffort??null)!==(spec.reasoningEffort??null) ||
        binding.resumeProfile.sandbox !== spec.sandbox ||
        binding.resumeProfile.approvalPolicy !== spec.approvalPolicy ||
        (binding.resumeProfile.executionProfileRevisionId??null)!==(spec.executionProfileRevisionId??null))
        throw new RuntimeProtocolError("resume profile does not match registered binding");
      // The native rollout may retain an old declaration. Rebuild the host allowlist
      // only from the current trusted business scope, and keep it empty until the
      // exact owned resume (or matching full thread/start proof) is confirmed.
      // A failed provider or native RPC cannot
      // leave an earlier allowlist open.
      this.declaredTools.delete(binding.nativeThreadId);
      const restricted=connectorReceiver(spec);
      const config = restricted?undefined:await this.options.threadConfig?.(spec);
      let currentTools:DynamicToolSpec[]|undefined;
      if (!restricted&&this.options.dynamicTools && this.options.callDynamicTool) {
        try { currentTools=await this.options.dynamicTools(spec); }
        catch { throw new RuntimeProtocolError("current dynamic tool declaration is unavailable"); }
      }
      const currentNames = new Set<string>();
      if (currentTools !== undefined) {
        if (!Array.isArray(currentTools)) throw new RuntimeProtocolError("invalid current dynamic tool declaration");
        for (const tool of currentTools) {
          const declaration=object(tool);
          if (declaration?.type !== "function" || !nonempty(declaration.name) ||
            !nonempty(declaration.description) || !object(declaration.inputSchema) ||
            currentNames.has(declaration.name))
            throw new RuntimeProtocolError("invalid current dynamic tool declaration");
          currentNames.add(declaration.name);
        }
      }
      this.owned(binding); // Providers can yield across disconnect or binding changes.
      if(first&&this.freshThreads.get(binding.nativeThreadId)===fresh&&
        fresh.connectionId===this.connectionId&&sameBinding(fresh.binding,binding)&&
        fresh.config===policyJson(config??null)&&fresh.tools===policyJson(currentTools??[])){
        this.freshThreads.delete(binding.nativeThreadId);
        if(currentNames.size)this.declaredTools.set(binding.nativeThreadId,currentNames);
        return {binding,usedStartProof:true};
      }
      const result = object(await this.request("thread/resume", { threadId: binding.nativeThreadId,
        excludeTurns: true, cwd: spec.cwd, ...(spec.model ? { model: spec.model } : {}),
        sandbox: spec.sandbox, approvalPolicy: spec.approvalPolicy, ...(config ? { config } : {}) }));
      const thread = object(result?.thread);
      if (thread?.id !== binding.nativeThreadId || thread?.sessionId !== binding.nativeSessionId || thread?.cwd !== binding.cwd) throw new RuntimeProtocolError("resumed thread does not match registered binding");
      this.assertRevisedProfileReply(result,binding,spec);
      if (currentNames.size) this.declaredTools.set(binding.nativeThreadId,currentNames);
      return {binding,usedStartProof:false};
    } finally {
      if(this.freshThreads.get(binding.nativeThreadId)===fresh)this.freshThreads.delete(binding.nativeThreadId);
    }
  }

  private revisedBinding(current: RuntimeBinding, target: RuntimeSessionSpec,
    revisionId: string, operationId: string): RuntimeBinding {
    this.validateBinding(current);
    const old=current.resumeProfile;
    if(!old||!nonempty(old.executionProfileRevisionId)||!nonempty(revisionId)||!nonempty(operationId)||
      old.executionProfileRevisionId===revisionId||target.executionProfileRevisionId!==revisionId||
      !nonempty(target.actorId)||!nonempty(target.model)||
      target.actorId!==old.actorId||target.sessionId!==current.sessionId||target.roleId!==current.roleId||
      target.projectId!==current.projectId||target.cwd!==current.cwd||
      target.authorizationScope!==current.authorizationScope||
      !fullProfile(target))
      throw new RuntimeProtocolError('execution profile revision changed owned identity or lacks a durable target');
    return {...current,resumeProfile:{...old,model:target.model,reasoningEffort:target.reasoningEffort??null,sandbox:target.sandbox,
      approvalPolicy:target.approvalPolicy,executionProfileRevisionId:revisionId}};
  }

  private async authorizeRevision(current:RuntimeBinding,target:RuntimeSessionSpec,
    revisionId:string,operationId:string):Promise<RuntimeBinding>{
    const revised=this.revisedBinding(current,target,revisionId,operationId);
    if(!this.options.authorizeExecutionProfileActivation||
      !await this.options.authorizeExecutionProfileActivation(current,target,revisionId,operationId))
      throw new RuntimeProtocolError('persisted execution profile activation permit is unavailable');
    const registered=this.bindings.get(current.nativeThreadId);
    if(registered&&!sameBinding(registered,current)&&!sameBinding(registered,revised))
      throw new RuntimeProtocolError('registered Thread has a different execution profile');
    if(!registered)this.rememberBinding(current);
    this.profileTransitionThreads.add(current.nativeThreadId);
    return revised;
  }

  private assertRevisedProfileReply(reply:Record<string,unknown>|null,
    current:RuntimeBinding,target:RuntimeSessionSpec):void{
    const thread=object(reply?.thread),sandbox=object(reply?.sandbox);
    if(!thread||thread.id!==current.nativeThreadId||thread.sessionId!==current.nativeSessionId||
      thread.cwd!==current.cwd||!nonempty(reply?.model)||
      (target.model!=null&&reply.model!==target.model)||
      (thread.model!=null&&thread.model!==reply.model)||
      !nonempty(reply?.modelProvider)||reply?.cwd!==current.cwd||
      reply?.approvalPolicy!=='never'||!nativeSandboxConfirmed(sandbox,target.sandbox))
      throw new RuntimeUnknownError('thread/resume',null,'execution profile reply did not confirm the exact owned Thread and model');
  }

  /** Called only after the coordinator has durably claimed this one revision's activation. */
  async activateExecutionProfile(current:RuntimeBinding,target:RuntimeSessionSpec,
    revisionId:string,operationId:string):Promise<RuntimeBinding>{
    if(target.reasoningEffort){
      // A newly created Thread can be notLoaded with no rollout. Resuming it
      // consumes its one first-dispatch proof without loading a usable Thread.
      // Reject before marking an activation attempt; the original first Turn
      // can still use its exact saved profile.
      this.owned(current);
      const result=object(await this.request('thread/read',{threadId:current.nativeThreadId,includeTurns:false}));
      const thread=object(result?.thread);
      if(thread?.id!==current.nativeThreadId||thread?.sessionId!==current.nativeSessionId||
        thread?.cwd!==current.cwd)throw new RuntimeProtocolError('profile activation lost the owned Thread');
      if(['idle','notLoaded'].includes(String(object(thread.status)?.type))&&this.hasFreshStartProof(current))
        throw new RuntimeProtocolError('EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED: original first Turn has not started; complete it under the current profile');
      if(object(thread.status)?.type==='notLoaded'){
        let hasRollout=false;
        try{hasRollout=(await this.listTurns(current)).data.length>0;}
        catch(error){
          if(!(error instanceof RuntimeServerError&&error.method==='thread/turns/list'&&
            error.code===-32600&&error.category==='rollout_not_found'))throw error;
        }
        if(!hasRollout)throw new RuntimeProtocolError('EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED: zero-turn Thread has no rollout for effort activation; complete its first Turn under the current profile');
      }
    }
    const revised=await this.authorizeRevision(current,target,revisionId,operationId);
    if(!sameBinding(this.bindings.get(current.nativeThreadId)!,current))
      throw new RuntimeProtocolError('execution profile activation was already attempted in this adapter');
    if(!await this.nativeThreadIdle(current,true))
      throw new RuntimeProtocolError('owned Thread is active; execution profile cannot be applied');
    if(target.reasoningEffort){
      if(!fullProfile(current.resumeProfile!))
        throw new RuntimeProtocolError('model and effort activation requires a previously confirmed full-access profile');
      const before=object(await this.request('thread/read',{threadId:current.nativeThreadId,includeTurns:false}));
      const priorThread=object(before?.thread);
      if(priorThread?.id!==current.nativeThreadId||priorThread?.sessionId!==current.nativeSessionId||
        priorThread?.cwd!==current.cwd)throw new RuntimeProtocolError('profile activation lost the owned Thread');
      if(object(priorThread.status)?.type==='notLoaded'){
        const prior=current.resumeProfile!;
        await this.resume(current,{actorId:prior.actorId,sessionId:current.sessionId,roleId:current.roleId,
          projectId:current.projectId,cwd:current.cwd,authorizationScope:current.authorizationScope,
          ...(prior.model?{model:prior.model}:{}),
          ...(prior.reasoningEffort?{reasoningEffort:prior.reasoningEffort}:{}),
          sandbox:prior.sandbox,approvalPolicy:prior.approvalPolicy,
          ...(prior.executionProfileRevisionId?{executionProfileRevisionId:prior.executionProfileRevisionId}:{})});
      }
      if(!await this.nativeThreadIdle(current,false,current.resumeProfile?.model??undefined))
        throw new RuntimeUnknownError('thread/resume',null,'original Thread did not become idle under its last confirmed model');
      // The pinned App Server's loaded-thread resume may retain the old model.
      // This one durable attempt updates both fields together; the empty reply
      // merely acknowledges queuing, so only the exact readback can confirm it.
      await this.request('thread/settings/update',{
        threadId:current.nativeThreadId,model:target.model,effort:target.reasoningEffort,
        cwd:target.cwd,sandboxPolicy:FULL_POLICY,approvalPolicy:'never'});
      for(let attempt=0;attempt<10;attempt++){
        const result=object(await this.request('thread/read',{threadId:current.nativeThreadId,includeTurns:false}));
        const thread=object(result?.thread);
        if(thread?.id!==current.nativeThreadId||thread?.sessionId!==current.nativeSessionId||thread?.cwd!==current.cwd)
          throw new RuntimeUnknownError('thread/settings/update',null,'profile readback changed owned Thread');
        if(thread.model===target.model&&thread.reasoningEffort===target.reasoningEffort&&
          object(thread.status)?.type==='idle'){
          this.bindings.set(current.nativeThreadId,revised);
          this.profileTransitionThreads.delete(current.nativeThreadId);
          return revised;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new RuntimeUnknownError('thread/settings/update',null,'queued profile update has no exact model and effort readback');
    }
    const config=await this.options.threadConfig?.(target);
    const reply=object(await this.request('thread/resume',{
      threadId:current.nativeThreadId,excludeTurns:true,cwd:target.cwd,model:target.model,
      sandbox:target.sandbox,approvalPolicy:target.approvalPolicy,...(config?{config}:{})}));
    this.assertRevisedProfileReply(reply,current,target);
    this.bindings.set(current.nativeThreadId,revised);
    this.profileTransitionThreads.delete(current.nativeThreadId);
    // Activation confirms a model revision, not a later Run's dispatch operation.
    return revised;
  }

  /** Read-only reconciliation of a lost resume reply; never repeats the original native operation. */
  async inspectExecutionProfileActivation(current:RuntimeBinding,target:RuntimeSessionSpec,
    revisionId:string,operationId:string):Promise<RuntimeBinding|null>{
    const revised=await this.authorizeRevision(current,target,revisionId,operationId);
    const result=object(await this.request('thread/read',{threadId:current.nativeThreadId,includeTurns:false}));
    const thread=object(result?.thread);
    if(!thread||thread.id!==current.nativeThreadId||thread.sessionId!==current.nativeSessionId||thread.cwd!==current.cwd)
      throw new RuntimeProtocolError('profile readback did not match the owned Thread');
    if(thread.model!==target.model||target.reasoningEffort&&thread.reasoningEffort!==target.reasoningEffort||
      object(thread.status)?.type!=='idle')return null;
    // Thread/read has no effective sandbox or approval fields. A model-only readback
    // cannot prove that a legacy loaded Thread adopted full permissions.
    if(fullProfile(target)&&!fullProfile(current.resumeProfile!))return null;
    this.bindings.set(current.nativeThreadId,revised);
    this.profileTransitionThreads.delete(current.nativeThreadId);
    // Readback confirms the revision, not a later Run's dispatch operation.
    return revised;
  }

  private async nativeThreadIdle(binding:RuntimeBinding,allowNotLoaded=false,expectedModel?:string):Promise<boolean>{
    const result=object(await this.request('thread/read',{threadId:binding.nativeThreadId,includeTurns:false}));
    const thread=object(result?.thread);
    if(thread?.id!==binding.nativeThreadId||thread?.sessionId!==binding.nativeSessionId||thread?.cwd!==binding.cwd)
      throw new RuntimeProtocolError('native idle check does not match owned Session');
    const status=object(thread.status)?.type;
    return (status==='idle'||allowNotLoaded&&status==='notLoaded')&&
      (expectedModel===undefined||thread.model===expectedModel||
        allowNotLoaded&&status==='notLoaded'&&thread.model==null);
  }

  /** Identity evidence only. Alpha.6 exposes no verified switch that removes its built-in shell. */
  async qualifyConnectorReceiver(binding:RuntimeBinding,connectorBindingId:string):Promise<{
    available:boolean;reason:string;fingerprint:string|null}>{
    this.owned(binding);
    const unavailable=(reason:string)=>({available:false,reason,fingerprint:null});
    if(!CONNECTOR_SCOPE.test(`connector-receiver:${connectorBindingId}`)||
      binding.authorizationScope!==`connector-receiver:${connectorBindingId}`||
      !binding.resumeProfile||!connectorReceiver({...binding.resumeProfile,authorizationScope:binding.authorizationScope})||
      this.profileTransitionThreads.has(binding.nativeThreadId))
      return unavailable('Connector receiver identity or restricted profile is not exact');
    try{
      const result=object(await this.request('thread/read',{threadId:binding.nativeThreadId,includeTurns:false}));
      const thread=object(result?.thread);
      if(thread?.id!==binding.nativeThreadId||thread?.sessionId!==binding.nativeSessionId||thread?.cwd!==binding.cwd)
        return unavailable('Native Thread identity does not match connector receiver');
      const status=object(thread.status)?.type;
      if(status!=='idle'&&status!=='notLoaded')return unavailable('Native Thread is not idle');
      if(thread.model!=null&&(!nonempty(thread.model)||
        binding.resumeProfile.model!=null&&thread.model!==binding.resumeProfile.model))
        return unavailable('Native Thread model differs from connector receiver profile');
      const fingerprint=createHash('sha256').update(policyJson({
        admission:'evoloop-connector-receiver-v1',protocol:this.expectedVersion,
        connectorBindingId,projectId:binding.projectId,sessionId:binding.sessionId,
        roleId:binding.roleId,threadId:binding.nativeThreadId,nativeSessionId:binding.nativeSessionId,
        cwd:binding.cwd,scope:binding.authorizationScope,profile:binding.resumeProfile,
        nativeModel:thread.model??null,status,sandboxPolicy:{type:'readOnly',networkAccess:false},
        dynamicTools:[],nativeShellDisabled:false,
      })).digest('hex');
      return {available:false,reason:'Native alpha.6 shell disablement is not verified',fingerprint};
    }catch{return unavailable('Native connector receiver Thread could not be read');}
  }

  /** No native Turn is sent until built-in shell disablement can be verified. */
  async startConnectorTurn(binding:RuntimeBinding,input:string,operationId:string,
    connectorBindingId:string,fingerprint:string):Promise<RuntimeTurn>{
    if(!nonempty(input)||!nonempty(operationId)||!nonempty(fingerprint))
      throw new RuntimeProtocolError('connector Turn requires input, durable operation ID and policy fingerprint');
    const admission=await this.qualifyConnectorReceiver(binding,connectorBindingId);
    if(!admission.fingerprint||admission.fingerprint!==fingerprint)
      throw new RuntimeProtocolError('connector receiver policy fingerprint is unavailable or changed');
    throw new RuntimeProtocolError(admission.reason);
  }

  /** Admission evidence for an owned full-profile Thread, not proof of per-Turn native policy. */
  async qualifyConversationThread(binding:RuntimeBinding):Promise<{available:boolean;reason:string;fingerprint:string|null}>{
    this.owned(binding);
    const unavailable=(reason:string)=>{this.conversationQualifications.delete(binding.nativeThreadId);
      return {available:false,reason,fingerprint:null};};
    if(!this.features.modern)return unavailable('Full conversation readback requires a pinned modern protocol');
    if(!binding.resumeProfile||!fullProfile(binding.resumeProfile)||
      this.profileTransitionThreads.has(binding.nativeThreadId))
      return unavailable('Owned Session has no active full execution profile');
    try{
      const result=object(await this.request('thread/read',{threadId:binding.nativeThreadId,includeTurns:false}));
      const thread=object(result?.thread);
      if(thread?.id!==binding.nativeThreadId||thread?.sessionId!==binding.nativeSessionId||thread?.cwd!==binding.cwd)
        return unavailable('Native Thread identity does not match the owned Session');
      const status=object(thread.status)?.type;
      if(thread.model!=null&&(!nonempty(thread.model)||
        binding.resumeProfile.model!=null&&thread.model!==binding.resumeProfile.model))
        return unavailable('Owned native Thread model differs from the fixed profile');
      let terminalFailedTurn:RuntimeTurn|null=null;
      if(status==='systemError'){
        // A loaded Thread with an unknown model cannot use a failed Turn to prove safe admission.
        if(!nonempty(thread.model)||thread.model!==binding.resumeProfile.model)
          return unavailable('Owned native Thread model cannot be verified against the fixed profile');
        const latest=(await this.listTurns(binding)).data[0];
        if(latest?.status!=='failed'||!latest.completedAtUtc)
          return unavailable('Owned native Thread system error has no confirmed failed terminal Turn');
        terminalFailedTurn=latest;
      }else if(status==='active')return unavailable('Owned native Thread is active');
      else if(status!=='idle'&&status!=='notLoaded')
        return unavailable('Owned native Thread status is not ready');
      const model=nonempty(thread.model)?thread.model:binding.resumeProfile.model;
      const fingerprint=createHash('sha256').update(policyJson({
        admission:'evoloop-full-conversation-v1',protocol:this.protocolIdentity,
        projectId:binding.projectId,sessionId:binding.sessionId,roleId:binding.roleId,
        threadId:binding.nativeThreadId,nativeSessionId:binding.nativeSessionId,
        cwd:binding.cwd,scope:binding.authorizationScope,profile:binding.resumeProfile,model,status,
        terminalFailedTurn:terminalFailedTurn?{id:terminalFailedTurn.id,completedAtUtc:terminalFailedTurn.completedAtUtc}:null,
      })).digest('hex');
      const prior=this.conversationQualifications.get(binding.nativeThreadId);
      if(prior&&prior.fingerprint!==fingerprint)return unavailable('Owned Thread model or profile changed during admission');
      this.conversationQualifications.set(binding.nativeThreadId,{fingerprint,observedAt:Date.now(),model,status});
      return {available:true,reason:terminalFailedTurn?
        'Owned full-profile Thread has a confirmed failed terminal Turn; recheck it after exact full resume before the next Turn':
        'Owned full-profile Thread has no active Turn; exact full policy is confirmed on resume and sent on the Turn',fingerprint};
    }catch{return unavailable('Owned native Thread could not be read');}
  }

  /** Caller first persists the ordinary message dispatch; one operation gets one native start. */
  async startConversationTurn(binding:RuntimeBinding,input:string,operationId:string):Promise<RuntimeTurn>{
    this.owned(binding);
    if(!nonempty(input)||!nonempty(operationId)||!binding.resumeProfile||!fullProfile(binding.resumeProfile))
      throw new RuntimeProtocolError('full Session profile, input and durable operation ID required');
    const prior=this.conversationQualifications.get(binding.nativeThreadId);
    if(!prior||Date.now()-prior.observedAt>5000)
      throw new RuntimeProtocolError('ordinary Turn requires fresh owned full-profile admission');
    const threadId=binding.nativeThreadId;
    if(this.conversationTurnInFlight.has(threadId))
      throw new RuntimeLocalBusyError('turn/start','ordinary Turn start is already in flight on this Thread');
    if(this.fullTurnAttempts.get(threadId)?.has(operationId))
      throw new RuntimeProtocolError('original ordinary Turn operation cannot be replayed');
    this.conversationTurnInFlight.add(threadId);
    try{
      const rechecked=await this.qualifyConversationThread(binding);
      if(!rechecked.available||rechecked.fingerprint!==prior.fingerprint)
        throw new RuntimeProtocolError('owned full-profile Thread changed before ordinary Turn');
      this.conversationQualifications.delete(threadId);
      const profile=binding.resumeProfile;
      const resumed=await this.resumeBinding(binding,{
        actorId:profile.actorId,sessionId:binding.sessionId,roleId:binding.roleId,
        projectId:binding.projectId,cwd:binding.cwd,authorizationScope:binding.authorizationScope,
        ...(profile.model?{model:profile.model}:{}),sandbox:FULL_SANDBOX,approvalPolicy:'never',
        reasoningEffort:profile.reasoningEffort??null,
        ...(profile.executionProfileRevisionId?{executionProfileRevisionId:profile.executionProfileRevisionId}:{}),
      });
      if(prior.status==='systemError'){
        // Pinned App Server reattaches a loaded failed Thread without clearing
        // systemError. Its next turn/start clears that flag. Recheck the exact
        // failed Turn and profile after resume, before the one native start.
        const afterResume=await this.qualifyConversationThread(binding);
        if(!afterResume.available||afterResume.fingerprint!==prior.fingerprint)
          throw new RuntimeUnknownError('thread/resume',null,'owned failed Thread changed after exact full resume');
        this.conversationQualifications.delete(threadId);
      }else if(!await this.nativeThreadIdle(binding,resumed.usedStartProof,prior.model??undefined))
        throw new RuntimeUnknownError('thread/resume',null,'owned Thread did not become idle after exact full resume');
      // Only the native start can consume this operation. Reserve immediately before
      // sending; a lost acknowledgement must still prohibit replay.
      const attempts=this.fullTurnAttempts.get(threadId)??new Set<string>();
      if(attempts.has(operationId))throw new RuntimeProtocolError('original ordinary Turn operation cannot be replayed');
      attempts.add(operationId);this.fullTurnAttempts.set(threadId,attempts);
      let started:Record<string,unknown>|null;
      try{
        started=object(await this.request('turn/start',{
          threadId,input:[{type:'text',text:input}],clientUserMessageId:operationId,
          cwd:binding.cwd,...(prior.model!=null?{model:prior.model}:{}),
          ...(profile.reasoningEffort?{effort:profile.reasoningEffort}:{}),
          sandboxPolicy:FULL_POLICY,approvalPolicy:'never',
        }));
      }catch(error){
        if(error instanceof RuntimeProtocolError&&!(error instanceof RuntimeServerError)&&
          error.message==='turn/start: response lacks result')
          throw new RuntimeUnknownError('turn/start',null,'malformed acknowledgement; Turn may have started');
        throw error;
      }
      const turn=runtimeTurn(started?.turn);
      if(!turn||turn.status!=='inProgress'||turn.completedAtUtc!==null)
        throw new RuntimeUnknownError('turn/start',null,'invalid full conversation acknowledgement; Turn may have started');
      return profile.reasoningEffort?await this.withObservedEffort(binding,turn):turn;
    }finally{
      // A changed readback must not leave an implicit admission for another start.
      this.conversationQualifications.delete(threadId);
      this.conversationTurnInFlight.delete(threadId);
    }
  }

  /** Direct input on an idle owned Session. The caller persists the message ID before invoking this method. */
  async startOwnedIdleTurn(binding:RuntimeBinding,input:string,clientUserMessageId:string):Promise<RuntimeTurn>{
    if(!this.features.modern)
      throw new RuntimeProtocolError('idle direct input requires a pinned modern protocol');
    this.owned(binding);
    if(!nonempty(input)||!input.trim()||!nonempty(clientUserMessageId))
      throw new RuntimeProtocolError('input and durable client message ID required');
    if(this.fullTurnAttempts.get(binding.nativeThreadId)?.has(clientUserMessageId))
      throw new RuntimeProtocolError('original direct input operation cannot be replayed');
    const qualification=await this.qualifyConversationThread(binding);
    if(!qualification.available)
      throw new RuntimeProtocolError(qualification.reason);
    return this.startConversationTurn(binding,input,clientUserMessageId);
  }

  /** Add input to exactly the active Turn. An acknowledgement confirms enqueue only, not consumption. */
  async steerTurn(binding:RuntimeBinding,expectedTurnId:string,content:string,
    inputId:string):Promise<{turnId:string;itemId:string|null}>{
    this.owned(binding);
    if(!this.features.midTurnInput)
      throw new RuntimeProtocolError('mid-Turn input requires turn/steer in the pinned protocol');
    if(!binding.resumeProfile||!fullProfile(binding.resumeProfile)||
      this.profileTransitionThreads.has(binding.nativeThreadId))
      throw new RuntimeProtocolError('direct input requires an active full Session profile');
    if(!nonempty(content)||!content.trim()||!nonempty(expectedTurnId)||!nonempty(inputId))
      throw new RuntimeProtocolError('input, expected Turn ID and durable client message ID required');
    const threadId=binding.nativeThreadId;
    if(this.conversationTurnInFlight.has(threadId))
      throw new RuntimeLocalBusyError('turn/steer','direct input is already in flight on this Thread');
    if(this.fullTurnAttempts.get(threadId)?.has(inputId))
      throw new RuntimeProtocolError('original direct input operation cannot be replayed');
    this.conversationTurnInFlight.add(threadId);
    try{
      const result=object(await this.request('thread/read',{threadId,includeTurns:false}));
      const thread=object(result?.thread);
      if(thread?.id!==threadId||thread?.sessionId!==binding.nativeSessionId||thread?.cwd!==binding.cwd)
        throw new RuntimeProtocolError('active Thread readback does not match owned Session');
      if(object(thread.status)?.type!=='active')
        throw new RuntimeProtocolError('owned Thread has no active Turn to steer');
      if(binding.resumeProfile.model!=null&&thread.model!==binding.resumeProfile.model)
        throw new RuntimeProtocolError('active Thread model differs from fixed profile');
      // `expectedTurnId` is the authority the native runtime checks. A review/start Turn and its
      // execution child are not reported with the same ID in turns/list, so a local list comparison
      // would refuse a valid refusal probe. Send once and let the native error classify the Turn.
      this.owned(binding);
      const attempts=this.fullTurnAttempts.get(threadId)??new Set<string>();
      if(attempts.has(inputId))
        throw new RuntimeProtocolError('original direct input operation cannot be replayed');
      attempts.add(inputId);this.fullTurnAttempts.set(threadId,attempts);
      // clientUserMessageId is a correlation ID, not a native idempotency promise.
      let ack:Record<string,unknown>|null;
      try{
        ack=object(await this.request('turn/steer',{
          threadId,expectedTurnId,input:[{type:'text',text:content}],clientUserMessageId:inputId,
        }));
      }catch(error){
        if(error instanceof RuntimeProtocolError&&!(error instanceof RuntimeServerError)&&
          error.message==='turn/steer: response lacks result')
          throw new RuntimeUnknownError('turn/steer',null,'malformed acknowledgement; input may have been enqueued');
        throw error;
      }
      if(ack?.turnId!==expectedTurnId)
        throw new RuntimeUnknownError('turn/steer',null,'acknowledgement did not confirm the expected Turn');
      return {turnId:expectedTurnId,itemId:null};
    }finally{this.conversationTurnInFlight.delete(threadId);}
  }

  async inspect(binding: RuntimeBinding): Promise<unknown> {
    this.owned(binding);
    const result = object(await this.request("thread/read", { threadId: binding.nativeThreadId, includeTurns: false }));
    const thread = object(result?.thread);
    if (thread?.id !== binding.nativeThreadId || thread?.sessionId !== binding.nativeSessionId || thread?.cwd !== binding.cwd) throw new RuntimeProtocolError("read thread does not match binding");
    return result;
  }

  async observeCompaction(binding: RuntimeBinding, targetTurnId?:string): Promise<RuntimeCompactionObservation> {
    this.owned(binding);
    if (!this.features.compaction)
      throw new RuntimeProtocolError("compaction observation requires pinned alpha.6");
    const read = object(await this.inspect(binding));
    const thread = object(read?.thread)!;
    const listed = object(await this.request("thread/turns/list", {
      threadId: binding.nativeThreadId, limit: 5, sortDirection: "desc", itemsView: "summary",
    }));
    if (!Array.isArray(listed?.data)) throw new RuntimeProtocolError("compaction Turn listing unavailable");
    const first = targetTurnId
      ? listed.data.map(object).find(candidate=>candidate?.id===targetTurnId)??null
      : object(listed.data[0]);
    const turn = first ? runtimeTurn(first) : null;
    if (first && !turn) throw new RuntimeProtocolError("invalid compaction Turn");
    // The summary view is deliberately incomplete. Read the exact Turn's
    // persisted item entries before treating a compaction as completed.
    const itemPage = turn ? object(await this.request("thread/items/list", {
      threadId: binding.nativeThreadId, turnId: turn.id, limit: 20, sortDirection: "desc",
    })) : null;
    if (turn && !Array.isArray(itemPage?.data))
      throw new RuntimeProtocolError("compaction item history unavailable");
    const entries = Array.isArray(itemPage?.data) ? itemPage.data.map(object) : [];
    const entry = entries.find(value => object(value?.item)?.type === "contextCompaction") ?? null;
    const item = object(entry?.item);
    const usage = object(thread.tokenUsage);
    const total = object(usage?.total);
    return {
      threadId: binding.nativeThreadId,
      threadStatus: String(object(thread.status)?.type ?? "unknown"),
      model: typeof thread.model === "string" ? thread.model : null,
      reasoningEffort: typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : null,
      latestTurnId: turn?.id ?? null, latestTurnStatus: turn?.status ?? null,
      latestTurnCompletedAtUtc: turn?.completedAtUtc ?? null,
      compactionItemId: typeof item?.id === "string" ? item.id : null,
      compactionItemCompleted: Number.isSafeInteger(entry?.completedAtMs) && Number(entry?.completedAtMs) > 0,
      tokenUsage: total ? {
        inputTokens: Number.isSafeInteger(total.inputTokens) ? Number(total.inputTokens) : null,
        outputTokens: Number.isSafeInteger(total.outputTokens) ? Number(total.outputTokens) : null,
      } : null,
    };
  }

  async compactThread(binding: RuntimeBinding, baselineTurnId: string,
    beforeSend: (requestId: number) => Promise<void>, afterAccepted?: (connectionId: string) => Promise<void>): Promise<string | null> {
    const profile = binding.resumeProfile;
    let stage: RuntimeCompactionPreflightStage = "request_validation";
    let status: unknown;
    let last: RuntimeTurn | null = null;
    let preparedConnectionId: string | null = null;
    try {
      this.owned(binding);
      if (!this.features.compaction)
        throw new RuntimeProtocolError("owned compaction requires pinned alpha.6");
      if (!profile || !fullProfile(profile) || !nonempty(profile.model) || !nonempty(profile.reasoningEffort))
        throw new RuntimeProtocolError("compaction requires the active full owner profile");
      // A failed native Turn can leave the Thread at systemError; a restarted
      // owner can see notLoaded. Reattach through the same full-profile owner
      // protocol used for ordinary Turns, which rejects a competing writer.
      stage = "owner_resume";
      await this.resumeBinding(binding,{
        actorId:profile.actorId,sessionId:binding.sessionId,roleId:binding.roleId,
        projectId:binding.projectId,cwd:binding.cwd,authorizationScope:binding.authorizationScope,
        model:profile.model,sandbox:FULL_SANDBOX,approvalPolicy:'never',
        reasoningEffort:profile.reasoningEffort,
        ...(profile.executionProfileRevisionId?{executionProfileRevisionId:profile.executionProfileRevisionId}:{}),
      });
      stage = "thread_read";
      const read = object(await this.inspect(binding));
      const thread = object(read?.thread);
      status=object(thread?.status)?.type;
      if (status !== "idle" && status !== "systemError")
        throw new RuntimeProtocolError("owned Thread is not ready after exact owner resume");
      // Compaction uses the Thread default effort; per-Turn profile effort is
      // applied only by turn/start and is intentionally not an equivalence gate here.
      if (thread?.model !== profile.model)
        throw new RuntimeProtocolError("owned Thread has a different active model");
      stage = "history";
      const turns=object(await this.request("thread/turns/list",{
        threadId:binding.nativeThreadId,limit:1,sortDirection:"desc",itemsView:"notLoaded",
      }));
      last=Array.isArray(turns?.data)?runtimeTurn(turns.data[0]):null;
      if(last?.id!==baselineTurnId||!last.completedAtUtc||
        status==="systemError"&&last.status!=="failed")
        throw new RuntimeProtocolError("owned Thread changed after exact owner resume");
      stage = "send_connection";
      preparedConnectionId=this.nativeInputConnectionId();
      if(!preparedConnectionId)
        throw new RuntimeProtocolError("owner connection unavailable before compaction");
    } catch (error) {
      if (error instanceof RuntimeCompactionPreflightError) throw error;
      throw new RuntimeCompactionPreflightError(stage, error);
    }
    const sendConnectionId=preparedConnectionId;
    let resolveStarted:(value:string)=>void=()=>{};
    let startedTurnId:string|null=null;
    let sent=false;
    let startTimer:ReturnType<typeof setTimeout>|null=null;
    const started=new Promise<string>(resolve=>{resolveStarted=resolve});
    const off=this.onEvent(event=>{
      if(sent&&event.method==='turn/started'&&event.threadId===binding.nativeThreadId&&event.turnId&&
        this.nativeInputConnectionId()===sendConnectionId){
        startedTurnId=event.turnId;resolveStarted(event.turnId);
      }
    });
    try{
      const response = object(await this.request("thread/compact/start", {threadId:binding.nativeThreadId},
        this.timeout, beforeSend, ()=>{sent=true}));
      if (!response || Object.keys(response).length !== 0)
        throw new RuntimeUnknownError("thread/compact/start", null, "unexpected acknowledgement; outcome must be reconciled");
      if(this.nativeInputConnectionId()!==sendConnectionId)
        throw new RuntimeUnknownError('thread/compact/start',null,'owner connection changed after acknowledgement');
      await afterAccepted?.(sendConnectionId);
      return await Promise.race([started,new Promise<null>(resolve=>{startTimer=setTimeout(()=>resolve(null),5000)})]);
    }catch(error){
      if(startedTurnId&&error instanceof RuntimeServerError){
        // Notifications carry no request ID. Once the exact Turn has started,
        // a later server error cannot prove that rejecting this request settles it.
        const unknown=new RuntimeUnknownError('thread/compact/start',error.requestId,
          'server error followed a matching turn/started notification');
        unknown.observedTurnId=startedTurnId;
        throw unknown;
      }
      if(error instanceof RuntimeUnknownError&&startedTurnId)error.observedTurnId=startedTurnId;
      throw error;
    }finally{off();if(startTimer)clearTimeout(startTimer)}
  }

  async readThreadName(binding: RuntimeBinding): Promise<string | null> {
    const result = object(await this.inspect(binding));
    const thread = object(result?.thread);
    if (thread?.name !== null && thread?.name !== undefined && typeof thread?.name !== "string")
      throw new RuntimeProtocolError("native Thread name is invalid");
    return typeof thread?.name === "string" ? thread.name : null;
  }

  async setThreadName(binding: RuntimeBinding, name: string): Promise<void> {
    this.owned(binding);
    if (!this.features.modern)
      throw new RuntimeProtocolError("native Thread naming requires a pinned modern protocol");
    if (!name.trim() || name.length > 240) throw new RuntimeProtocolError("invalid native Thread name");
    // The response is empty by protocol. The coordinator verifies with thread/read.
    await this.request("thread/name/set", { threadId: binding.nativeThreadId, name });
  }

  async archiveThread(binding: RuntimeBinding): Promise<void> {
    this.owned(binding);
    // 0.154.0 returns an empty acknowledgement. The coordinator must verify archive separately.
    await this.request("thread/archive", { threadId: binding.nativeThreadId });
  }

  async isThreadArchived(binding: RuntimeBinding): Promise<boolean> {
    this.owned(binding);
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const result = object(await this.request("thread/list", { archived: true, cwd: binding.cwd,
        useStateDbOnly: true, limit: 100, ...(cursor ? { cursor } : {}) }));
      if (!result || !Array.isArray(result.data)) throw new RuntimeProtocolError("invalid archived thread page");
      for (const entry of result.data) {
        const thread = object(entry);
        if (!thread || !nonempty(thread.id)) throw new RuntimeProtocolError("invalid archived thread identity");
        if (thread.id === binding.nativeThreadId) {
          if (thread.sessionId !== binding.nativeSessionId || thread.cwd !== binding.cwd)
            throw new RuntimeProtocolError("archived thread does not match owned binding");
          return true;
        }
      }
      if (result.nextCursor == null) return false;
      if (!nonempty(result.nextCursor) || seen.has(result.nextCursor)) throw new RuntimeProtocolError("invalid archived thread cursor");
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new RuntimeProtocolError("archived thread listing exceeds bounded recovery window");
  }

  async listTurns(binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>> {
    this.owned(binding);
    // Metadata-only listing is supported by the pinned modern protocols; 0.154 has no itemsView.
    const params = { threadId: binding.nativeThreadId, limit: 100,
      sortDirection:'desc', ...(this.features.modern ? { itemsView: "notLoaded" } : {}),
      ...(cursor ? { cursor } : {}) };
    // The pinned schemas declare this method, yet 0.167 answers -32601 for a short window right after
    // turn/start while the Thread's history store attaches (observed about 50 ms on 0.167.0-alpha.3.2).
    // A read has no side effect, so a bounded retry settles that window instead of reporting a fault.
    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; ; attempt++) {
      try { result = object(await this.request("thread/turns/list", params)); break; }
      catch (error) {
        if (!(error instanceof RuntimeServerError && error.code === -32601) || attempt >= TURN_LIST_ATTACH_RETRIES) throw error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, TURN_LIST_ATTACH_DELAY_MS * (attempt + 1)));
      }
    }
    const turns = Array.isArray(result?.data) ? result.data.map(runtimeTurn) : null;
    if (!turns || turns.some(turn => !turn)) throw new RuntimeProtocolError("invalid turns page");
    if (this.features.modern &&
        result?.nextCursor !== null && !nonempty(result?.nextCursor))
      throw new RuntimeProtocolError("invalid turns continuation cursor");
    return { data: turns as RuntimeTurn[], nextCursor: nonempty(result?.nextCursor) ? result.nextCursor : null };
  }

  async listItems(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimePage<unknown>> {
    this.owned(binding);
    if (!nonempty(turnId)) throw new RuntimeProtocolError("turn ID required");
    const result = object(await this.request("thread/items/list", { threadId: binding.nativeThreadId, turnId, limit: 100, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result?.data)) throw new RuntimeProtocolError("invalid items page");
    const items = result.data.map(entry => {
      const wrapper = object(entry), item = object(wrapper?.item);
      if (wrapper?.turnId !== turnId || !item || !nonempty(item.id) || !nonempty(item.type)) throw new RuntimeProtocolError("item page does not match requested owned turn");
      return item;
    });
    return { data: items, nextCursor: nonempty(result.nextCursor) ? result.nextCursor : null };
  }

  async readWorkPage(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimeWorkPage> {
    this.owned(binding);
    if (!nonempty(turnId)) throw new RuntimeProtocolError("turn ID required");
    const result = object(await this.request("thread/items/list", { threadId: binding.nativeThreadId, turnId, limit: 50, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result?.data)) throw new RuntimeProtocolError("invalid work items page");
    const data: RuntimeWorkPage["data"] = [];
    let unsupportedCount = 0, truncated = false;
    for (const entry of result.data) {
      const wrapper = object(entry), item = object(wrapper?.item);
      if (wrapper?.turnId !== turnId || !item || !nonempty(item.id) || !nonempty(item.type)) throw new RuntimeProtocolError("work item page does not match requested owned turn");
      const mapped = mapWorkItem(item);
      if (mapped) { data.push(mapped); truncated ||= mapped.truncated; }
      else unsupportedCount++;
    }
    return { data, unsupportedCount, truncated, nextCursor: nonempty(result.nextCursor) ? result.nextCursor : null };
  }

  async readWorkspaceHistory(binding:RuntimeBinding,options:NativeWorkspaceReadOptions={}):Promise<NativeWorkspacePage>{
    this.owned(binding);
    return this.workspaceReader.read(binding,options);
  }

  onWorkspaceUpdate(listener:(event:WorkspaceRuntimeUpdate)=>void):()=>void{
    this.workspaceUpdates.add(listener);
    return ()=>this.workspaceUpdates.delete(listener);
  }

  async startTurn(binding: RuntimeBinding, input: string, operationId: string,
    executionProfile?: ExecutionProfileSnapshot | null): Promise<RuntimeTurn> {
    this.owned(binding);
    if(this.profileTransitionThreads.has(binding.nativeThreadId))
      throw new RuntimeProtocolError('execution profile activation has not been confirmed');
    if(binding.resumeProfile?.executionProfileRevisionId){
      if(!executionProfile||executionProfile.revisionId!==binding.resumeProfile.executionProfileRevisionId||
        executionProfile.model!==binding.resumeProfile.model||executionProfile.sandbox!==binding.resumeProfile.sandbox||
        (executionProfile.reasoningEffort??null)!==(binding.resumeProfile.reasoningEffort??null)||
        executionProfile.approvalPolicy!==binding.resumeProfile.approvalPolicy||
        executionProfile.cwd!==binding.cwd||executionProfile.authorizationScope!==binding.authorizationScope)
        throw new RuntimeProtocolError('Run does not carry this exact immutable execution profile');
    }
    if(!binding.resumeProfile||!fullProfile(binding.resumeProfile))
      throw new RuntimeProtocolError('business Turn requires an active full execution profile');
    if (!nonempty(input) || !nonempty(operationId)) throw new RuntimeProtocolError("input and durable operation ID required");
    const fullAttempts=this.fullTurnAttempts.get(binding.nativeThreadId)??new Set<string>();
    if(fullAttempts.has(operationId))
      throw new RuntimeProtocolError('this full Turn operation was already attempted; reconcile its original result');
    // The caller persists operationId before this call. The CLI does not promise idempotency for clientUserMessageId.
    fullAttempts.add(operationId);this.fullTurnAttempts.set(binding.nativeThreadId,fullAttempts);
    let result: Record<string, unknown> | null;
    try {
      result = object(await this.request("turn/start", { threadId: binding.nativeThreadId, input: [{ type: "text", text: input }], clientUserMessageId: operationId,
        ...(binding.resumeProfile?.model?{model:binding.resumeProfile.model}:{}),
        ...(executionProfile?.reasoningEffort?{effort:executionProfile.reasoningEffort}:{}),
        cwd:binding.cwd,sandboxPolicy:FULL_POLICY,approvalPolicy:'never' }));
    } catch (error) {
      // Nothing was written, so the caller may withdraw its intent and dispatch this operation again.
      if (error instanceof RuntimeNotSentError) fullAttempts.delete(operationId);
      throw error;
    }
    const turn = runtimeTurn(result?.turn);
    if (!turn) throw new RuntimeUnknownError("turn/start", null, "invalid acknowledgement; turn may have started");
    return executionProfile?.reasoningEffort ? await this.withObservedEffort(binding, turn) : turn;
  }

  /**
   * The effort the Thread reports right after turn/start, counted only when this very Turn is the Thread's latest one, so the value is the
   * one in effect for it and not an older Turn's. Anything else (a failed read, another Turn first) is "unread", never "consistent".
   * Best effort: the Turn has already started.
   */
  private async withObservedEffort(binding: RuntimeBinding, turn: RuntimeTurn): Promise<RuntimeTurn> {
    try {
      const latest = object(await this.request("thread/turns/list", { threadId: binding.nativeThreadId, limit: 1, sortDirection: "desc", ...(this.features.modern ? { itemsView: "notLoaded" } : {}) }));
      const first = Array.isArray(latest?.data) ? object(latest.data[0]) : null;
      if (first?.id !== turn.id) return { ...turn, observedReasoningEffort: null };
      const readback = object(await this.request("thread/read", { threadId: binding.nativeThreadId, includeTurns: false }));
      const observed = object(readback?.thread)?.reasoningEffort;
      return { ...turn, observedReasoningEffort: typeof observed === "string" ? observed : null };
    } catch { return { ...turn, observedReasoningEffort: null }; }
  }

  async interruptTurn(binding: RuntimeBinding, turnId: string): Promise<void> {
    this.owned(binding);
    if (!nonempty(turnId)) throw new RuntimeProtocolError("turn ID required");
    await this.request("turn/interrupt", { threadId: binding.nativeThreadId, turnId });
    // Acknowledgement is only a stop request; the caller must inspect final turn status.
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  onApprovalRequest(listener: (request: RuntimeApprovalRequest) => void | Promise<void>): () => void { this.approvals.add(listener); return () => this.approvals.delete(listener); }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.ownedProcess ?? this.child;
    if (!child){await this.flushChildDiagnostics();return;}
    const exited = this.processExit ?? Promise.resolve();
    const waitExit = (): Promise<boolean> => new Promise(resolveWait => {
      const timer = setTimeout(() => resolveWait(false), 2_000);
      void exited.then(() => { clearTimeout(timer); resolveWait(true); });
    });
    this.disconnect("adapter closed",'adapter_closed');
    if(!await waitExit()){
      signalProcessGroup(child,'SIGKILL');
      if(!await waitExit())throw new RuntimeUnknownError('close',null,'child process did not exit');
    }
    await this.flushChildDiagnostics();
    if(this.exitDelivery){
      try{await this.exitDelivery;}
      catch{throw new RuntimeUnknownError('close',null,'child exit receipt unavailable');}
    }
  }
}
