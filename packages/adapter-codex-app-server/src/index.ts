import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimeEvent, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn, RuntimeTurnFailure, RuntimeWorkPage } from "@evoloop/contracts/runtime";
import type { ExecutionProfileSnapshot } from "@evoloop/contracts/session-recovery";
import { mapWorkItem } from "./work-trace.js";

const OWNER = "evoloop-codex-app-server" as const;
const PINNED_PROTOCOLS = {
  "codex-cli 0.154.0": {
    standard: "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9",
    experimental: "7b9e7d385fffef8d428cc5490b56ce9c393bd3ed7bc7ccd730956387e723ec05",
  },
  "codex-cli 0.164.0-alpha.11.1": {
    standard: "8fe0d6335768743b8388dfdbe95fef85303524093e2dffc301704555e73e718f",
    experimental: "3b9df7cbe5659538e7162e1f8fdadcad42badc08bfeac2fe617ede44ca057b12",
  },
} as const;
type PinnedProtocolVersion = keyof typeof PINNED_PROTOCOLS;
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
const fullProfile = (value:{sandbox:string;approvalPolicy:string}):boolean =>
  value.sandbox===FULL_SANDBOX&&value.approvalPolicy==='never';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const policyJson=(value:unknown):string=>JSON.stringify(value,(_key,current)=>object(current)?
  Object.fromEntries(Object.entries(current).sort(([a],[b])=>a.localeCompare(b))):current);
const sameBinding = (a: RuntimeBinding, b: RuntimeBinding): boolean =>
  (["sessionId", "roleId", "projectId", "nativeThreadId", "nativeSessionId", "cwd", "authorizationScope", "owner"] as const).every(key => a[key] === b[key]) &&
  (["actorId","model","sandbox","approvalPolicy","executionProfileRevisionId"] as const).every(key =>
    (a.resumeProfile?.[key] ?? null) === (b.resumeProfile?.[key] ?? null));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const safeProviderCode = (value: unknown): string | null => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
function turnFailure(value: unknown): RuntimeTurnFailure | undefined {
  const native = object(value);
  if (!native) return undefined;
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

/** Unknown means the process may have accepted an operation whose reply was lost. Never retry it automatically. */
export class RuntimeUnknownError extends Error {
  constructor(public readonly method: string, public readonly requestId: number | null, reason: string) {
    super(`${method}: outcome unknown (${reason})`); this.name = "RuntimeUnknownError";
  }
}
export class RuntimeProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeProtocolError"; }
}
export type RuntimeServerErrorCategory = "rollout_not_found" | "thread_unavailable" | "invalid_params" | "method_not_found" | "permission_denied" | "server_rejected";
const serverErrorCategory = (code: number, message: string): RuntimeServerErrorCategory => {
  if (/rollout.{0,60}not found|not found.{0,60}rollout/i.test(message)) return "rollout_not_found";
  if (/thread.{0,60}(read|load)|(read|load).{0,60}thread/i.test(message)) return "thread_unavailable";
  if (code === -32602 || /invalid params/i.test(message)) return "invalid_params";
  if (code === -32601) return "method_not_found";
  if (/permission|unauthorized|forbidden/i.test(message)) return "permission_denied";
  return "server_rejected";
};
/** Stable protocol evidence only. The native error message can contain private paths or session material. */
export class RuntimeServerError extends RuntimeProtocolError {
  readonly category: RuntimeServerErrorCategory;
  constructor(public readonly method: string, public readonly requestId: number, public readonly code: number, nativeMessage: string) {
    const category = serverErrorCategory(code, nativeMessage);
    super(`${method}: App Server rejected request (${category}, code ${code})`);
    this.name = "RuntimeServerError";
    this.category = category;
  }
}

