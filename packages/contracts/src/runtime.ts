import { z } from "zod";
export * from "./runtime-errors.js";
import type { EvaluationFixedRef } from "./evaluation.js";
import type { ExecutionProfileSnapshot, SessionExecutionProfile } from "./session-recovery.js";
import type { NativeInputEvent } from "./native-input.js";
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, WorkspaceRuntimeUpdate } from "./session-timeline.js";

export const runtimeReconcileSchema = z.strictObject({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(4000), turnCursor: z.string().min(1).max(2048).optional() });
export const runtimeCompactionIntentSchema = z.strictObject({
  operationId:z.uuid(), threadId:z.uuid(), expectedSessionVersion:z.number().int().positive(),
  expectedGateVersion:z.number().int().positive(), evidenceRef:z.string().trim().min(1).max(4000),
  reason:z.string().trim().min(1).max(4000),
});
export const preTurnContinueSchema = z.strictObject({
  operationId: z.uuid(), sessionId: z.uuid(), originalOperationId: z.uuid(),
  expectedVersion: z.number().int().positive(), expectedGateVersion: z.number().int().positive(),
  evidenceRef: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(4000),
});
export const messagePreTurnContinueSchema = preTurnContinueSchema.extend({
  expectedMessageVersion: z.number().int().positive(),
});
export const preTurnProofSchema = z.strictObject({
  threadId: z.uuid(), operationId: z.uuid(), requestId: z.number().int().positive(),
  code: z.literal(-32600), inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  observedAtUtc: z.string().datetime({ offset: true }),
  status: z.enum(["observed", "approved", "attempting", "consumed"]),
  decisionOperationId: z.uuid().nullable(), reviewerActorId: z.string().min(1).max(240).nullable(),
  evidenceRef: z.string().min(1).max(4000).nullable(),
  decisionReason: z.string().min(1).max(4000).nullable().optional(),
  gateVersionAtApproval: z.number().int().positive().optional(),
});
export type PreTurnProof = z.infer<typeof preTurnProofSchema>;

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const common = { projectId: id, operationId: id };
export const runtimeCommands = [
  z.strictObject({ ...common, type:z.literal("runtime.handoff.record"),runId:id,stage:z.enum(["received","read","adopted","effect"]),evidence:text }),
  z.strictObject({ ...common, type: z.literal("runtime.session.reserve"), sessionId: id, roleId: text, cwd: z.string().min(1).max(1024).regex(/^\//), authorizationScope: text, model: text.optional(), sandbox: z.literal("danger-full-access").default("danger-full-access"), approvalPolicy: z.literal("never").default("never") }),
  z.strictObject({ ...common, type: z.literal("runtime.session.close"), sessionId: id, expectedVersion: z.number().int().positive(), reason: text }),
  z.strictObject({ ...common, type: z.literal("runtime.run.reserve"), runId: id, taskId: id, sessionId: id, expectedVersion: z.number().int().positive(), input: text,
    evaluation: z.strictObject({ evaluationId: id, revisionId: id, caseId: id, conditionId: id }).optional() }),
  z.strictObject({ ...common, type: z.literal("runtime.run.abandonReadOnly"), runId: id, expectedVersion: z.number().int().positive(), reason: text, evidence: text }),
  z.strictObject({ ...common, type: z.literal("runtime.run.interrupt"), runId: id, reason: text }),
];

export type RuntimeSessionState = "reserved" | "creating" | "ready" | "closing" | "unknown" | "closed";
export type RuntimeRunState = "requested" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "unknown";
export interface RuntimeSessionRecord {
  projectId: string; id: string; roleId: string; cwd: string; authorizationScope: string;
  model: string | null; sandbox: "read-only" | "workspace-write" | "danger-full-access"; approvalPolicy: "on-request" | "untrusted" | "never";
  /** Native thread/start acknowledgement. Null for historical Sessions without this observation. */
  observedModel?: string | null; observedProvider?: string | null;
  state: RuntimeSessionState; version: number; nativeThreadId: string | null; nativeSessionId: string | null;
  operationId: string; actorId: string; createdAt: string; updatedAt: string;
  /** Persisted native-start permit; null/absent for historical unmanaged Sessions. */
  nativeEnvironmentEpoch?: number | null;
  closeOperationId?: string | null; closeAttemptedAt?: string | null; closeVerifiedAt?: string | null;
  /** Adopted configured profile and its native activation status. */
  executionProfile?: SessionExecutionProfile | null;
  /** Immutable native runtime chosen at reservation; absent rows predate providers and are Codex. */
  runtimeProvider?: RuntimeProvider;
}
export interface RuntimeRunRecord {
  projectId: string; id: string; taskId: string; taskRevisionId: string; basisSetId: string;
  sessionId: string; operationId: string; input: string; inputHash: string;
  state: RuntimeRunState; version: number; nativeTurnId: string | null;
  interruptRequested: boolean; resultSummary: string | null; actorId: string; createdAt: string; updatedAt: string;
  /** Immutable native environment used for this original dispatch, never inferred from the current child. */
  nativeEnvironmentEpoch?: number | null;
  evaluationBinding?: { evaluationId: string; revisionId: string; caseId: string; conditionId: string;
    sourceTaskRevisionId: string; actualTaskRevisionId: string; attemptId: string } | null;
  evaluationPacket?: EvaluationPacketBinding | null;
  /** Immutable configured launch profile; this is not provider-reported actual model telemetry. */
  executionProfile?: ExecutionProfileSnapshot | null;
  /** Exact native pre-turn refusal and one-shot reviewed continuation for this original operation. */
  preTurnProof?: PreTurnProof | null;
  /** Provider-reported usage of the bound terminal Turn; null when the provider did not report it. */
  usage?: RuntimeUsage | null;
  /** Provider-reported cost in USD of the bound terminal Turn; never estimated. */
  costUsd?: number | null;
}
/** Trusted caller proof that thread/resume explicitly failed before any turn/start call. */
export interface NativeResumeRejection {
  kind: "native_resume_rejected";
  operationId: string;
  code: number;
  category: "rollout_not_found" | "thread_unavailable" | "invalid_params" |
    "method_not_found" | "permission_denied" | "server_rejected";
}
/** Packet bytes live in a controlled Blob; this immutable binding describes the exact native input. */
export interface EvaluationPacketBinding {
  payloadRef: string; contentHash: string; manifestHash: string; builderVersion: string;
  sources: EvaluationFixedRef[];
}
export interface RuntimeRecordEvent {
  projectId: string; id: string; runId: string | null; sessionId: string | null;
  kind: "session.reserved" | "session.creating" | "session.bound" | "session.unknown" | "session.closeRequested" | "session.archiveAttempted" | "session.closed" |
    "run.requested" | "run.dispatching" | "run.dispatchWithdrawn" | "run.preflightRejected" | "run.dispatchRejected" | "run.bound" | "run.status" | "run.unknown" |
    "run.reviewed" | "message.preTurnReviewed" | "run.reconciled" | "run.interruptRequested" | "run.interruptResult" |
    "session.executionProfile.activationStarted" | "session.executionProfile.active" |
    "session.executionProfile.unknown" | "session.executionProfile.rejected" |
    "runtime.approvalDeclined" | "native.childDiagnostic" | "handoff.received" | "handoff.read" | "handoff.adopted" | "handoff.effect";
  detail: string; nativeTurnId: string | null; cursor: string | null; itemsDigest: string | null;
  actorId: string; createdAt: string;
}

/** Only bounded transport facts may cross the native child diagnostic boundary. */
const nativeDiagnosticUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const nativeStopReason = z.enum(["adapter_closed", "stdout_closed", "stdin_error", "process_exited", "spawn_error", "protocol_error"]);
export const nativeChildDiagnosticSchema = z.strictObject({
  startId: z.uuid(), pid: z.number().int().positive().refine(Number.isSafeInteger).nullable(),
  startedAtUtc: nativeDiagnosticUtc, observedAtUtc: nativeDiagnosticUtc,
  firstLossAtUtc: nativeDiagnosticUtc, firstLossReason: nativeStopReason,
  stopReason: nativeStopReason, exitObserved: z.boolean(), exitedAtUtc: nativeDiagnosticUtc.nullable(),
  exitCode: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
  exitSignal: z.string().regex(/^SIG[A-Z0-9]{1,20}$/).nullable(), nativeTurnOutcome: z.literal("unknown"),
}).refine(value => value.exitObserved ? value.exitedAtUtc !== null :
  value.exitedAtUtc === null && value.exitCode === null && value.exitSignal === null);
export type NativeChildDiagnosticRecord = z.infer<typeof nativeChildDiagnosticSchema>;

/** A runtime session is a project-owned binding, never an arbitrary native thread ID. */
export interface RuntimeBinding {
  sessionId: string;
  roleId: string;
  projectId: string;
  nativeThreadId: string;
  nativeSessionId: string;
  cwd: string;
  authorizationScope: string;
  owner: RuntimeOwner;
  observedModel?: string | null; observedProvider?: string | null;
  /** Persisted Session profile for an exact native resume; omitted only for legacy read-only inspection. */
  resumeProfile?: { actorId: string; model: string | null; reasoningEffort?: string | null; sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "on-request" | "untrusted" | "never"; executionProfileRevisionId?: string };
}

export interface RuntimeSessionSpec {
  /** Trusted reservation actor; not sent as user-editable native input. */
  actorId?: string;
  sessionId: string;
  roleId: string;
  projectId: string;
  cwd: string;
  authorizationScope: string;
  model?: string;
  reasoningEffort?: string | null;
  executionProfileRevisionId?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "untrusted" | "never";
  /** Runtime the Session was reserved for; absent means codex. Routes creation when one service drives both. */
  provider?: RuntimeProvider;
}

export interface RuntimeTurn {
  id: string;
  status: string;
  /** Native settled timestamp in canonical UTC; null while history has not proved completion. */
  completedAtUtc?: string | null;
  /** Classified native failure metadata; never raw provider text or session material. */
  error?: RuntimeTurnFailure;
  /** Provider-reported usage for this Turn when the provider reports it per Turn. */
  usage?: RuntimeUsage | null;
  /** Provider-reported cost in USD for this Turn; absent when the provider reports none. */
  costUsd?: number | null;
  /** What the native runtime reported loading for this Turn; absent when the adapter observes none. */
  observedCapabilities?: RuntimeObservedCapabilities | null;
}

/**
 * What one Claude Turn loads besides the runtime's own discovery, computed from the Role's skill selection.
 * Each source the Role uses becomes one local plugin whose `skills/<name>` entries link to the original skill
 * directories, so a Turn always reads the skills as they are on disk. This is a context selection, not a
 * security boundary: a Session with full access can still read any file.
 */
export interface RuntimeSkillPlan {
  /** sha256 over the plugins, their links, `off` and `builtin`; the same plan always yields the same hash. */
  planHash: string;
  plugins: Array<{
    /** Plugin name the runtime qualifies skill names with (`<name>:<skill>`). */
    name: "evoloop" | "project" | "personal";
    /** Absolute directory holding `.claude-plugin/plugin.json` and `skills/<skill>` links. */
    root: string;
    skills: Array<{ name: string; target: string }>;
  }>;
  /** Names the runtime discovers by itself (built-ins, project `.claude/skills`) that this plan turns off. */
  off: string[];
  /** false turns off the skills bundled with the runtime. */
  builtin: boolean;
}

/** A runtime's own discovery for one work directory. Bounded names and metadata; never skill bodies. */
export interface RuntimeCapabilityListing {
  skills: Array<{ name: string; path: string; scope: "user" | "repo" | "system" | "admin"; enabled: boolean;
    description: string | null; pluginId: string | null }>;
  /** Installed plugins; null when the list could not be read (see errors). */
  plugins: Array<{ name: string; enabled: boolean }> | null;
  /** Configured MCP servers and their auth state; null when the list could not be read. */
  mcpServers: Array<{ name: string; auth: string | null }> | null;
  /** Methods whose list could not be read. */
  errors: string[];
}

/** Bounded native report of what one Turn loaded. Names only, never skill bodies or paths. */
export interface RuntimeObservedCapabilities {
  /** claude.init: the session init message of the Turn process. */
  source: "claude.init";
  observedAtUtc: string;
  /** Skill plan the adapter supplied for this Turn; null when none was configured. */
  planHash: string | null;
  /** Skill names the runtime reported loading, after the plan's filters. */
  discoveredSkills: string[];
  /** Plan skills as the runtime names them (`<plugin>:<skill>`); null when no plan was supplied. */
  allowedSkills: string[] | null;
  /** Plan skills the runtime did not report; non-empty means the Turn ran without them. */
  missingSkills: string[];
  plugins: string[];
  /** Plugin load errors as category only (e.g. path-not-found); messages are not kept. */
  pluginErrors: string[];
  /**
   * MCP server names the runtime reported. evoLoop gives a Session none, so any entry is a server it did not
   * configure (for example an account connector) and the Turn could reach its tools.
   */
  mcpServers: string[];
  /** project: the runtime read project settings (hooks, CLAUDE.md, project skills); explicit: only what the adapter passed. */
  contextMode: "project" | "explicit";
  /** Project instruction file the adapter passed in explicit mode; null when none or in project mode. */
  instructions: { file: "AGENTS.md" | "CLAUDE.md"; contentHash: string; truncated: boolean } | null;
}

/** Provider-reported token usage. Null fields were not reported, never zero by inference. */
export interface RuntimeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

export interface RuntimeTurnFailure {
  /** context_window_exceeded: the same Session may be retried; the native runtime compacts before its next Turn. */
  category: "unsupported_model" | "rate_limited" | "provider_rejected" | "provider_unavailable" |
    "context_window_exceeded" | "budget_exceeded" | "authentication_failed" | "native_failure";
  providerCode: string | null;
  httpStatus: number | null;
  summary: string;
}

/** Bounded native evidence for one maintenance compaction on an owned Thread. */
export interface RuntimeCompactionObservation {
  threadId: string;
  threadStatus: string;
  model: string | null;
  reasoningEffort: string | null;
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  latestTurnCompletedAtUtc: string | null;
  compactionItemId: string | null;
  compactionItemCompleted: boolean;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface RuntimePage<T> {
  data: T[];
  nextCursor: string | null;
}

/** Read-only observed work. Null means the native history did not provide the fact. */
export interface RuntimeWorkItem {
  id: string;
  kind: "command" | "tool" | "file_change" | "message" | "web_search" | "artifact";
  name: string | null;
  status: string | null;
  exitCode: number | null;
  text: string | null;
  output: string | null;
  error: string | null;
  artifactRefs: string[];
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  durationMs: number | null;
  truncated: boolean;
}
export interface RuntimeWorkPage extends RuntimePage<RuntimeWorkItem> {
  unsupportedCount: number;
  truncated: boolean;
}
export interface RuntimeWorkTrace {
  runId: string;
  nativeTurnId: string;
  source: "owned-native-history";
  observedAt: string;
  turn: RuntimeTurn | null;
  turnMetadata: { status: "found" | "partial" | "not_found"; nextTurnCursor: string | null };
  items: RuntimeWorkItem[];
  unsupportedCount: number;
  truncated: boolean;
  nextCursor: string | null;
  completeness: "complete" | "partial";
  limits: { maxPages: number; maxItems: number; maxFieldChars: number };
}
export interface RuntimeReconcilePartial {
  status: "partial"; changed: false; projectId: string; runId: string; nativeTurnId: string;
  expectedVersion: number; nextTurnCursor: string; reason: string;
}

export interface RuntimeEvent {
  method: string;
  /** Added only by the adapter after matching its registered owned binding. */
  projectId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  params: unknown;
}

export interface RuntimeApprovalRequest {
  id: string | number;
  method: string;
  projectId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  params: unknown;
}

/** Model choices the native runtime reports for the current login. */
export interface RuntimeModelList {
  status: "available" | "empty" | "unavailable";
  models: string[];
  options: Array<{ model: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string | null }>;
  error: string | null;
  observedAtUtc: string;
}

/**
 * Minimum history item vocabulary the coordinator reads from `listItems`. Adapters map their
 * native items into these shapes; any other item type passes through and is treated as opaque.
 * The durable `[evoloop-run-operation:<id>]` marker is read from the first `userMessage` text.
 */
export type RuntimeHistoryItem =
  | { id: string; type: "userMessage"; content: Array<{ type: "text"; text: string }> }
  | { id: string; type: "agentMessage"; text: string; phase?: "final_answer" | "commentary" | null }
  | { id: string; type: string; [key: string]: unknown };

export const runtimeProviders = ["codex", "claude"] as const;
export type RuntimeProvider = typeof runtimeProviders[number];
export type RuntimeOwner = "evoloop-codex-app-server" | "evoloop-claude-agent-sdk";
const ownerByProvider = { codex: "evoloop-codex-app-server", claude: "evoloop-claude-agent-sdk" } as const satisfies Record<RuntimeProvider, RuntimeOwner>;
export const runtimeProviderSchema = z.enum(runtimeProviders);
/** The binding owner written by the adapter for one provider. */
export const ownerOf = (provider: RuntimeProvider): RuntimeOwner => ownerByProvider[provider];
/** Provider for a binding owner; null for a foreign owner string. */
export function providerOfOwner(owner: unknown): RuntimeProvider | null {
  for (const provider of runtimeProviders) if (ownerByProvider[provider] === owner) return provider;
  return null;
}
/** Persisted Session provider; rows that predate providers are Codex. */
export const sessionProvider = (session: { runtimeProvider?: RuntimeProvider | null }): RuntimeProvider =>
  session.runtimeProvider ?? "codex";
/** True when the binding was written by the adapter of the Session's own provider. */
export const bindingMatchesSession = (binding: { owner: unknown }, session: { runtimeProvider?: RuntimeProvider | null }): boolean =>
  binding.owner === ownerOf(sessionProvider(session));

/**
 * What one adapter can promise. The coordinator reads these declarations instead of
 * assuming a provider; an absent capability is unsupported, never silently emulated.
 */
export interface RuntimeCapabilities {
  provider: RuntimeProvider;
  /** shared: one child serves every Session, so one transport loss affects all in-flight Turns. */
  process: "shared" | "per_turn";
  delivery: {
    /** Input can be added to an active Turn. */
    midTurnInput: boolean;
    /** The caller's operation key is echoed in native history, so Turn correlation needs no text marker. */
    callerAssignedTurnKey: boolean;
    /** The caller can choose the native Session ID before creation. */
    callerAssignedSessionId: boolean;
  };
  /** Outcome classes this adapter can return for a native start besides Unknown. */
  errors: { notSent: boolean; rejected: boolean };
  compaction: {
    /** The native runtime compacts by itself before the context window overflows. */
    autoCompacts: boolean;
    /** How an owner-requested compaction is triggered, if at all. */
    mode: "owned_request" | "unavailable";
  };
  history: { workTrace: boolean; workspace: boolean };
  naming: boolean;
  /** native: the provider archives the Thread; adapter_ledger: the adapter durably refuses further Turns; the native transcript is kept. */
  archive: "native" | "adapter_ledger" | "unavailable";
  nativeInput: boolean;
  executionProfileActivation: boolean;
  modelList: boolean;
  usage: "per_turn" | "unavailable";
  cost: boolean;
}

export interface RuntimePort {
  /** Declared adapter capabilities. Optional only for legacy test doubles; real adapters declare them. */
  capabilities?(): RuntimeCapabilities;
  /** Model choices for the current native login. */
  listModels?(): Promise<RuntimeModelList>;
  /** What the runtime discovers for a work directory, read on demand without starting a Session. */
  listCapabilities?(cwd: string, options?: { skillsOnly?: boolean }): Promise<RuntimeCapabilityListing>;
  /** Handles belong to one owned stdio connection, never to a replacement process. */
  nativeInputConnectionId?(): string | null;
  onNativeInput?(listener: (event: NativeInputEvent) => void | Promise<void>): () => void;
  hasPendingInput?(id: string, connectionId: string): boolean;
  respondToInput?(id: string, connectionId: string, answers: Record<string, string[]>): Promise<void>;
  create(spec: RuntimeSessionSpec): Promise<RuntimeBinding>;
  /** Resume the owned Thread with the current versioned execution profile. */
  resume(binding: RuntimeBinding, spec: RuntimeSessionSpec): Promise<RuntimeBinding>;
  inspect(binding: RuntimeBinding): Promise<unknown>;
  /** Only the existing owner connection may issue this once for a durable operation. */
  compactThread?(binding: RuntimeBinding, baselineTurnId: string,
    beforeSend: (requestId: number) => Promise<void>, afterAccepted?: (connectionId: string) => Promise<void>): Promise<string | null>;
  observeCompaction?(binding: RuntimeBinding, targetTurnId?: string): Promise<RuntimeCompactionObservation>;
  /** Read the exact owned Thread's native title; null means no title is set. */
  readThreadName?(binding: RuntimeBinding): Promise<string | null>;
  /** Name metadata only; this must never start a model Turn. */
  setThreadName?(binding: RuntimeBinding, name: string): Promise<void>;
  listTurns(binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimePage<unknown>>;
  /** Optional classified trace capability. Absence means unsupported, never an empty complete trace. */
  readWorkPage?(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimeWorkPage>;
  /** Source-ordered, permission-neutral display facts. Never resumes or starts work. */
  readWorkspaceHistory?(binding: RuntimeBinding, options?: NativeWorkspaceReadOptions): Promise<NativeWorkspacePage>;
  /** Public display updates from this same native owner connection, not a replay log. */
  onWorkspaceUpdate?(listener: (event: WorkspaceRuntimeUpdate) => void): () => void;
  startTurn(binding: RuntimeBinding, input: string, operationId: string,
    executionProfile?: ExecutionProfileSnapshot | null): Promise<RuntimeTurn>;
  interruptTurn(binding: RuntimeBinding, turnId: string): Promise<void>;
  /** Optional native archive; an acknowledgement alone never proves archival. */
  archiveThread?(binding: RuntimeBinding): Promise<void>;
  /** True only after the exact owned identity appears in native archived history. */
  isThreadArchived?(binding: RuntimeBinding): Promise<boolean>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  onApprovalRequest(listener: (request: RuntimeApprovalRequest) => void | Promise<void>): () => void;
  close(): Promise<void>;
}
