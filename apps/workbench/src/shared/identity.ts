// Who is signed in and how a request proves it. Against a local coordinator the reader types an access token,
// kept only in this page's memory. Behind the Hub (#219) the browser carries the Hub's session cookie and the
// page never holds a credential. Requests read the identity from here, so pages do not pass tokens around.
export type AuthMode = "token" | "hub";

/** The Hub serves the workbench with <meta name="evoloop-auth" content="hub">; otherwise it is a local coordinator. */
export function authMode(doc: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document): AuthMode {
  return doc?.querySelector('meta[name="evoloop-auth"]')?.getAttribute("content") === "hub" ? "hub" : "token";
}

let token = "";
let csrf = "";
const unauthorized = new Set<() => void>();

/** After a verified login: later requests carry this token. */
export function signIn(value: string): void { token = value; }
/** Logout or a lost session: no request carries the old token again. */
export function signOut(): void { token = ""; csrf = ""; }
/** Behind the Hub: the CSRF token the Hub gave with the login or the session read. In memory only, never in a URL, storage or cookie the page can read. */
export function setCsrfToken(value: string): void { csrf = value; }
export function signedInToken(): string { return token; }

/** Authentication for one request. A token given explicitly (the login check) wins; cookies go same-origin only. */
export function requestAuth(explicit?: string, method = "GET"): { headers: Record<string, string>; credentials: RequestCredentials } {
  const value = explicit || token;
  const headers: Record<string, string> = value ? { Authorization: `Bearer ${value}` } : {};
  // A write with the Hub's cookie also carries its CSRF token (the Hub checks the Origin too).
  if (!value && csrf && !["GET", "HEAD"].includes(method.toUpperCase())) headers["X-Hub-CSRF"] = csrf;
  return { headers, credentials: "same-origin" };
}

/** What the Hub says one project lets this caller do. Without it (a local coordinator) the identity's own permissions stand. */
export function scopedPrincipal<T extends { permissions: readonly string[] }>(principal: T & { projectPermissions?: Record<string, string[]> }, projectId: string | null): T {
  const scoped = projectId ? principal.projectPermissions?.[projectId] : undefined;
  return scoped ? { ...principal, permissions: scoped } as T : principal;
}

/** The app signs out when any request answers 401: the token or cookie is no longer accepted. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorized.add(listener);
  return () => { unauthorized.delete(listener); };
}
export function reportUnauthorized(): void {
  for (const listener of [...unauthorized]) listener();
}