export interface CodexAppServerOptions {
  executable?: string;
  expectedVersion?: string;
  requestTimeoutMs?: number;
  /** Optional startup handshake deadline; other RPCs retain requestTimeoutMs. */
  initializationTimeoutMs?: number;
  dynamicToolTimeoutMs?: number;
  clientVersion?: string;
  /** For fixtures only; production uses `app-server --stdio`. */
  spawnArgs?: string[];
  /** Actual child exit evidence, independent of a transport EOF. */
  onExited?: (receipt:{pid:number;code:number|null;signal:NodeJS.Signals|null})=>void|Promise<void>;
  /** Explicit per-request approval, never a session-wide grant. Default is deny. */
  decideApproval?: (request: RuntimeApprovalRequest, binding: RuntimeBinding) => Promise<"accept" | "decline">;
  /** Required to restore a persisted binding after restart. Must consult the trusted project store. */
  verifyBinding?: (binding: RuntimeBinding) => Promise<boolean>;
  /** Trusted, persisted activation permit for exactly one adopted Session execution profile revision. */
  authorizeExecutionProfileActivation?: (current: RuntimeBinding, target: RuntimeSessionSpec,
    revisionId: string, operationId: string) => Promise<boolean>;
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

interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

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
  private approvals = new Set<(request: RuntimeApprovalRequest) => void | Promise<void>>();
  private declaredTools = new Map<string, Set<string>>();
  private profileTransitionThreads = new Set<string>();
  private conversationQualifications = new Map<string,{fingerprint:string;observedAt:number;model:string|null}>();
  private fullTurnAttempts = new Map<string,Set<string>>();
  private seenToolCalls = new Set<string>();
  private disconnects = new Set<(reason: string) => void>();
  private closed = false;
  private ready = false;
  private readonly executable: string;
  private readonly timeout: number;
  private readonly initializationTimeout: number;
  private readonly dynamicToolTimeout: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly expectedVersion: PinnedProtocolVersion;

  constructor(private readonly options: CodexAppServerOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.timeout = options.requestTimeoutMs ?? 15_000;
    this.initializationTimeout = options.initializationTimeoutMs ?? this.timeout;
    this.dynamicToolTimeout = options.dynamicToolTimeoutMs ?? 30_000;
    this.environment = childEnvironment(options.environment ?? process.env);
    const expectedVersion = options.expectedVersion ?? "codex-cli 0.154.0";
    if (!(expectedVersion in PINNED_PROTOCOLS)) throw new RuntimeProtocolError("unsupported Codex CLI protocol version");
    this.expectedVersion = expectedVersion as PinnedProtocolVersion;
    if (!finite(this.timeout)) throw new Error("requestTimeoutMs must be positive");
    if (!finite(this.initializationTimeout)) throw new Error("initializationTimeoutMs must be positive");
    if (!finite(this.dynamicToolTimeout)) throw new Error("dynamicToolTimeoutMs must be positive");
  }
  isReady(): boolean { return this.ready && !!this.child; }
  hasProcessHandle():boolean{return this.ownedProcess!==null;}
  onDisconnect(listener: (reason: string) => void): () => void { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }

