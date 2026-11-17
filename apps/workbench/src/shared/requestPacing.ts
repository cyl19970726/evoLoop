// Behind the Hub a machine answers at most 8 forwarded requests at a time and refuses the rest with 429 (CONNECTOR_BUSY, apps/coordinator hub/connector.ts). It counts a request as in
// flight until the Hub has accepted its answer, which is a round trip after the page already has it, so a page that fires its reads all at once (a project with ten Sessions
// does) is refused by its own burst (Task 5a47dcb8). The page therefore paces its requests when it runs behind the Hub: at most `maxInflight` at once, and a short gap between
// starts. The machine's limit stays as it is; the page just stays below it.
export interface RequestPacer { acquire(signal?: AbortSignal | null): Promise<() => void> }

export function createRequestPacer(options: { maxInflight: number; minGapMs: number; now?: () => number; wait?: (ms: number) => Promise<void> }): RequestPacer {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  let inflight = 0, lastStart = Number.NEGATIVE_INFINITY, pumping = false;
  const queue: Array<{ grant: (release: () => void) => void; fail: (reason: unknown) => void; signal: AbortSignal | null; settled: boolean }> = [];
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && inflight < options.maxInflight) {
        const gap = lastStart + options.minGapMs - now();
        if (gap > 0) await wait(gap);
        const next = queue.shift();
        if (!next || next.settled) continue;
        if (next.signal?.aborted) { next.settled = true; next.fail(abortError()); continue; }
        if (inflight >= options.maxInflight) { queue.unshift(next); continue; }
        inflight += 1; lastStart = now(); next.settled = true;
        let released = false;
        next.grant(() => { if (released) return; released = true; inflight -= 1; void pump(); });
      }
    } finally { pumping = false; }
  }
  return {
    acquire(signal) {
      return new Promise((grant, fail) => {
        if (signal?.aborted) { fail(abortError()); return; }
        const entry = { grant, fail, signal: signal ?? null, settled: false };
        signal?.addEventListener("abort", () => { if (!entry.settled) { entry.settled = true; const at = queue.indexOf(entry); if (at >= 0) queue.splice(at, 1); fail(abortError()); } }, { once: true });
        queue.push(entry); void pump();
      });
    },
  };
}

/** How long to wait before asking again after the machine said it was busy: the first retry soon, the second later, with some spread so tabs do not retry together. */
export const busyRetryDelayMs = (attempt: number, random: () => number = Math.random): number => Math.round((attempt === 1 ? 350 : 900) * (0.75 + random() * 0.5));
export const maxBusyRetries = 2;
