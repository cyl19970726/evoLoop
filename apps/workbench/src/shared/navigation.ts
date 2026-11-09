// In-app addresses are paths: `/p/{project}/…`, `/` for the project list and `/ui` for the component samples.
// Links written before path URLs used `#/p/{project}/…`; they are still stored in documents, deliveries and
// messages. appPath() turns either form into a path, the app redirects such hashes on load and on hashchange,
// and in-app link clicks become history navigation so the page (and its in-memory login) is never reloaded.
import { createBrowserHistory, createMemoryHistory, type RouterHistory } from "@tanstack/react-router";

export { appPath, isAppPath } from "./appPath";
import { appPath, isAppPath } from "./appPath";

let history: RouterHistory | undefined;
let quiet = 0;

/** The one history the router and every page share. Tests without a window get an in-memory one. */
export function appHistory(): RouterHistory {
  history ??= typeof window === "undefined" ? createMemoryHistory({ initialEntries: ["/"] }) : createBrowserHistory();
  return history;
}

/** Current in-app location as `pathname + search` (what route parsers read). */
export function currentPath(): string {
  const { pathname, search } = appHistory().location;
  return `${pathname}${search}`;
}

/** Open an in-app address; old `#/p/…` links are accepted. Returns false when already there. */
export function navigate(href: string, options: { replace?: boolean } = {}): boolean {
  const path = appPath(href) ?? href;
  if (path === currentPath()) return false;
  if (options.replace) appHistory().replace(path);
  else appHistory().push(path);
  return true;
}

/** Rewrite the address bar for view state already on screen (filters, open item) without telling pages. */
export function replaceQuietly(href: string): void {
  const path = appPath(href) ?? href;
  if (path === currentPath()) return;
  quiet += 1;
  try { appHistory().replace(path, appHistory().location.state, { ignoreBlocker: true }); }
  finally { quiet -= 1; }
}

/** Called after every navigation a page did not make quietly (links, back/forward, redirects). */
export function onNavigate(listener: () => void): () => void {
  return appHistory().subscribe(() => { if (!quiet) listener(); });
}

/** A `#/…` address (old link, pasted URL, browser-read) becomes the matching path. */
export function redirectLegacyHash(): boolean {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#/")) return false;
  const path = appPath(window.location.hash);
  if (!path) return false;
  appHistory().replace(path, undefined, { ignoreBlocker: true });
  return true;
}

/** In-app link clicks navigate without reloading; modified clicks, new tabs, downloads and other origins are left alone. */
export function installLinkNavigation(target: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const raw = anchor.getAttribute("href") ?? "";
    let path = raw.startsWith("#/") ? appPath(raw) : null;
    if (!path && !raw.startsWith("#")) {
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin && isAppPath(url.pathname)) path = `${url.pathname}${url.search}${url.hash}`;
    }
    if (!path) return;
    event.preventDefault();
    navigate(path);
  };
  const onHashChange = () => { redirectLegacyHash(); };
  target.addEventListener("click", onClick);
  window.addEventListener("hashchange", onHashChange);
  return () => { target.removeEventListener("click", onClick); window.removeEventListener("hashchange", onHashChange); };
}

/** A location object for helpers written against `{ path }`: reading gives the current path, assigning navigates. */
export const appLocation = {
  get path(): string { return currentPath(); },
  set path(value: string) { navigate(value); },
};