  /** Probe the installed CLI before it can receive any project request. */
  async open(): Promise<void> {
    if (this.closed) throw new RuntimeProtocolError("adapter closed");
    if (this.ready) return;
    if (this.child) throw new RuntimeProtocolError("adapter opening");
    if (!this.options.spawnArgs) {
      const version = await this.probeVersion();
      if (version !== this.expectedVersion) throw new RuntimeProtocolError(`Codex CLI version mismatch: expected ${this.expectedVersion}, got ${version}`);
      await this.probeSchema();
    }
    const child = spawn(this.executable, this.options.spawnArgs ?? ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"], env: this.environment,
    });
    this.child = child;
    this.ownedProcess=child;
    this.processExit=new Promise<void>(resolveExit=>{
      child.once('exit',()=>resolveExit());
      child.once('error',()=>{if(!child.pid)resolveExit();});
    });
    child.stderr.resume(); // Do not persist stderr: it may contain private paths or content.
    child.on("error", error => this.disconnect(error.message));
    child.on("exit", (code, signal) => {
      if(Number.isSafeInteger(child.pid)&&this.options.onExited){
        this.exitDelivery=Promise.resolve().then(()=>this.options.onExited!({pid:child.pid!,code,signal}));
        void this.exitDelivery.catch(()=>undefined);
      }
      this.disconnect(`process exited (${code ?? signal ?? "unknown"})`);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => this.receive(line));
    lines.on("close", () => this.disconnect("stdout closed"));
    try {
      const result = object(await this.request("initialize", { clientInfo: { name: "evoloop", title: "evoLoop", version: this.options.clientVersion ?? "0.1.0" },
        ...((this.options.dynamicTools && this.options.callDynamicTool) ?
          {capabilities:{experimentalApi:true}} : {}) }, this.initializationTimeout));
      if (!result || !nonempty(result.userAgent) || !nonempty(result.platformFamily)) throw new RuntimeProtocolError("invalid initialize response");
      this.send({ method: "initialized" });
      this.ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
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

  private async probeSchema(): Promise<void> {
    const directory = await mkdtemp(resolve(tmpdir(), "evoloop-codex-schema-"));
    try {
      const experimental=!!(this.options.dynamicTools && this.options.callDynamicTool);
      await execFileAsync(this.executable, ["app-server", "generate-json-schema", ...(experimental ? ["--experimental"] : []), "--out", directory], {
        timeout: this.timeout, maxBuffer: 64 * 1024, env: this.environment,
      });
      const schema = await readFile(resolve(directory, "codex_app_server_protocol.v2.schemas.json"));
      const expected = PINNED_PROTOCOLS[this.expectedVersion][experimental ? "experimental" : "standard"];
      if (createHash("sha256").update(schema).digest("hex") !== expected) throw new RuntimeProtocolError("Codex App Server schema changed; review capabilities before use");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private send(message: unknown): void {
    if (!this.child || !this.child.stdin.writable) throw new RuntimeProtocolError("App Server disconnected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown, timeoutMs = this.timeout): Promise<unknown> {
    if (!this.child) return Promise.reject(new RuntimeProtocolError("App Server not open"));
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeUnknownError(method, id, "response timeout"));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new RuntimeUnknownError(method, id, error instanceof Error ? error.message : "send failed"));
      }
    });
  }

  private receive(line: string): void {
    let message: Record<string, unknown> | null;
    try { message = object(JSON.parse(line)); } catch { this.disconnect("malformed JSON"); return; }
    if (!message) { this.disconnect("non-object message"); return; }
    if ("method" in message) {
      if (!nonempty(message.method)) { this.disconnect("invalid method"); return; }
      if ("id" in message) { void this.serverRequest(message).catch(() => this.disconnect("server request response failed")); return; }
      const params = object(message.params);
      const threadId = params?.threadId;
      if (!nonempty(threadId) || !this.bindings.has(threadId)) return;
      const turn = object(params?.turn);
      const event: RuntimeEvent = { method: message.method, threadId, params: message.params, ...(nonempty(params?.turnId) ? { turnId: params.turnId } : nonempty(turn?.id) ? { turnId: turn.id } : {}) };
      for (const listener of this.events) { try { listener(event); } catch { /* observers cannot break transport */ } }
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
      pending.reject(new RuntimeServerError(pending.method, message.id, code, nativeMessage));
    }
    else if ("result" in message) pending.resolve(message.result);
    else { pending.reject(new RuntimeProtocolError(`${pending.method}: response lacks result`)); this.disconnect("malformed response"); }
  }

