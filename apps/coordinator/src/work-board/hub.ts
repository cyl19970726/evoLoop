import type { SchedEvent, SchedEventsPage } from "@evoloop/contracts/work-board";

export interface HubSubscriber { onEvents(items: SchedEvent[]): void; onReset(head: number): void }
/** One cheap look at the project's newest seq, and the read of what is after a given seq. */
export interface HubReads { head(projectId: string): Promise<number>; read(projectId: string, after: number, limit: number): Promise<SchedEventsPage> }

interface ProjectLoop { subscribers: Set<HubSubscriber>; last: number; timer: NodeJS.Timeout | null; running: boolean }

/**
 * One shared reader for every subscriber of the event stream. Per project a single loop reads the database, and only while at least one
 * subscriber is attached: with nobody on the page there is no timer and no query. The loop first asks for the newest seq (one indexed
 * row); only when it moved does it read the new events, once, and hand them to all subscribers.
 */
export class SchedEventHub {
  private readonly loops = new Map<string, ProjectLoop>();
  constructor(private readonly reads: HubReads, private readonly pollMs = 1000, private readonly onError: (error: unknown) => void = () => undefined) {}

  /** `after`: the position the caller already has; the hub delivers what comes after the later of it and its own start. */
  async subscribe(projectId: string, subscriber: HubSubscriber): Promise<() => void> {
    let loop = this.loops.get(projectId);
    if (!loop) {
      loop = { subscribers: new Set(), last: await this.reads.head(projectId), timer: null, running: false };
      this.loops.set(projectId, loop);
    }
    loop.subscribers.add(subscriber);
    if (!loop.timer) { loop.timer = setInterval(() => void this.tick(projectId), this.pollMs); loop.timer.unref(); }
    return () => {
      const current = this.loops.get(projectId);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (!current.subscribers.size) { if (current.timer) clearInterval(current.timer); this.loops.delete(projectId); }
    };
  }
  subscribers(projectId: string): number { return this.loops.get(projectId)?.subscribers.size ?? 0; }
  activeProjects(): number { return this.loops.size; }

  async tick(projectId: string): Promise<void> {
    const loop = this.loops.get(projectId);
    if (!loop || loop.running) return;
    loop.running = true;
    try {
      const head = await this.reads.head(projectId);
      if (head === loop.last) return;
      if (head < loop.last) { loop.last = head; for (const s of loop.subscribers) s.onReset(head); return; }
      for (;;) {
        const page = await this.reads.read(projectId, loop.last, 200);
        if (page.resetRequired) { loop.last = page.head; for (const s of loop.subscribers) s.onReset(page.head); return; }
        if (page.items.length) { loop.last = page.cursor; for (const s of loop.subscribers) s.onEvents(page.items); }
        if (!page.more) return;
      }
    } catch (error) { this.onError(error); }
    finally { loop.running = false; }
  }
}
