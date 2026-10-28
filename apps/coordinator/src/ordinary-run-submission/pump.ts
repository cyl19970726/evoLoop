import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import type { OrdinarySealResult } from "./seal.js";

export interface OrdinaryRunSealPumpDependencies {
  canWrite?(): boolean;
  listProjects(): Promise<string[]>;
  listUnsettled(projectId: string, limit: number, after?: {createdAtUtc:string;runId:string}): Promise<OrdinaryRunSubmissionRecord[]>;
  seal(projectId: string, runId: string): Promise<OrdinarySealResult>;
}

/** Restart scans the durable intent table; every cycle reaches past persistent blockers. */
export class OrdinaryRunSealPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycling = false;
  private lastError: string | null = null;
  constructor(private readonly deps: OrdinaryRunSealPumpDependencies) {}

  status() { return { running: this.timer !== null, cycling: this.cycling, lastError: this.lastError }; }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.cycle(); }, intervalMs);
    this.timer.unref?.();
    void this.cycle();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async cycle(): Promise<void> {
    if (this.cycling) return;
    if (this.deps.canWrite?.() === false) return;
    this.cycling = true;
    try {
      for (const projectId of await this.deps.listProjects()) {
        let after: {createdAtUtc:string;runId:string} | undefined;
        while (true) {
          const batch = await this.deps.listUnsettled(projectId, 100, after);
          for (const item of batch) {
            try { await this.deps.seal(projectId, item.runId); }
            catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
          }
          if (batch.length < 100) break;
          const last = batch.at(-1)!;
          after = {createdAtUtc:last.createdAtUtc,runId:last.runId};
        }
      }
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
    finally { this.cycling = false; }
  }
}
