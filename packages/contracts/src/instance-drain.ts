/** Drain mode (docs/architecture/deployment.md §2): what `GET /api/instance/drain` returns. */
export type DrainState = "active" | "draining" | "drained";
export interface DrainInFlight {
  runs: Array<{ projectId: string; runId: string; taskId: string; sessionId: string; state: string; updatedAt: string }>;
  messageTurns: Array<{ projectId: string; messageId: string; sessionId: string; state: string; updatedAt: string }>;
  /** Totals, which may exceed the lists (each list shows at most 50; a non-maintainer gets the counts only). */
  counts: { runs: number; messageTurns: number; total: number };
}
export interface DrainStatus {
  state: DrainState;
  /** Whether new Runs and message Turns are held (draining or drained). */
  holding: boolean;
  version: number;
  actorId: string | null;
  reason: string | null;
  changedAt: string;
  /** Queued, not begun: they wait and resume in order when the drain is released. */
  queued: { runs: number; messages: number };
  inFlight: DrainInFlight;
  /** Only a drained instance may be stopped for a release. */
  safeToStop: boolean;
  observedAt: string;
}
export interface InstanceDrainView extends DrainStatus { maintainer: boolean }
