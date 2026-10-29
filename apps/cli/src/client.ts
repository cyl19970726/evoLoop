export interface ApiClientOptions {
  apiUrl: string;
  token: string;
  timeoutMs?: number;
  /** An injected transport keeps failure and lost-response tests deterministic. */
  fetch?: typeof globalThis.fetch;
}

/** Transport outcome, not a business-command result. An unconfirmed write must never be replayed blindly. */
export class CliApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly data: unknown,
    public readonly unconfirmed: boolean,
  ) {
    super(`${code}${status ? ` (HTTP ${status})` : ""}${unconfirmed ? ": outcome unconfirmed" : ""}`);
    this.name = "CliApiError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function responseCode(data: unknown, status: number): string {
  const code = record(data)?.code;
  return typeof code === "string" && code.length > 0 ? code : `HTTP_${status}`;
}

export class ApiClient {
  private readonly base: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    let base: URL;
    try { base = new URL(options.apiUrl); }
    catch { throw new Error("EVOLOOP_API_URL must be an absolute HTTP(S) origin"); }
    if ((base.protocol !== "http:" && base.protocol !== "https:") || !base.hostname ||
      base.username || base.password || base.search || base.hash || base.pathname !== "/")
      throw new Error("EVOLOOP_API_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
    if (typeof options.token !== "string" || !options.token) throw new Error("EVOLOOP_TOKEN is required for API requests");
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    this.base = base;
    this.token = options.token;
    this.timeoutMs = timeoutMs;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get(path: string): Promise<unknown> { return this.request("GET", path); }
  post(path: string, body: unknown): Promise<unknown> { return this.request("POST", path, body); }
  put(path: string, body: unknown): Promise<unknown> { return this.request("PUT", path, body); }

  private endpoint(path: string): URL {
    if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("#") || path.startsWith("//"))
      throw new CliApiError(0, "INVALID_API_PATH", null, false);
    let url: URL;
    try { url = new URL(path, this.base); }
    catch { throw new CliApiError(0, "INVALID_API_PATH", null, false); }
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/api/") || url.username || url.password || url.hash)
      throw new CliApiError(0, "INVALID_API_PATH", null, false);
    return url;
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    const url = this.endpoint(path); // Reject cross-origin input before a token can be sent.
    let serialized: string | undefined;
    if (method !== "GET") {
      try { serialized = JSON.stringify(body); }
      catch { throw new CliApiError(0, "INVALID_REQUEST_BODY", null, false); }
      if (serialized === undefined) throw new CliApiError(0, "INVALID_REQUEST_BODY", null, false);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CliApiError(0, "TIMEOUT", null, method !== "GET"));
      }, this.timeoutMs);
    });
    try {
      const init: RequestInit = { method, redirect: "manual", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) } };
      if (method !== "GET") init.body = serialized!;
      const response = await Promise.race([
        this.fetchFn(url, init),
        deadline,
      ]);
      // An injected transport may ignore redirect:manual. Never accept a followed or foreign response.
      if (response.redirected || (response.url && new URL(response.url).origin !== this.base.origin))
        throw new CliApiError(response.status, "REDIRECT_BLOCKED", null, method !== "GET");
      if (response.status >= 300 && response.status < 400 || response.type === "opaqueredirect")
        throw new CliApiError(response.status, "REDIRECT_BLOCKED", null, method !== "GET");

      let data: unknown;
      try {
        const raw = await Promise.race([response.text(), deadline]);
        data = JSON.parse(raw);
      } catch (error) {
        if (error instanceof CliApiError) throw error;
        if (response.ok) throw new CliApiError(response.status, "INVALID_RESPONSE", null, method !== "GET");
        throw new CliApiError(response.status, `HTTP_${response.status}`, null,
          method !== "GET" && (response.status === 0 || response.status >= 500));
      }
      if (!response.ok) throw new CliApiError(response.status, responseCode(data, response.status), data,
        method !== "GET" && (response.status === 0 || response.status >= 500 || response.status < 400));
      return data;
    } catch (error) {
      if (error instanceof CliApiError) throw error;
      throw new CliApiError(0, "TRANSPORT_UNKNOWN", null, method !== "GET");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
