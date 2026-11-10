// Confirmations asked from code that runs before the design system loads (App: leaving a project or signing out with
// drafts or unconfirmed operations). This module has no UI imports, so it stays in the first load; the dialog itself
// is shared/ui/ConfirmHost.tsx, which App mounts after login. Pages that already render @evoloop/ui use ConfirmDialog.

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

let queue: Array<PendingConfirm & { resolve(confirmed: boolean): void }> = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

/** Ask; resolves true when confirmed, false when cancelled. Requests made while one is open wait their turn. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { ...request, id: nextId++, resolve }];
    emit();
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

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
