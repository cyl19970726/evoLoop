import { useEffect, useRef, useState, type RefObject } from "react";
import type { SessionChanges } from "@evoloop/contracts/session-observation";
import { errorText } from "../api";
import { sessionClient } from "../sessions/client";

export function allocationChangeRequiresReload(changes: SessionChanges): boolean {
  return changes.resetRequired || changes.items.length > 0 || changes.hasMore;
}

export type AllocationChangeSubscriber = {
  element: () => HTMLElement | null;
  visible: boolean;
  generation: number;
  invalidate: () => void;
  error: (message: string) => void;
};

class ProjectChangeWatcher {
  private readonly client: ReturnType<typeof sessionClient>;
  private readonly controller = new AbortController();
  private readonly subscribers = new Set<AllocationChangeSubscriber>();
  private cursor: string | null = null;
  private generation = 0;
  private busy = false;
  private message = "";
  private readonly timer: number;
  private readonly visible = () => { if (document.visibilityState === "visible") void this.check(); };

  constructor(token: string, projectId: string) {
    this.client = sessionClient(token, projectId);
    this.timer = window.setInterval(() => void this.check(), 15000);
    document.addEventListener("visibilitychange", this.visible);
    window.addEventListener("focus", this.visible);
  }

  get size(): number { return this.subscribers.size; }
  add(subscriber: AllocationChangeSubscriber): void {
    subscriber.generation = this.generation;
    this.subscribers.add(subscriber);
    if (this.message) subscriber.error(this.message);
    void this.check();
  }
  remove(subscriber: AllocationChangeSubscriber): void { this.subscribers.delete(subscriber); }
  dispose(): void {
    this.controller.abort(); window.clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.visible);
    window.removeEventListener("focus", this.visible);
  }
  private active(): AllocationChangeSubscriber[] {
    if (document.visibilityState === "hidden") return [];
    return [...this.subscribers].filter(subscriber => subscriber.visible && !!subscriber.element()?.getClientRects().length);
  }
  private tell(message: string): void {
    if (this.message === message) return;
    this.message = message;
    for (const subscriber of this.subscribers) subscriber.error(message);
  }
  private invalidate(): void {
    this.generation++;
    for (const subscriber of this.active()) {
      subscriber.generation = this.generation;
      subscriber.invalidate();
    }
  }
  private async baseline(): Promise<void> {
    const directory = await this.client.directory({ limit: 1 }, this.controller.signal);
    if (this.controller.signal.aborted) return;
    if (!directory.observationCursor) throw new Error("项目变化位置未返回");
    this.cursor = directory.observationCursor;
    this.tell("");
    // Read relations after this cursor, so a write between the reads is caught next check.
    this.invalidate();
  }
  async check(): Promise<void> {
    const active = this.active();
    if (!active.length || this.controller.signal.aborted) return;
    for (const subscriber of active) if (subscriber.generation < this.generation) {
      subscriber.generation = this.generation;
      subscriber.invalidate();
    }
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.cursor) await this.baseline();
      else {
        const changes = await this.client.changes(this.cursor, undefined, this.controller.signal);
        if (this.controller.signal.aborted) return;
        if (allocationChangeRequiresReload(changes)) {
          await this.baseline();
          if (changes.metadata.partial) this.tell("项目变化来源不完整，已重新核对关系；仍须留意来源限制。");
        } else if (changes.metadata.partial) {
          this.tell("项目变化来源不完整，无法确认关系是否仍是最新；保留上次读数，可手动重新读取。");
        } else { this.cursor = changes.nextCursor; this.tell(""); }
      }
    } catch (cause) {
      if (!this.controller.signal.aborted) this.tell(`项目变化读取失败：${errorText(cause)}。保留上次关系读数。`);
    } finally { this.busy = false; }
  }
}

const projectWatchers = new Map<string, ProjectChangeWatcher>();

export function subscribeAllocationChanges(token: string, projectId: string, subscriber: AllocationChangeSubscriber): () => void {
  const key = `${token}\0${projectId}`;
  let watcher = projectWatchers.get(key);
  if (!watcher) { watcher = new ProjectChangeWatcher(token, projectId); projectWatchers.set(key, watcher); }
  watcher.add(subscriber);
  return () => {
    watcher.remove(subscriber);
    if (!watcher.size) { watcher.dispose(); projectWatchers.delete(key); }
  };
}

/** A single cursor, request lock and timer per authenticated project; panels subscribe only while visible. */
export function useAllocationChanges(token: string, projectId: string, root: RefObject<HTMLElement | null>, onChange: () => void): string {
  const [error, setError] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    setError("");
    const subscriber: AllocationChangeSubscriber = { element: () => root.current, visible: typeof IntersectionObserver === "undefined", generation: 0,
      invalidate: () => onChangeRef.current(), error: setError };
    const unsubscribe = subscribeAllocationChanges(token, projectId, subscriber);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      subscriber.visible = entries.some(entry => entry.isIntersecting);
      if (subscriber.visible) void projectWatchers.get(`${token}\0${projectId}`)?.check();
    });
    if (observer && root.current) observer.observe(root.current);
    return () => {
      observer?.disconnect(); unsubscribe();
    };
  }, [token, projectId, root]);
  return error;
}
