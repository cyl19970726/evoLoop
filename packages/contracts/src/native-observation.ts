import type { NativeInputSource } from './native-input.js';

export type NativeStatus = 'notLoaded' | 'idle' | 'systemError' | 'active';
export type NativeTurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed' | 'unknown';
export type NativeItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export interface NativeUsageBreakdown {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}
export interface NativeObservationRecord {
  projectId: string;
  sessionId: string;
  threadId: string;
  /** Internal connection identity; omit from human-facing projections. */
  connectionId: string;
  version: number;
  observedAt: string;
  lastEventAt: string;
  freshness: 'live' | 'stale';
  staleReason: string | null;
  status: NativeStatus | null;
  currentTurn: null | { id: string; status: NativeTurnStatus; source: NativeInputSource | null };
  items: Array<{ id: string; kind: string; name: string; status: NativeItemStatus; summary: string; truncated: boolean }>;
  plan: null | { turnId: string; steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>; explanation: string | null; truncated: boolean; observedAt: string };
  diff: null | { turnId: string; text: string; truncated: boolean; observedAt: string };
  usage: null | { turnId: string; total: NativeUsageBreakdown; last: NativeUsageBreakdown; modelContextWindow: number | null; observedAt: string };
}
export type NativeObservationProjection = Omit<NativeObservationRecord, 'version'>;
export interface NativeObservationEvent {
  projectId: string; sessionId: string; threadId: string; connectionId: string;
  method: string; params: unknown; observedAt: string;
}
export interface NativeObservationReader {
  get(projectId: string, sessionId: string): Promise<NativeObservationRecord | null>;
}
export interface NativeObservationTransaction extends NativeObservationReader {
  upsert(value: NativeObservationRecord, expectedVersion: number | null): Promise<void>;
  staleConnection(projectId: string, connectionId: string, reason: string, at: string): Promise<number>;
  invalidateConnections(projectId: string, currentConnectionId: string, at: string): Promise<number>;
}
