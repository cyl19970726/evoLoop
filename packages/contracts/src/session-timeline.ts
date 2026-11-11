import type { SessionKey } from './session-work.js';

export type WorkspacePhase = 'commentary' | 'partial_answer' | 'final_answer' | 'unknown';
export type WorkspaceState = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'declined' | 'unknown';
export interface WorkspaceAuthor {
  kind: 'actor' | 'session' | 'native' | 'system';
  id: string | null;
  label: string;
}
export interface WorkspaceOrigin {
  kind: 'run' | 'message' | 'native';
  id: string;
  taskId: string | null;
  taskRevisionId: string | null;
  initiatingActorId: string | null;
}
export interface WorkspaceOrderAnchor {
  kind: 'timeline-position' | 'native-item' | 'turn-boundary' | 'saved-message' | 'live-item';
  /** A source key also exists when the native notification has no Item ID. */
  key: string;
  position: number | null;
  /** Read projection or connection generation, never a promise of native event replay. */
  generation: string | null;
}
export interface WorkspaceEntryBase {
  /** Stable source identity; neither display text nor an observed timestamp. */
  id: string;
  turnId: string | null;
  nativeItemId: string | null;
  nativeKind: string | null;
  author: WorkspaceAuthor;
  origin: WorkspaceOrigin | null;
  occurredAt: string | null;
  observedAt: string;
  freshness: 'persisted' | 'live' | 'stale';
  truncated: boolean;
  order?: WorkspaceOrderAnchor;
}
export interface WorkspaceMessage extends WorkspaceEntryBase {
  kind: 'message';
  role: 'input' | 'assistant';
  phase: WorkspacePhase;
  body: string;
  clientId: string | null;
  state: WorkspaceState;
  /** Why a saved, still pending message is waiting (for example a missing message grant); absent when nothing blocks it. */
  blockedReason?: string | null;
  /** Explicit dispatch marker, retained without exposing the generated input envelope. */
  inputReference?: { kind: 'operation-marker'; source: 'run' | 'message'; operationId: string };
}
export interface WorkspaceTool extends WorkspaceEntryBase {
  kind: 'tool';
  name: string;
  summary: string;
  state: WorkspaceState;
  durationMs: number | null;
  exitCode: number | null;
  detailAvailable: boolean;
  detailReason: string | null;
  detail?: { input: string | null; output: string | null; error: string | null; resources: string[] };
}
export interface WorkspaceRecord extends WorkspaceEntryBase {
  kind: 'plan' | 'question' | 'artifact' | 'notice';
  label: string;
  body: string;
  state: WorkspaceState;
}
/**
 * One native reasoning record of a Turn: a Codex `reasoning` Item or one Claude thinking block, in native order.
 * The body is only what the native record holds in readable form. Encrypted, redacted or omitted reasoning stays
 * `readable: false` with an empty body; nothing is inferred from the answer. Readers need project read access, and
 * these entries never enter Leader notices or notice packages.
 */
export interface WorkspaceReasoning extends WorkspaceEntryBase {
  kind: 'reasoning';
  /** summary: provider reasoning summary; raw: readable native reasoning text; thinking: Claude thinking text; none: nothing readable. */
  source: 'summary' | 'raw' | 'thinking' | 'none';
  readable: boolean;
  body: string;
  /** Why nothing readable is shown, for example encrypted or omitted reasoning. Null when readable. */
  unavailableReason: string | null;
  state: WorkspaceState;
}
export type WorkspaceEntry = WorkspaceMessage | WorkspaceTool | WorkspaceRecord | WorkspaceReasoning;
/** Tokens the native source reported for one Turn. Null fields were not reported, never zero by inference. */
export interface WorkspaceTurnUsage {
  outputTokens: number | null;
  /** Reasoning or thinking tokens, already counted inside outputTokens. */
  reasoningOutputTokens: number | null;
  /** Where the numbers come from, so a reader can check them against the native record. */
  source: 'codex-token-usage' | 'claude-result';
}
export interface WorkspaceTurn {
  id: string;
  state: WorkspaceState;
  startedAt: string | null;
  completedAt: string | null;
  origin: WorkspaceOrigin | null;
  order?: WorkspaceOrderAnchor;
  /** Per-Turn native token usage when the source reported it; absent or null when unknown. */
  usage?: WorkspaceTurnUsage | null;
}
export interface NativeWorkspacePage {
  entries: WorkspaceEntry[];
  turns: WorkspaceTurn[];
  nextCursor: string | null;
  observedAt: string;
  historyMode: 'legacy' | 'paginated' | 'unknown';
  method: 'timeline' | 'items' | 'turns-full';
  partial: boolean;
  /** Complete Item enumeration, independent of public text preview truncation. */
  itemEnumerationComplete?: boolean;
  limitations: string[];
  unsupportedKinds: string[];
}
export interface NativeWorkspaceReadOptions {
  cursor?: string;
  limit?: number;
  turnId?: string;
  itemId?: string;
  /** The coordinator must separately authorize original tool evidence. */
  detail?: boolean;
}
export type WorkspaceRuntimeUpdate = {
  projectId: string;
  sessionId: string;
  threadId: string;
  turnId: string | null;
  observedAt: string;
} & ({ kind: 'entry'; entry: WorkspaceEntry } |
  { kind: 'text-delta'; itemId: string; delta: string; truncated?: boolean } |
  { kind: 'turn'; turn: WorkspaceTurn } |
  { kind: 'reset'; reason: string });
export interface WorkspaceLiveRead {
  cursor: string;
  resetRequired: boolean;
  entries: WorkspaceEntry[];
  turns: WorkspaceTurn[];
  freshness: 'live' | 'stale' | 'unavailable';
  limitations: string[];
  /** A current scoped start notification, never inferred from historical Turn status. */
  activeTurnId?: string | null;
}
export interface SessionTimelinePage {
  sessionKey: SessionKey;
  sessionTitle: string;
  entries: WorkspaceEntry[];
  pending: WorkspaceMessage[];
  turns: WorkspaceTurn[];
  /** Independently advancing native history and business message positions. */
  nextCursor: string | null;
  messagesCursor: string | null;
  observedAt: string;
  partial: boolean;
  limitations: string[];
  unsupportedKinds: string[];
  live: WorkspaceLiveRead;
  capabilities: { history: boolean; live: boolean; originalToolDetail: boolean; reason: string | null };
}
