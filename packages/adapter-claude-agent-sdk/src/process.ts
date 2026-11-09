import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export interface ProcessHooks {
  /**
   * Called synchronously immediately before a top-level user message line reaches the child's stdin.
   * Returning false suppresses that write: the prompt then provably never reached the native process.
   */
  beforeUserWrite(): boolean;
  onPid?(pid: number): void;
}

/** Signal the child's whole process group (tools it started included); fall back to the child alone. */
export function signalGroup(child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* group already gone; try the child */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

/** True when the chunk may carry a user message. A chunk that cannot be parsed is treated as one. */
export function carriesUserMessage(chunk: unknown): boolean {
  const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
  if (text === null) return true;
  return text.split("\n").some(line => {
    if (!line.trim()) return false;
    try {
      const value = JSON.parse(line) as { type?: unknown };
      return value?.type === "user";
    } catch { return true; }
  });
}

/**
 * Spawn the Claude Code CLI for one SDK query. The child gets its own process group so a stop reaches every
 * tool it started, its stderr is drained (never stored: it can carry prompts or paths), and every stdin write
 * that carries the user message passes through `beforeUserWrite`, which is the adapter's not-sent proof.
 */
export function spawnClaudeProcess(options: SpawnOptions, hooks: ProcessHooks): ChildProcessWithoutNullStreams {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", windowsHide: true,
  });
  if (child.pid) hooks.onPid?.(child.pid);
  child.stderr.on("error", () => undefined);
  child.stderr.resume();
  const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
  child.stdin.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (carriesUserMessage(chunk) && !hooks.beforeUserWrite()) {
      const callback = rest.find((value): value is (error?: Error | null) => void => typeof value === "function");
      if (callback) queueMicrotask(() => callback(new Error("prompt withdrawn before write")));
      return true;
    }
    return write(chunk, ...rest);
  }) as typeof child.stdin.write;
  const stop = () => signalGroup(child, "SIGTERM");
  if (options.signal.aborted) stop();
  else options.signal.addEventListener("abort", stop, { once: true });
  return child;
}
