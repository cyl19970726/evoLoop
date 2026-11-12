// Confirmations asked from code that runs before the design system loads (App: leaving a project or signing out with
// drafts or unconfirmed operations). This module has no UI imports, so it stays in the first load; the dialog itself
// is shared/ui/ConfirmHost.tsx, which App mounts after login. Pages that already render @evoloop/ui use ConfirmDialog.
//
// A question never outlives the sign-in it was asked in, and never waits for a dialog that cannot appear:
// - signing out, a 401 and the host leaving the page answer every open question with "cancel" (cancelConfirms);
// - when the host's chunk fails to load, or has not mounted within `hostWaitMs`, the questions are cancelled and the
//   listeners of onConfirmUnavailable say so; until the host mounts again, a new question is cancelled at once.

export interface ConfirmRequest {
  /** The question, naming what is affected: 离开当前项目？ */
  title: string;
  /** What happens after confirming, and what is kept. */
  description?: string;
  /** A verb for what confirming does. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Confirming discards something (drafts): the confirm button is drawn as danger. */
  danger?: boolean;
}

export interface PendingConfirm extends ConfirmRequest { id: number }

/** How long a question waits for the dialog's code to load before it is cancelled. */
export const hostWaitMs = 10_000;

type Entry = PendingConfirm & { resolve(confirmed: boolean): void };
let queue: Entry[] = [];
let nextId = 1;
let hostMounted = false;
let hostFailed = false;
const listeners = new Set<() => void>();
const unavailableListeners = new Set<() => void>();
const retryListeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
const reportUnavailable = () => { for (const listener of [...unavailableListeners]) listener(); };

/** Ask; resolves true when confirmed, false when cancelled. Requests made while one is open wait their turn. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  if (hostFailed && !hostMounted) {
    // The dialog's code failed to load earlier. Another question is another chance: the app is asked to load it again, and the question waits
    // for it like any other. Without anyone to load it (no listener) the question is cancelled at once, as before.
    if (!retryListeners.size) {
      reportUnavailable();
      return Promise.resolve(false);
    }
    hostFailed = false;
    for (const listener of [...retryListeners]) listener();
  }
  return new Promise(resolve => {
    const entry: Entry = { ...request, id: nextId++, resolve };
    queue = [...queue, entry];
    emit();
    if (!hostMounted) setTimeout(() => { if (!hostMounted && queue.includes(entry)) confirmHostFailed(); }, hostWaitMs);
  });
}

/** The question on screen now, if any. */
export function currentConfirm(): PendingConfirm | null {
  return queue[0] ?? null;
}

/** Answer the question on screen; the next one, if any, takes its place. */
export function answerConfirm(confirmed: boolean): void {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  emit();
  first.resolve(confirmed);
}

/** Answer every open question with "cancel": on signing out, on a 401, when the dialog host leaves the page. */
export function cancelConfirms(): void {
  const open = queue;
  if (!open.length) return;
  queue = [];
  emit();
  for (const entry of open) entry.resolve(false);
}

/** ConfirmHost calls this when it mounts; the returned function, when it unmounts. */
export function confirmHostMounted(): () => void {
  hostMounted = true;
  hostFailed = false;
  return () => { hostMounted = false; cancelConfirms(); };
}

/** The dialog's code could not be loaded: cancel what is waiting and say so. */
export function confirmHostFailed(): void {
  hostFailed = true;
  const waiting = queue.length > 0;
  cancelConfirms();
  if (waiting) reportUnavailable();
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called when a question was cancelled because the dialog could not be shown. */
export function onConfirmUnavailable(listener: () => void): () => void {
  unavailableListeners.add(listener);
  return () => { unavailableListeners.delete(listener); };
}

/** The app loads the dialog's code again when a question is asked after a failed load. */
export function onConfirmRetry(listener: () => void): () => void {
  retryListeners.add(listener);
  return () => { retryListeners.delete(listener); };
}
