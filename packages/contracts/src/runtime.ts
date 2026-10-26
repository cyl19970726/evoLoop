import { z } from "zod";
import type { EvaluationFixedRef } from "./evaluation.js";
import type { ExecutionProfileSnapshot, SessionExecutionProfile } from "./session-recovery.js";

export const runtimeReconcileSchema = z.strictObject({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(4000) });

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const common = { projectId: id, operationId: id };
export const runtimeCommands = [
  z.strictObject({ ...common, type:z.literal("runtime.handoff.record"),runId:id,stage:z.enum(["received","read","adopted","effect"]),evidence:text }),
  z.strictObject({ ...common, type: z.literal("runtime.session.reserve"), sessionId: id, roleId: text, cwd: z.string().min(1).max(1024).regex(/^\//), authorizationScope: text, model: text.optional(), sandbox: z.enum(["read-only", "workspace-write"]), approvalPolicy: z.enum(["on-request", "untrusted"]) }),
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
  model: string | null; sandbox: "read-only" | "workspace-write"; approvalPolicy: "on-request" | "untrusted";
  state: RuntimeSessionState; version: number; nativeThreadId: string | null; nativeSessionId: string | null;
  operationId: string; actorId: string; createdAt: string; updatedAt: string;
  closeOperationId?: string | null; closeAttemptedAt?: string | null; closeVerifiedAt?: string | null;
  /** Adopted configured profile and its native activation status. */
  executionProfile?: SessionExecutionProfile | null;
}
export interface RuntimeRunRecord {
  projectId: string; id: string; taskId: string; taskRevisionId: string; basisSetId: string;
  sessionId: string; operationId: string; input: string; inputHash: string;
  state: RuntimeRunState; version: number; nativeTurnId: string | null;
  interruptRequested: boolean; resultSummary: string | null; actorId: string; createdAt: string; updatedAt: string;
  evaluationBinding?: { evaluationId: string; revisionId: string; caseId: string; conditionId: string;
    sourceTaskRevisionId: string; actualTaskRevisionId: string; attemptId: string } | null;
  evaluationPacket?: EvaluationPacketBinding | null;
  /** Immutable configured launch profile; this is not provider-reported actual model telemetry. */
  executionProfile?: ExecutionProfileSnapshot | null;
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
    "run.requested" | "run.dispatching" | "run.preflightRejected" | "run.dispatchRejected" | "run.bound" | "run.status" | "run.unknown" |
    "run.reviewed" | "run.reconciled" | "run.interruptRequested" | "run.interruptResult" |
    "session.executionProfile.activationStarted" | "session.executionProfile.active" |
    "session.executionProfile.unknown" | "session.executionProfile.rejected" |
    "runtime.approvalDeclined" | "handoff.received" | "handoff.read" | "handoff.adopted" | "handoff.effect";
  detail: string; nativeTurnId: string | null; cursor: string | null; itemsDigest: string | null;
  actorId: string; createdAt: string;
}

/** A runtime session is a project-owned binding, never an arbitrary native thread ID. */
export interface RuntimeBinding {
  sessionId: string;
  roleId: string;
  projectId: string;
  nativeThreadId: string;
  nativeSessionId: string;
  cwd: string;
  authorizationScope: string;
  owner: "evoloop-codex-app-server";
  /** Persisted Session profile for an exact native resume; omitted only for legacy read-only inspection. */
  resumeProfile?: { actorId: string; model: string | null; sandbox: "read-only" | "workspace-write";
    approvalPolicy: "on-request" | "untrusted"; executionProfileRevisionId?: string };
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
  executionProfileRevisionId?: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "on-request" | "untrusted";
}

export interface RuntimeTurn {
  id: string;
  status: string;
  /** Native settled timestamp in canonical UTC; null while history has not proved completion. */
  completedAtUtc?: string | null;
  /** Classified native failure metadata; never raw provider text or session material. */
  error?: RuntimeTurnFailure;
}

export interface RuntimeTurnFailure {
  category: "unsupported_model" | "rate_limited" | "provider_rejected" | "provider_unavailable" | "native_failure";
  providerCode: string | null;
  httpStatus: number | null;
  summary: string;
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
  source: "owned-native-history";
  observedAt: string;
  turn: RuntimeTurn;
  items: RuntimeWorkItem[];
  unsupportedCount: number;
  truncated: boolean;
  nextCursor: string | null;
  completeness: "complete" | "partial";
  limits: { maxPages: number; maxItems: number; maxFieldChars: number };
}

export interface RuntimeEvent {
  method: string;
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

export interface RuntimePort {
  create(spec: RuntimeSessionSpec): Promise<RuntimeBinding>;
  /** A business restore following an ordinary Turn requires the durably dispatched Run operation ID. */
  resume(binding: RuntimeBinding, spec: RuntimeSessionSpec, dispatchOperationId?: string): Promise<RuntimeBinding>;
  inspect(binding: RuntimeBinding): Promise<unknown>;
  listTurns(binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimePage<unknown>>;
  /** Optional classified trace capability. Absence means unsupported, never an empty complete trace. */
  readWorkPage?(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimeWorkPage>;
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
