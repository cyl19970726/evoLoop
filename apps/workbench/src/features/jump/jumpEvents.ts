// The “跳到” box is one dialog in the shell; anything in the app opens it through here (the rail button, the phone header
// button, ⌘K / Ctrl+K and the 找不到这个对象 page), optionally with a text already in it.
type Listener = (initial: string, returnFocus: HTMLElement | null) => void;
const listeners = new Set<Listener>();
// The box itself loads on first use; a request made before it is there waits here for it.
let pending: { initial: string; from: HTMLElement | null } | null = null;
/** The box has taken the request (it was mounted, or has just mounted and asks). */
export function takePendingJump(): { initial: string; from: HTMLElement | null } | null { const taken = pending; pending = null; return taken; }

/** Open the box. Focus returns to what had it when the box closes. */
export function openJump(initial = ""): void {
  const active = typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pending = { initial, from: active && active !== document.body ? active : null };
  for (const listener of [...listeners]) listener(initial, active && active !== document.body ? active : null);
}
export function onOpenJump(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** ⌘K on a Mac, Ctrl+K elsewhere; the text the hint shows. */
export function jumpShortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}
export const isJumpShortcut = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) =>
  event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
