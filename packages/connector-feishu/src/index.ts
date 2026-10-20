import { createHash } from "node:crypto";
import type { CollaborationBinding, CollaborationConnector, ExternalActorEvidence, IncomingChangeCandidate, ProjectionIntent, ProjectionObservation, RemotePage, RemoteTaskRecord } from "@evoloop/contracts/collaboration";

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export interface FeishuFields {
  entityId: string;
  localVersion: string;
  operationId: string;
  title: string;
  status: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
  fields: FeishuFields;
  apiBaseUrl?: string;
  authUrl?: string;
  timeoutMs?: number;
  maxScanPages?: number;
  fetchImpl?: typeof fetch;
}

export class FeishuConnectorError extends Error {
  constructor(public readonly kind: "configuration" | "rejected" | "unknown" | "rate-limited" | "invalid-response", message: string, public readonly retryAfterSeconds: number | null = null) {
    super(message); this.name = "FeishuConnectorError";
  }
}

/** Bitable task projection. No TaskStore writes, no direct acceptance of remote edits. */
export class FeishuBitableConnector implements CollaborationConnector {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly api: string;
  private readonly auth: string;
  private readonly timeout: number;
  private readonly maxPages: number;
  private readonly http: typeof fetch;

  constructor(private readonly config: FeishuConfig) {
    if (![config.appId, config.appSecret, config.appToken, config.tableId, ...Object.values(config.fields)].every(nonempty)) throw new FeishuConnectorError("configuration", "Feishu app credentials, Base IDs, and column mapping are required");
    if (new Set(Object.values(config.fields)).size !== 5) throw new FeishuConnectorError("configuration", "Feishu columns must be distinct");
    this.api = config.apiBaseUrl ?? "https://open.feishu.cn";
    this.auth = config.authUrl ?? "https://accounts.feishu.cn/oauth/v3/token";
    this.timeout = config.timeoutMs ?? 10_000;
    this.maxPages = config.maxScanPages ?? 20;
    this.http = config.fetchImpl ?? fetch;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0 || !Number.isSafeInteger(this.maxPages) || this.maxPages <= 0) throw new FeishuConnectorError("configuration", "invalid timeout or scan bound");
  }

  private basePath(): string { return `/open-apis/bitable/v1/apps/${encodeURIComponent(this.config.appToken)}/tables/${encodeURIComponent(this.config.tableId)}/records`; }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const basic = Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.http(this.auth, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(this.timeout) });
    } catch { throw new FeishuConnectorError("unknown", "Feishu token request outcome unknown"); }
    if (!response.ok) throw new FeishuConnectorError("rejected", `Feishu token HTTP ${response.status}`);
    let body: Record<string, unknown> | null;
    try { body = object(await response.json()); } catch { body = null; }
    if (!body || body.code !== 0 || !nonempty(body.access_token) || !Number.isFinite(body.expires_in)) throw new FeishuConnectorError("invalid-response", "Feishu token response invalid");
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, Number(body.expires_in) - 60) * 1000;
    return this.token;
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, refresh = true): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.http(new URL(path, this.api), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(this.timeout) });
    } catch { throw new FeishuConnectorError("unknown", "Feishu request outcome unknown"); }
    if (response.status === 401) {
      this.token = null;
      if (method === "GET" && refresh) { await this.accessToken(true); return this.request(method, path, payload, false); }
      throw new FeishuConnectorError("rejected", "Feishu rejected expired or invalid token");
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"));
      throw new FeishuConnectorError("rate-limited", "Feishu rate limit", Number.isFinite(retry) && retry >= 0 ? retry : null);
    }
    if (response.status >= 500) throw new FeishuConnectorError("unknown", `Feishu HTTP ${response.status}; effect unknown`);
    if (!response.ok) throw new FeishuConnectorError("rejected", `Feishu HTTP ${response.status}`);
    let body: Record<string, unknown> | null;
    try { body = object(await response.json()); } catch { body = null; }
    if (!body || !Number.isSafeInteger(body.code)) throw new FeishuConnectorError("invalid-response", "Feishu response invalid; effect unknown");
    if (body.code !== 0) throw new FeishuConnectorError("rejected", `Feishu rejected request (code ${body.code})`);
    const data = object(body.data);
    if (!data) throw new FeishuConnectorError("invalid-response", "Feishu response has no data; effect unknown");
    return data;
  }

  private mapRecord(raw: unknown): RemoteTaskRecord {
    const record = object(raw);
    const fields = object(record?.fields);
    if (!record || !fields || !nonempty(record.record_id)) throw new FeishuConnectorError("invalid-response", "invalid Bitable record");
    const map = this.config.fields;
    return { recordId: record.record_id, entityId: string(fields[map.entityId]), localVersion: integer(fields[map.localVersion]), operationId: string(fields[map.operationId]), title: string(fields[map.title]), status: string(fields[map.status]), modifiedTime: record.last_modified_time === undefined ? null : String(record.last_modified_time) };
  }

  async listRemote(cursor?: string): Promise<RemotePage> {
    const query = new URLSearchParams({ page_size: "100", ...(cursor ? { page_token: cursor } : {}) });
    const data = await this.request("GET", `${this.basePath()}?${query}`);
    if (!Array.isArray(data.items)) throw new FeishuConnectorError("invalid-response", "invalid Bitable page");
    if (data.has_more === true && !nonempty(data.page_token)) throw new FeishuConnectorError("invalid-response", "Bitable page has no continuation cursor");
    return { records: data.items.map(item => this.mapRecord(item)), nextCursor: data.has_more === true && nonempty(data.page_token) ? data.page_token : null };
  }

  private async findByEntity(entityId: string): Promise<RemoteTaskRecord[]> {
    const matches: RemoteTaskRecord[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber++) {
      const page = await this.listRemote(cursor);
      matches.push(...page.records.filter(record => record.entityId === entityId));
      if (!page.nextCursor) return matches;
      if (seen.has(page.nextCursor)) throw new FeishuConnectorError("invalid-response", "Bitable pagination cursor repeated");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new FeishuConnectorError("unknown", "Bitable scan bound reached; uniqueness unresolved");
  }

  private async getRecord(recordId: string): Promise<RemoteTaskRecord | null> {
    try {
      const data = await this.request("GET", `${this.basePath()}/${encodeURIComponent(recordId)}`);
      return this.mapRecord(data.record);
    } catch (error) {
      if (error instanceof FeishuConnectorError && error.kind === "rejected" && error.message === "Feishu HTTP 404") return null;
      throw error;
    }
  }

  private result(intent: ProjectionIntent, remote: RemoteTaskRecord): ProjectionObservation {
    if (remote.entityId !== intent.entityId) return { state: "conflict", reason: "remote identity mismatch", remoteRecordId: remote.recordId };
    if (remote.localVersion !== intent.localVersion || remote.operationId !== intent.operationId || remote.title !== intent.title || remote.status !== intent.status) return { state: "conflict", reason: "remote content differs from projection intent", remoteRecordId: remote.recordId };
    return { state: "confirmed", binding: { entityId: intent.entityId, remoteRecordId: remote.recordId, localVersion: intent.localVersion, remoteVersion: intent.localVersion, remoteOperationId: intent.operationId, remoteModifiedTime: remote.modifiedTime, confirmedTitle: intent.title, confirmedStatus: intent.status } };
  }

  private safeError(error: unknown): ProjectionObservation {
    if (error instanceof FeishuConnectorError) {
      if (error.kind === "rate-limited") return { state: "rate-limited", retryAfterSeconds: error.retryAfterSeconds };
      return { state: "unknown", reason: error.message };
    }
    return { state: "unknown", reason: "unexpected connector failure" };
  }

  async reconcile(intent: ProjectionIntent, binding: CollaborationBinding | null): Promise<ProjectionObservation> {
    try {
      if (binding && binding.entityId !== intent.entityId) return { state: "conflict", reason: "binding identity mismatch" };
      const matches = await this.findByEntity(intent.entityId);
      if (matches.length > 1) return { state: "conflict", reason: "duplicate remote entity keys" };
      const found = matches[0];
      if (!found) return { state: "unknown", reason: "remote record not found; absence does not prove create was not accepted" };
      if (binding && binding.remoteRecordId !== found.recordId) return { state: "conflict", reason: "binding points to another remote record", remoteRecordId: found.recordId };
      return this.result(intent, found);
    } catch (error) { return this.safeError(error); }
  }

  async project(intent: ProjectionIntent, binding: CollaborationBinding | null): Promise<ProjectionObservation> {
    if (!nonempty(intent.entityId) || !nonempty(intent.operationId) || !Number.isSafeInteger(intent.localVersion) || intent.localVersion < 1 || !nonempty(intent.title) || !nonempty(intent.status)) return { state: "conflict", reason: "invalid projection intent" };
    if (binding && (binding.entityId !== intent.entityId || intent.localVersion < binding.localVersion)) return { state: "conflict", reason: "stale or mismatched binding" };
    if (binding) {
      try {
        const current = await this.getRecord(binding.remoteRecordId);
        if (!current) return { state: "conflict", reason: "bound remote record missing", remoteRecordId: binding.remoteRecordId };
        if (current.entityId !== binding.entityId) return { state: "conflict", reason: "bound remote identity changed", remoteRecordId: current.recordId };
        if (current.localVersion === intent.localVersion && current.operationId === intent.operationId) return this.result(intent, current);
        if (intent.deliveryState === "unknown") return { state: "unknown", reason: "prior update outcome unresolved; no automatic replay" };
        if (intent.localVersion <= binding.localVersion) return { state: "conflict", reason: "local version did not advance" };
        if (current.localVersion !== binding.localVersion || current.operationId !== binding.remoteOperationId || current.title !== binding.confirmedTitle || current.status !== binding.confirmedStatus || current.modifiedTime !== binding.remoteModifiedTime) return { state: "conflict", reason: "remote changed since confirmed baseline", remoteRecordId: current.recordId };
        const map = this.config.fields;
        const fields = { [map.localVersion]: intent.localVersion, [map.operationId]: intent.operationId, [map.title]: intent.title, [map.status]: intent.status };
        await this.request("PUT", `${this.basePath()}/${encodeURIComponent(binding.remoteRecordId)}`, { fields });
        const readback = await this.getRecord(binding.remoteRecordId);
        return readback ? this.result(intent, readback) : { state: "unknown", reason: "update acknowledged but readback missing" };
      } catch (error) { return this.safeError(error); }
    }
    const before = await this.reconcile(intent, null);
    if (before.state === "confirmed" || before.state === "conflict" || before.state === "rate-limited") return before;
    if (intent.deliveryState === "unknown") return before;
    if (before.reason !== "remote record not found; absence does not prove create was not accepted") return before;
    const map = this.config.fields;
    const fields = { [map.entityId]: intent.entityId, [map.localVersion]: intent.localVersion, [map.operationId]: intent.operationId, [map.title]: intent.title, [map.status]: intent.status };
    // UUIDv4 shape required by Bitable client_token. Stable operation ID is still searched after lost responses.
    const hash = createHash("sha256").update(intent.operationId).digest("hex");
    const clientToken = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    try {
      const data = await this.request("POST", `${this.basePath()}?client_token=${clientToken}`, { fields });
      const record = this.mapRecord(data.record);
      // Readback is required; create response alone does not confirm the projection.
      const readback = await this.getRecord(record.recordId);
      return readback ? this.result(intent, readback) : { state: "unknown", reason: "create acknowledged but readback missing" };
    } catch (error) { return this.safeError(error); }
  }

  incoming(record: RemoteTaskRecord, binding: CollaborationBinding, actor: ExternalActorEvidence | null): IncomingChangeCandidate {
    const same = record.operationId === binding.remoteOperationId && record.title === binding.confirmedTitle && record.status === binding.confirmedStatus;
    const patch: IncomingChangeCandidate["patch"] = {};
    if (record.title !== null && record.title !== binding.confirmedTitle) patch.title = record.title;
    if (record.status !== null && record.status !== binding.confirmedStatus) patch.status = record.status;
    const reliableActor = actor?.verified === true && nonempty(actor.platformUserId) && nonempty(actor.projectActorId) && nonempty(actor.sourceEventId);
    const baselineValid = record.entityId === binding.entityId && record.localVersion === binding.localVersion && record.recordId === binding.remoteRecordId;
    const noPatch = Object.keys(patch).length === 0;
    return { entityId: binding.entityId, remoteRecordId: record.recordId, observedLocalVersion: binding.localVersion, observedRemoteOperationId: record.operationId ?? "", observedRemoteModifiedTime: record.modifiedTime, actor, patch, reviewOnly: same || noPatch || !reliableActor || !baselineValid, reason: same || noPatch ? "self projection or no supported change" : !baselineValid ? "remote identity or local baseline differs" : !reliableActor ? "external actor not verified" : null };
  }
}