  private async serverRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if ((typeof id !== "number" && typeof id !== "string") || !nonempty(message.method)) { this.disconnect("invalid server request"); return; }
    const params = object(message.params);
    const threadId = params?.threadId ?? params?.conversationId;
    const binding = nonempty(threadId) ? this.bindings.get(threadId) : undefined;
    const creating = !binding && nonempty(threadId) && APPROVAL_METHODS.has(message.method) ? this.pendingCreate : null;
    const request: RuntimeApprovalRequest = { id, method: message.method, params: message.params,
      ...(binding ? { projectId: binding.projectId, sessionId: binding.sessionId } :
        creating ? { projectId: creating.projectId, sessionId: creating.sessionId } : {}),
      ...(nonempty(threadId) ? { threadId } : {}), ...(nonempty(params?.turnId) ? { turnId: params.turnId } : {}) };
    if (message.method === "currentTime/read") {
      if (this.expectedVersion !== "codex-cli 0.164.0-alpha.11.1") {
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
      const valid = !!binding && !!key && !this.seenToolCalls.has(key) && call?.namespace == null &&
        nonempty(call?.turnId) && nonempty(call?.tool) && !!object(call?.arguments) &&
        this.declaredTools.get(binding.nativeThreadId)?.has(call.tool) && !!this.options.callDynamicTool;
      if (!valid) { this.send({id,result:{contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false}}); return; }
      this.seenToolCalls.add(key!);
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
      // Unknown requests and user input cannot be silently answered as consent.
      const result = message.method === "mcpServer/elicitation/request" ? { action: "decline" } : null;
      this.send(result ? { id, result } : { id, error: { code: -32601, message: "Unsupported server request" } });
      return;
    }
    let decision: "accept" | "decline" = "decline";
    if (this.options.decideApproval) {
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

  private disconnect(reason: string): void {
    const wasConnected = this.ready || !!this.child;
    this.ready = false;
    this.conversationQualifications.clear();
    const child = this.child; this.child = null;
    if (child && !child.killed) child.kill();
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
    this.rememberBinding(binding);
  }

  private validateBinding(binding: RuntimeBinding): void {
    if (binding.owner !== OWNER || !nonempty(binding.authorizationScope) || !nonempty(binding.projectId) || !nonempty(binding.roleId) || !nonempty(binding.sessionId) || !nonempty(binding.nativeThreadId) || !binding.cwd.startsWith("/") || resolve(binding.cwd) !== binding.cwd) throw new RuntimeProtocolError("invalid runtime binding");
  }

  private rememberBinding(binding: RuntimeBinding): void {
    this.validateBinding(binding);
    const existing = this.bindings.get(binding.nativeThreadId);
    if (existing && !sameBinding(existing, binding)) throw new RuntimeProtocolError("conflicting runtime binding");
    this.bindings.set(binding.nativeThreadId, binding);
  }

  private owned(binding: RuntimeBinding): void {
    const saved = this.bindings.get(binding.nativeThreadId);
    if (!saved || !sameBinding(saved, binding)) throw new RuntimeProtocolError("thread is not registered to this adapter and scope");
    if (!this.ready) throw new RuntimeProtocolError("App Server not ready");
  }

  async create(spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    if (!this.ready) throw new RuntimeProtocolError("App Server not ready");
    if (!nonempty(spec.sessionId) || !nonempty(spec.roleId) || !nonempty(spec.projectId) || !nonempty(spec.authorizationScope) || !spec.cwd.startsWith("/") || resolve(spec.cwd) !== spec.cwd) throw new RuntimeProtocolError("invalid session scope or cwd");
    if(!fullProfile(spec))throw new RuntimeProtocolError('new Session requires danger-full-access and approval never');
    if (this.pendingCreate) throw new RuntimeProtocolError("another thread creation is pending");
    this.pendingCreate = { ...spec };
    try {
      const config = await this.options.threadConfig?.(spec);
      const dynamicTools = this.options.dynamicTools && this.options.callDynamicTool ? await this.options.dynamicTools(spec) : undefined;
      const result = object(await this.request("thread/start", { cwd: spec.cwd, ...(spec.model ? { model: spec.model } : {}), sandbox: spec.sandbox, approvalPolicy: spec.approvalPolicy, serviceName: "evoloop", ...(config ? {config} : {}), ...(dynamicTools?.length ? {dynamicTools} : {}) }));
      const thread = object(result?.thread);
      if (!nonempty(thread?.id) || !nonempty(thread?.sessionId) || thread?.cwd !== spec.cwd) throw new RuntimeUnknownError("thread/start", null, "invalid acknowledgement; native thread may exist");
      const sandbox=object(result?.sandbox);
      if(result?.cwd!==spec.cwd||result?.approvalPolicy!=='never'||sandbox?.type!=='dangerFullAccess'||
        !nonempty(result?.model)||!nonempty(result?.modelProvider)||
        (spec.model!=null&&result.model!==spec.model)||
        (thread.model!=null&&thread.model!==result.model))
        throw new RuntimeUnknownError('thread/start',null,'full Session creation acknowledgement did not confirm native policy');
      const binding: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId, authorizationScope: spec.authorizationScope, cwd: spec.cwd, nativeThreadId: thread.id, nativeSessionId: thread.sessionId, owner: OWNER,
        ...(spec.actorId ? {resumeProfile:{actorId:spec.actorId,model:spec.model??null,sandbox:spec.sandbox,
          approvalPolicy:spec.approvalPolicy,...(spec.executionProfileRevisionId?
            {executionProfileRevisionId:spec.executionProfileRevisionId}:{})}} : {}) };
      this.rememberBinding(binding);
      if (dynamicTools?.length) this.declaredTools.set(binding.nativeThreadId,new Set(dynamicTools.map(tool=>tool.name)));
      return binding;
    } finally { this.pendingCreate = null; }
  }

  async resume(binding: RuntimeBinding, spec: RuntimeSessionSpec): Promise<RuntimeBinding> {
    this.owned(binding);
    this.conversationQualifications.delete(binding.nativeThreadId);
    if (!spec || !nonempty(spec.actorId) || spec.sessionId !== binding.sessionId || spec.roleId !== binding.roleId ||
      spec.projectId !== binding.projectId || spec.authorizationScope !== binding.authorizationScope ||
      spec.cwd !== binding.cwd || resolve(spec.cwd) !== spec.cwd ||
      !fullProfile(spec) ||
      !binding.resumeProfile || binding.resumeProfile.actorId !== spec.actorId ||
      binding.resumeProfile.model !== (spec.model??null) || binding.resumeProfile.sandbox !== spec.sandbox ||
      binding.resumeProfile.approvalPolicy !== spec.approvalPolicy ||
      (binding.resumeProfile.executionProfileRevisionId??null)!==(spec.executionProfileRevisionId??null))
      throw new RuntimeProtocolError("resume profile does not match registered binding");
    // The native rollout may retain an old declaration. Rebuild the host allowlist
    // only from the current trusted business scope, and keep it empty until the
    // exact owned resume is acknowledged. A failed provider or native RPC cannot
    // leave an earlier allowlist open.
    this.declaredTools.delete(binding.nativeThreadId);
    const config = await this.options.threadConfig?.(spec);
    let currentTools:DynamicToolSpec[]|undefined;
    if (this.options.dynamicTools && this.options.callDynamicTool) {
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
    const result = object(await this.request("thread/resume", { threadId: binding.nativeThreadId,
      excludeTurns: true, cwd: spec.cwd, ...(spec.model ? { model: spec.model } : {}),
      sandbox: spec.sandbox, approvalPolicy: spec.approvalPolicy, ...(config ? { config } : {}) }));
    const thread = object(result?.thread);
    if (thread?.id !== binding.nativeThreadId || thread?.sessionId !== binding.nativeSessionId || thread?.cwd !== binding.cwd) throw new RuntimeProtocolError("resumed thread does not match registered binding");
    this.assertRevisedProfileReply(result,binding,spec);
    if (currentNames.size) this.declaredTools.set(binding.nativeThreadId,currentNames);
    return binding;
  }

  private revisedBinding(current: RuntimeBinding, target: RuntimeSessionSpec,
    revisionId: string, operationId: string): RuntimeBinding {
    this.validateBinding(current);
    const old=current.resumeProfile;
    if(!old||!nonempty(old.executionProfileRevisionId)||!nonempty(revisionId)||!nonempty(operationId)||
      old.executionProfileRevisionId===revisionId||target.executionProfileRevisionId!==revisionId||
      !nonempty(target.actorId)||!nonempty(target.model)||
      (target.model===old.model&&target.sandbox===old.sandbox&&target.approvalPolicy===old.approvalPolicy)||
      target.actorId!==old.actorId||target.sessionId!==current.sessionId||target.roleId!==current.roleId||
      target.projectId!==current.projectId||target.cwd!==current.cwd||
      target.authorizationScope!==current.authorizationScope||
      !fullProfile(target))
      throw new RuntimeProtocolError('execution profile revision changed owned identity or lacks a durable target');
    return {...current,resumeProfile:{...old,model:target.model,sandbox:target.sandbox,
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
      reply?.approvalPolicy!=='never'||sandbox?.type!=='dangerFullAccess')
      throw new RuntimeUnknownError('thread/resume',null,'execution profile reply did not confirm the exact owned Thread and model');
  }

  /** Called only after the coordinator has durably claimed this one revision's activation. */
  async activateExecutionProfile(current:RuntimeBinding,target:RuntimeSessionSpec,
    revisionId:string,operationId:string):Promise<RuntimeBinding>{
    const revised=await this.authorizeRevision(current,target,revisionId,operationId);
    if(!sameBinding(this.bindings.get(current.nativeThreadId)!,current))
      throw new RuntimeProtocolError('execution profile activation was already attempted in this adapter');
    if(!await this.nativeThreadIdle(current,true))
      throw new RuntimeProtocolError('owned Thread is active; execution profile cannot be applied');
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
    if(thread.model!==target.model||object(thread.status)?.type!=='idle')return null;
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
      (expectedModel===undefined||thread.model===expectedModel);
  }

  /** Admission evidence for an owned full-profile Thread, not proof of per-Turn native policy. */
  async qualifyConversationThread(binding:RuntimeBinding):Promise<{available:boolean;reason:string;fingerprint:string|null}>{
    this.owned(binding);
    const unavailable=(reason:string)=>{this.conversationQualifications.delete(binding.nativeThreadId);
      return {available:false,reason,fingerprint:null};};
    if(this.expectedVersion!=='codex-cli 0.164.0-alpha.11.1')return unavailable('Full conversation readback requires pinned 0.164 protocol');
    if(!binding.resumeProfile||!fullProfile(binding.resumeProfile)||
      this.profileTransitionThreads.has(binding.nativeThreadId))
      return unavailable('Owned Session has no active full execution profile');
    try{
      const result=object(await this.request('thread/read',{threadId:binding.nativeThreadId,includeTurns:false}));
      const thread=object(result?.thread);
      if(thread?.id!==binding.nativeThreadId||thread?.sessionId!==binding.nativeSessionId||thread?.cwd!==binding.cwd)
        return unavailable('Native Thread identity does not match the owned Session');
      const status=object(thread.status)?.type;
      if((status!=='idle'&&status!=='notLoaded')||
        (thread.model!=null&&(!nonempty(thread.model)||binding.resumeProfile.model!=null&&thread.model!==binding.resumeProfile.model)))
        return unavailable('Owned native Thread is active or its model differs from the fixed profile');
      const model=nonempty(thread.model)?thread.model:binding.resumeProfile.model;
      const fingerprint=createHash('sha256').update(policyJson({
        admission:'evoloop-full-conversation-v1',protocol:this.expectedVersion,
        projectId:binding.projectId,sessionId:binding.sessionId,roleId:binding.roleId,
        threadId:binding.nativeThreadId,nativeSessionId:binding.nativeSessionId,
        cwd:binding.cwd,scope:binding.authorizationScope,profile:binding.resumeProfile,model,status,
      })).digest('hex');
      const prior=this.conversationQualifications.get(binding.nativeThreadId);
      if(prior&&prior.fingerprint!==fingerprint)return unavailable('Owned Thread model or profile changed during admission');
      this.conversationQualifications.set(binding.nativeThreadId,{fingerprint,observedAt:Date.now(),model});
      return {available:true,reason:'Owned full-profile Thread has no active Turn; exact full policy is confirmed on resume and sent on the Turn',fingerprint};
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
    const attempts=this.fullTurnAttempts.get(binding.nativeThreadId)??new Set<string>();
    if(attempts.has(operationId))throw new RuntimeProtocolError('original ordinary Turn operation cannot be replayed');
    const rechecked=await this.qualifyConversationThread(binding);
    if(!rechecked.available||rechecked.fingerprint!==prior.fingerprint)
      throw new RuntimeProtocolError('owned full-profile Thread changed before ordinary Turn');
    this.conversationQualifications.delete(binding.nativeThreadId);
    attempts.add(operationId);this.fullTurnAttempts.set(binding.nativeThreadId,attempts);
    const profile=binding.resumeProfile;
    await this.resume(binding,{
      actorId:profile.actorId,sessionId:binding.sessionId,roleId:binding.roleId,
      projectId:binding.projectId,cwd:binding.cwd,authorizationScope:binding.authorizationScope,
      ...(profile.model?{model:profile.model}:{}),sandbox:FULL_SANDBOX,approvalPolicy:'never',
      ...(profile.executionProfileRevisionId?{executionProfileRevisionId:profile.executionProfileRevisionId}:{}),
    });
    if(!await this.nativeThreadIdle(binding,false,prior.model??undefined))
      throw new RuntimeUnknownError('thread/resume',null,'owned Thread did not become idle after exact full resume');
    const started=object(await this.request('turn/start',{
      threadId:binding.nativeThreadId,input:[{type:'text',text:input}],clientUserMessageId:operationId,
      cwd:binding.cwd,...(prior.model!=null?{model:prior.model}:{}),sandboxPolicy:FULL_POLICY,approvalPolicy:'never',
    }));
    const turn=runtimeTurn(started?.turn);
    if(!turn)throw new RuntimeUnknownError('turn/start',null,'invalid full conversation acknowledgement; Turn may have started');
    return turn;
  }

  async inspect(binding: RuntimeBinding): Promise<unknown> {
    this.owned(binding);
    const result = object(await this.request("thread/read", { threadId: binding.nativeThreadId, includeTurns: false }));
    const thread = object(result?.thread);
    if (thread?.id !== binding.nativeThreadId || thread?.sessionId !== binding.nativeSessionId || thread?.cwd !== binding.cwd) throw new RuntimeProtocolError("read thread does not match binding");
    return result;
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
    // Metadata-only listing is supported by pinned 0.164; 0.154 has no itemsView.
    const result = object(await this.request("thread/turns/list", { threadId: binding.nativeThreadId, limit: 100,
      sortDirection:'desc', ...(this.expectedVersion === "codex-cli 0.164.0-alpha.11.1" ? { itemsView: "notLoaded" } : {}),
      ...(cursor ? { cursor } : {}) }));
    const turns = Array.isArray(result?.data) ? result.data.map(runtimeTurn) : null;
    if (!turns || turns.some(turn => !turn)) throw new RuntimeProtocolError("invalid turns page");
    if (this.expectedVersion === "codex-cli 0.164.0-alpha.11.1" &&
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

  async startTurn(binding: RuntimeBinding, input: string, operationId: string,
    executionProfile?: ExecutionProfileSnapshot | null): Promise<RuntimeTurn> {
    this.owned(binding);
    if(this.profileTransitionThreads.has(binding.nativeThreadId))
      throw new RuntimeProtocolError('execution profile activation has not been confirmed');
    if(binding.resumeProfile?.executionProfileRevisionId){
      if(!executionProfile||executionProfile.revisionId!==binding.resumeProfile.executionProfileRevisionId||
        executionProfile.model!==binding.resumeProfile.model||executionProfile.sandbox!==binding.resumeProfile.sandbox||
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
    const result = object(await this.request("turn/start", { threadId: binding.nativeThreadId, input: [{ type: "text", text: input }], clientUserMessageId: operationId,
      ...(binding.resumeProfile?.model?{model:binding.resumeProfile.model}:{}),
      cwd:binding.cwd,sandboxPolicy:FULL_POLICY,approvalPolicy:'never' }));
    const turn = runtimeTurn(result?.turn);
    if (!turn) throw new RuntimeUnknownError("turn/start", null, "invalid acknowledgement; turn may have started");
    return turn;
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
    if (!child) return;
    const exited = this.processExit ?? Promise.resolve();
    const waitExit = (): Promise<boolean> => new Promise(resolveWait => {
      const timer = setTimeout(() => resolveWait(false), 2_000);
      void exited.then(() => { clearTimeout(timer); resolveWait(true); });
    });
    this.disconnect("adapter closed");
    if(!await waitExit()){
      child.kill('SIGKILL');
      if(!await waitExit())throw new RuntimeUnknownError('close',null,'child process did not exit');
    }
    if(this.exitDelivery){
      try{await this.exitDelivery;}
      catch{throw new RuntimeUnknownError('close',null,'child exit receipt unavailable');}
    }
  }
}
