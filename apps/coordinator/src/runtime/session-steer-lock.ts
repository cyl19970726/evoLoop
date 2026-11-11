import { DomainError } from "@evoloop/contracts/ports";

const key = (projectId: string, sessionId: string) => `${projectId}\u0000${sessionId}`;

/**
 * One in-process admission around native input for a Session: a new Turn, a user steer and a later
 * notification-package steer all take this lock. It covers only the short native admission/send, never
 * the Turn lifetime, so the next waitable operation runs after the current send settles.
 */
export class SessionSteerLock {
  private readonly held = new Set<string>();

  isBusy(projectId: string, sessionId: string): boolean {
    return this.held.has(key(projectId, sessionId));
  }

  /** Returns an idempotent release, or null without touching any durable state when another send owns the lock. */
  tryAcquire(projectId: string, sessionId: string): (() => void) | null {
    const value = key(projectId, sessionId);
    if (this.held.has(value)) return null;
    this.held.add(value);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(value);
    };
  }

  /** Direct-input HTTP callers use this failure; it is a local, retryable admission conflict. */
  acquire(projectId: string, sessionId: string): () => void {
    const release = this.tryAcquire(projectId, sessionId);
    if (release) return release;
    throw new DomainError("SESSION_INPUT_BUSY",
      "该会话正在开始另一轮或接收另一条输入；稍后用同一输入编号重试");
  }
}
