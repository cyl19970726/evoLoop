// Pure address helpers, kept apart from the history so renderers and tests can use them without a browser.

/** True for a path the workbench renders itself (never /api or static assets). */
export function isAppPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0] ?? "";
  return pathname === "/" || pathname === "/ui" || /^\/p\/[^/?#]+(?:\/|$)/.test(pathname);
}

/** `#/p/…` (the stored form of older links) or `/p/…` → `/p/…`; anything else (external, /api, `#anchor`) → null. */
export function appPath(href: string): string | null {
  const path = href.startsWith("#/") ? href.slice(1) : href;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return isAppPath(path) ? path : null;
}
