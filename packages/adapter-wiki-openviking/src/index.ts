import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type {
  CandidateDecision, CandidateStatus, KnowledgeCandidate, KnowledgeCandidateRecord, KnowledgeCandidateSummary, KnowledgeCapabilities, KnowledgeGraph, KnowledgePage, KnowledgeRelation,
  KnowledgeRepository, KnowledgeRevision, KnowledgeSummary, PublishResult, KnowledgeIngestRequest, KnowledgeIngestion, KnowledgeQuery, KnowledgeQueryResult, KnowledgeQueryHit,
} from "@evoloop/contracts/knowledge";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxBody = 1024 * 1024;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
type Metadata = Omit<KnowledgeRevision, "body" | "observedValidity"> & { uri: string };
type CandidateMetadata = Omit<KnowledgeCandidate, "body"> & { uri: string; decision?: CandidateDecision };
interface Operation { candidateId: string; status: "unknown" | "published" | "conflict"; revision?: string; currentRevision?: string | null }
interface IngestRecord { fingerprint: string; ingestion: KnowledgeIngestion; uri: string }
interface State {
  formatVersion: 1; generation: number; heads: Record<string, string>; revisions: Record<string, Metadata>;
  candidates: Record<string, CandidateMetadata>; operations: Record<string, Operation>;
  validityOverrides: Record<string, "needs_review" | "withdrawn">; withdrawnSources: string[];
  ingestions?: Record<string, IngestRecord>;
}
const fresh = (): State => ({ formatVersion: 1, generation: 0, heads: {}, revisions: {}, candidates: {}, operations: {}, validityOverrides: {}, withdrawnSources: [], ingestions: {} });
const key = (id: string, revision: string): string => `${id}\0${revision}`;
const validId = (value: string): void => { if (!idPattern.test(value)) throw new Error("invalid knowledge identifier"); };
const pageLimit = (value: number, max = 100): void => { if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`limit must be 1..${max}`); };

export interface OpenVikingOptions {
  baseUrl: string;
  manifestRoot: string;
  maintainerId: string;
  mayRead: (projectId: string, knowledgeId: string) => Promise<boolean>;
  mayPropose: (candidate: KnowledgeCandidate) => Promise<boolean>;
  mayReview: (projectId: string, reviewerId: string) => Promise<boolean>;
  mayPublish: (projectId: string, actorId: string) => Promise<boolean>;
  mayReconcile: (projectId: string, actorId: string) => Promise<boolean>;
  mayIngest?: (projectId: string, actorId: string) => Promise<boolean>;
  /** Observing an existing task is separate from authority to start an ingestion. */
  mayObserveIngestion?: (projectId: string) => Promise<boolean>;
}

/** OpenViking holds every candidate and published body; an external manifest owns immutable identities and relations. */
export class OpenVikingKnowledgeRepository implements KnowledgeRepository {
  private readonly base: URL;
  constructor(private readonly options: OpenVikingOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/") {
      throw new Error("OpenViking pilot requires a credential-free loopback HTTP endpoint");
    }
    if (!isAbsolute(options.manifestRoot) || options.manifestRoot === process.cwd() || options.manifestRoot.startsWith(process.cwd() + sep)) {
      throw new Error("Wiki manifest root must be outside the development checkout");
    }
    validId(options.maintainerId);
    this.base = url;
  }
  private async root(): Promise<string> {
    await mkdir(this.options.manifestRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.options.manifestRoot)).isSymbolicLink()) throw new Error("Wiki manifest root cannot be a symlink");
    const actual = await realpath(this.options.manifestRoot);
    const checkout = await realpath(process.cwd());
    if (actual === checkout || actual.startsWith(checkout + sep)) throw new Error("Wiki manifest root resolves inside the development checkout");
    return this.options.manifestRoot;
  }
  private async load(projectId: string): Promise<State> {
    validId(projectId);
    const path = join(await this.root(), `${projectId}.json`);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string;
      try {
        if ((await handle.stat()).size > maxBody * 4) throw new Error("Wiki manifest exceeds limit");
        raw = await handle.readFile({ encoding: "utf8" });
      } finally { await handle.close(); }
      const state = JSON.parse(raw) as State;
      if (state.formatVersion !== 1 || !state.heads || !state.revisions || !state.operations) throw new Error("invalid Wiki manifest");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fresh();
      throw error;
    }
  }
  private async save(projectId: string, state: State): Promise<void> {
    const root = await this.root();
    const temporary = join(root, `${projectId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(root, `${projectId}.json`));
    const dir = await open(root, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async locked<T>(projectId: string, action: (state: State) => Promise<T>): Promise<T> {
    validId(projectId);
    const lock = join(await this.root(), `${projectId}.lock`);
    const handle = await open(lock, "wx", 0o600); // A crash leaves a visible lock requiring operator reconciliation.
    try { return await action(await this.load(projectId)); }
    finally { await handle.close(); await unlink(lock); }
  }
  private uri(projectId: string, knowledgeId: string, kind: "candidates" | "revisions", id: string): string {
    [projectId, knowledgeId, id].forEach(validId);
    return `viking://resources/evoloop/${projectId}/knowledge/${knowledgeId}/${kind}/${id}.md`;
  }
  private async request(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), {
      method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenViking HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OpenViking response body missing");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBody * 2) { await reader.cancel(); throw new Error("OpenViking response exceeds limit"); }
      chunks.push(part.value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: string; result?: unknown };
    if (parsed.status !== "ok") throw new Error("OpenViking returned an unsuccessful response");
    return parsed.result;
  }
  private async upload(body: string): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([body], { type: "text/markdown" }), "source.md");
    const response = await fetch(new URL("/api/v1/resources/temp_upload", this.base), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body: form,
    });
    if (!response.ok) throw new Error(`OpenViking HTTP ${response.status}`);
    const payload = await response.json() as { status?: string; result?: { temp_file_id?: unknown } };
    if (payload.status !== "ok" || typeof payload.result?.temp_file_id !== "string" || !payload.result.temp_file_id || payload.result.temp_file_id.length > 256) throw new Error("invalid OpenViking upload response");
    return payload.result.temp_file_id;
  }
  private ingestUri(projectId: string, source: KnowledgeIngestRequest["source"], bodyHash: string): string {
    const digest = sha(JSON.stringify([source.sourceKey, source.originRevision, source.contentHash, bodyHash]));
    return `viking://resources/evoloop/${projectId}/sources/${digest}`;
  }
  private async ingestAllowed(input: KnowledgeIngestRequest): Promise<void> {
    if (!this.options.mayIngest || !(await this.options.mayIngest(input.projectId, input.actorId))) throw new Error("source ingestion denied");
  }
  async ingestSource(input: KnowledgeIngestRequest): Promise<KnowledgeIngestion> {
    const { projectId, operationId, actorId, source, title, body } = input;
    [projectId, operationId, actorId].forEach(validId);
    if (!source.sourceKey || source.sourceKey.length > 400 || !source.originRevision || source.originRevision.length > 128 ||
      !hashPattern.test(source.contentHash) || sha(body) !== source.contentHash || source.state !== "reachable" || !title || title.length > 240 ||
      !body || Buffer.byteLength(body) > maxBody) throw new Error("source ingestion input invalid");
    await this.ingestAllowed(input);
    return this.locked(projectId, async (state) => {
      const fingerprint = sha(JSON.stringify([actorId, source.sourceKey, source.originRevision, source.contentHash, title, sha(body)]));
      const existing = state.ingestions?.[operationId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("ingestion operation ID conflict");
        return existing.ingestion;
      }
      if (state.operations[operationId] || Object.values(state.candidates).some((item) => item.operationId === operationId)) throw new Error("operation ID reused");
      if (state.withdrawnSources.includes(source.sourceKey)) throw new Error("source withdrawn");
      const uri = this.ingestUri(projectId, source, sha(body));
      if (Object.values(state.ingestions ?? {}).some((item) => item.ingestion.source.sourceKey === source.sourceKey &&
        item.ingestion.source.originRevision === source.originRevision && item.ingestion.source.contentHash === source.contentHash)) {
        throw new Error("source revision already submitted");
      }
      const ingestion: KnowledgeIngestion = { operationId, actorId, source, title, status: "unknown", taskId: null, indexStatus: "unverified" };
      state.ingestions ??= {};
      state.ingestions[operationId] = { fingerprint, ingestion, uri };
      state.generation++; await this.save(projectId, state); // Intent must survive an uncertain upload/add response.
      try {
        await this.ingestAllowed(input);
        const temp_file_id = await this.upload(body);
        await this.ingestAllowed(input);
        const result = await this.request("POST", "/api/v1/resources", {
          temp_file_id, to: uri, create_parent: true, source_name: "source.md", reason: "evoLoop fixed source revision", wait: false, strict: true,
        }) as { status?: unknown; task_id?: unknown; root_uri?: unknown } | null;
        if (!result || result.status !== "success" || typeof result.task_id !== "string" || !result.task_id || result.task_id.length > 256) throw new Error("invalid OpenViking resource response");
        if (result.root_uri !== undefined && (typeof result.root_uri !== "string" ||
          (result.root_uri !== uri && !result.root_uri.startsWith(uri + "/")))) throw new Error("OpenViking resource target changed");
        if (typeof result.root_uri === "string") state.ingestions[operationId]!.uri = result.root_uri;
        ingestion.status = "submitted"; ingestion.taskId = result.task_id;
        state.generation++; await this.save(projectId, state);
      } catch { /* Unknown side effect: never replay this operation or resource target. */ }
      return ingestion;
    });
  }
  async getIngestion(projectId: string, operationId: string): Promise<KnowledgeIngestion | null> {
    [projectId, operationId].forEach(validId);
    return this.locked(projectId, async (state) => {
      const record = state.ingestions?.[operationId];
      if (!record) return null;
      if (!(await this.options.mayRead(projectId, record.ingestion.source.sourceKey))) throw new Error("source status permission denied");
      if (!record.ingestion.taskId || record.ingestion.status === "completed" || record.ingestion.status === "failed") return record.ingestion;
      // A lost writer lease may still read the saved status, but cannot advance the durable record.
      if (!await this.options.mayObserveIngestion?.(projectId)) return record.ingestion;
      try {
        const task = await this.request("GET", `/api/v1/tasks/${encodeURIComponent(record.ingestion.taskId)}`) as { status?: unknown; task_id?: unknown } | null;
        if (!task || task.task_id !== record.ingestion.taskId) return record.ingestion;
        if (!await this.options.mayObserveIngestion?.(projectId)) return record.ingestion;
        if (task.status === "completed") record.ingestion.status = "completed";
        else if (task.status === "failed" || task.status === "cancelled") record.ingestion.status = "failed";
        else if (task.status !== "pending" && task.status !== "running" && task.status !== "cancelling") return record.ingestion;
        if (record.ingestion.status !== "submitted") { state.generation++; await this.save(projectId, state); }
      } catch { /* Expired or unreachable tasks leave the last known state. */ }
      return record.ingestion;
    });
  }
  async query(projectId: string, input: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    validId(projectId); pageLimit(input.limit, 20);
    if (!input.query.trim() || input.query.length > 2000 || !["published", "sources"].includes(input.scope)) throw new Error("invalid knowledge query");
    const state = await this.load(projectId);
    const targets = new Map<string, KnowledgeQueryHit>();
    let excluded = 0;
    if (input.scope === "published") {
      for (const [id, revision] of Object.entries(state.heads)) {
        const meta = state.revisions[key(id, revision)];
        if (!meta || !(await this.options.mayRead(projectId, id)) || this.observedValidity(state, meta) !== "valid") { excluded++; continue; }
        targets.set(meta.uri, { kind: "wiki", id, revision, contentHash: meta.contentHash, title: meta.title, score: 0 });
      }
    } else {
      for (const record of Object.values(state.ingestions ?? {})) {
        const source = record.ingestion.source;
        if (record.ingestion.status !== "completed" || state.withdrawnSources.includes(source.sourceKey) ||
          !(await this.options.mayRead(projectId, source.sourceKey))) { excluded++; continue; }
        const match = /^document:([0-9a-fA-F-]{36})$/.exec(source.sourceKey);
        if (!match) { excluded++; continue; }
        targets.set(record.uri, { kind: "document", id: match[1]!, revision: source.originRevision,
          contentHash: source.contentHash, title: record.ingestion.title, score: 0 });
      }
    }
    const entries = [...targets.entries()].slice(0, 100);
    excluded += Math.max(0, targets.size - entries.length);
    if (!entries.length) return { items: [], scope: input.scope, coverage: "bounded", indexStatus: "unverified", excluded };
    const result = await this.request("POST", "/api/v1/search/find", {
      query: input.query, target_uri: entries.map(([uri]) => uri), limit: input.limit, read_content: false,
    }) as { resources?: unknown } | null;
    if (!result || !Array.isArray(result.resources)) throw new Error("invalid OpenViking search response");
    const allowed = new Map(entries);
    const items: KnowledgeQueryHit[] = [];
    const seen = new Set<string>();
    for (const raw of result.resources) {
      if (!raw || typeof raw !== "object") { excluded++; continue; }
      const hit = raw as { uri?: unknown; score?: unknown };
      if (typeof hit.uri !== "string" || typeof hit.score !== "number" || !Number.isFinite(hit.score)) { excluded++; continue; }
      const hitUri = hit.uri;
      const entry = [...allowed.entries()].find(([uri]) => hitUri === uri || (input.scope === "sources" && hitUri.startsWith(uri + "/")));
      if (!entry) { excluded++; continue; }
      const citationKey = `${entry[1].kind}\0${entry[1].id}\0${entry[1].revision}`;
      if (seen.has(citationKey)) { excluded++; continue; }
      seen.add(citationKey);
      items.push({ ...entry[1], score: hit.score });
      if (items.length >= input.limit) break;
    }
    return { items, scope: input.scope, coverage: "bounded", indexStatus: "unverified", excluded };
  }
  async capabilities(): Promise<KnowledgeCapabilities> {
    try {
      const response = await fetch(new URL("/health", this.base), { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("health unavailable");
      const health = await response.json() as { status?: string; healthy?: boolean; version?: string };
      if (health.status !== "ok" || health.healthy !== true) throw new Error("health unavailable");
      return { backendVersion: health.version ?? null, backendReachable: true, fixedRevisionRead: "adapter_verified",
        conditionalPublish: "single_maintainer_adapter", boundedRelations: "adapter_verified", migration: "unsupported", semanticIndex: "unverified" };
    } catch {
      return { backendVersion: null, backendReachable: false, fixedRevisionRead: "unavailable",
        conditionalPublish: "unavailable", boundedRelations: "unavailable", migration: "unsupported", semanticIndex: "unverified" };
    }
  }
  private async readBody(uri: string): Promise<string | null> {
    const result = await this.request("GET", `/api/v1/content/read?uri=${encodeURIComponent(uri)}&raw=true`);
    if (result === null) return null;
    if (typeof result !== "string" || Buffer.byteLength(result) > maxBody) throw new Error("invalid OpenViking body");
    return result;
  }
  private async createBody(uri: string, body: string): Promise<void> {
    await this.request("POST", "/api/v1/content/write", { uri, content: body, mode: "create", wait: false, processing_mode: "vectors_only" });
  }
  private async ensureBody(uri: string, body: string, contentHash: string): Promise<boolean> {
    try { await this.createBody(uri, body); } catch { /* A lost response may follow a successful create. */ }
    try { return sha((await this.readBody(uri)) ?? "") === contentHash; } catch { return false; }
  }
  private observedValidity(state: State, meta: Metadata, visiting = new Set<string>()): Metadata["validity"] {
    if (meta.validity === "withdrawn") return "withdrawn";
    if (meta.sources.some((source) => state.withdrawnSources.includes(source.sourceKey))) return "needs_review";
    const override = state.heads[meta.knowledgeId] === meta.revision ? state.validityOverrides[meta.knowledgeId] : undefined;
    if (override) return override;
    const fixed = key(meta.knowledgeId, meta.revision);
    if (visiting.has(fixed)) return meta.validity;
    visiting.add(fixed);
    try {
      for (const relation of meta.relations) {
        if (relation.type !== "supports" || relation.fromKnowledgeId !== meta.knowledgeId || relation.fromRevision !== meta.revision) continue;
        if (relation.state !== "active" || relation.sourceKeys.some((sourceKey) => state.withdrawnSources.includes(sourceKey))) return "needs_review";
        const target = state.revisions[key(relation.toKnowledgeId, relation.toRevision)];
        if (!target || this.observedValidity(state, target, visiting) !== "valid") return "needs_review";
      }
      return meta.validity;
    } finally { visiting.delete(fixed); }
  }
  private async materialize(meta: Metadata): Promise<KnowledgeRevision> {
    const body = await this.readBody(meta.uri);
    if (body === null || sha(body) !== meta.contentHash) throw new Error("fixed Wiki revision unavailable or changed");
    const state = await this.load(meta.projectId);
    return { ...meta, body, observedValidity: this.observedValidity(state, meta) };
  }
  async list(projectId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeSummary>> {
    pageLimit(limit); const state = await this.load(projectId);
    const ids = Object.keys(state.heads).sort();
    const permitted: KnowledgeSummary[] = [];
    for (const id of ids) {
      if (cursor && id <= cursor) continue;
      if (!(await this.options.mayRead(projectId, id))) continue;
      const meta = state.revisions[key(id, state.heads[id]!)];
      if (meta) permitted.push({ knowledgeId: id, revision: meta.revision, title: meta.title, pageType: meta.pageType, validity: this.observedValidity(state, meta) });
    }
    return { items: permitted.slice(0, limit), nextCursor: permitted.length > limit ? permitted[limit - 1]!.knowledgeId : null, watermark: state.generation };
  }
  async get(projectId: string, knowledgeId: string, revision?: string): Promise<KnowledgeRevision | null> {
    [projectId, knowledgeId].forEach(validId); if (revision) validId(revision);
    if (!(await this.options.mayRead(projectId, knowledgeId))) return null;
    const state = await this.load(projectId);
    const selected = revision ?? state.heads[knowledgeId];
    const meta = selected ? state.revisions[key(knowledgeId, selected)] : undefined;
    return meta ? this.materialize(meta) : null;
  }
  async history(projectId: string, knowledgeId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeSummary>> {
    pageLimit(limit); validId(knowledgeId); const state = await this.load(projectId);
    if (!(await this.options.mayRead(projectId, knowledgeId))) return { items: [], nextCursor: null, watermark: state.generation };
    const all = Object.values(state.revisions).filter((m) => m.knowledgeId === knowledgeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision.localeCompare(a.revision));
    const start = cursor ? all.findIndex((m) => m.revision === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error("history cursor expired");
    const page = all.slice(start, start + limit);
    return { items: page.map((m) => ({ knowledgeId, revision: m.revision, title: m.title, pageType: m.pageType, validity: m.validity })), nextCursor: all.length > start + limit ? page.at(-1)!.revision : null, watermark: state.generation };
  }
  async graph(projectId: string, focusKnowledgeId: string, limit: number): Promise<KnowledgeGraph> {
    pageLimit(limit, 80); validId(focusKnowledgeId);
    const state = await this.load(projectId);
    if (!(await this.options.mayRead(projectId, focusKnowledgeId))) return { nodes: [], edges: [], status: "unavailable", watermark: state.generation };
    const focusRevision = state.heads[focusKnowledgeId];
    const focus = focusRevision && state.revisions[key(focusKnowledgeId, focusRevision)];
    if (!focus) return { nodes: [], edges: [], status: "unavailable", watermark: state.generation };
    const edges: KnowledgeRelation[] = [];
    const nodes = new Map<string, KnowledgeSummary>();
    const add = (m: Metadata): void => { nodes.set(key(m.knowledgeId, m.revision), { knowledgeId: m.knowledgeId, revision: m.revision, title: m.title, pageType: m.pageType, validity: this.observedValidity(state, m) }); };
    add(focus);
    const outgoing = focus.relations;
    const incoming = Object.entries(state.heads).flatMap(([id, revision]) => state.revisions[key(id, revision)]?.relations.filter((r) => r.toKnowledgeId === focusKnowledgeId && r.toRevision === focusRevision) ?? []);
    let truncated = false;
    let partial = false;
    const seenEdges = new Set<string>();
    for (const edge of [...outgoing, ...incoming]) {
      if (seenEdges.has(edge.edgeId)) continue;
      seenEdges.add(edge.edgeId);
      const endpointIds = new Set([edge.fromKnowledgeId, edge.toKnowledgeId]);
      let permitted = true;
      for (const id of endpointIds) {
        if (id !== focusKnowledgeId && !(await this.options.mayRead(projectId, id))) { permitted = false; break; }
      }
      if (!permitted) continue;
      const from = state.revisions[key(edge.fromKnowledgeId, edge.fromRevision)];
      const to = state.revisions[key(edge.toKnowledgeId, edge.toRevision)];
      if (!from || !to) { partial = true; continue; }
      const endpointKeys = new Set([key(from.knowledgeId, from.revision), key(to.knowledgeId, to.revision)]);
      const newNodes = [...endpointKeys].filter(nodeKey => !nodes.has(nodeKey)).length;
      if (edges.length >= limit || nodes.size + newNodes > limit) { truncated = true; continue; }
      add(from);
      add(to);
      edges.push(edge.sourceKeys.some((sourceKey) => state.withdrawnSources.includes(sourceKey)) ||
        state.validityOverrides[edge.fromKnowledgeId] || state.validityOverrides[edge.toKnowledgeId]
        ? { ...edge, state: "needs_review" } : edge);
    }
    return { nodes: [...nodes.values()], edges, status: partial ? "partial" : truncated ? "truncated" : "complete", watermark: state.generation };
  }
  async sourceState(projectId: string, sourceKey: string): Promise<"reachable" | "withdrawn"> {
    validId(projectId);
    if (!sourceKey || sourceKey.length > 400) throw new Error("invalid source key");
    return (await this.load(projectId)).withdrawnSources.includes(sourceKey) ? "withdrawn" : "reachable";
  }
  private candidateStatus(state: State, item: CandidateMetadata): CandidateStatus {
    if (state.revisions[key(item.knowledgeId, item.candidateRevision)]) return "published";
    if (item.decision?.decision === "accept") return "accepted";
    if (item.decision?.decision === "reject") return "rejected";
    return "pending";
  }
  async listCandidates(projectId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeCandidateSummary>> {
    pageLimit(limit); validId(projectId); if (cursor) validId(cursor);
    const state = await this.load(projectId);
    const ids = Object.keys(state.candidates).sort();
    const permitted: KnowledgeCandidateSummary[] = [];
    for (const id of ids) {
      if (cursor && id <= cursor) continue;
      const item = state.candidates[id]!;
      if (!(await this.options.mayRead(projectId, item.knowledgeId))) continue;
      permitted.push({ candidateId: id, knowledgeId: item.knowledgeId, candidateRevision: item.candidateRevision,
        expectedRevision: item.expectedRevision, title: item.title, contentHash: item.contentHash,
        status: this.candidateStatus(state, item), decision: item.decision ?? null });
    }
    return { items: permitted.slice(0, limit), nextCursor: permitted.length > limit ? permitted[limit - 1]!.candidateId : null,
      watermark: state.generation };
  }
  async getCandidate(projectId: string, candidateId: string): Promise<KnowledgeCandidateRecord | null> {
    [projectId, candidateId].forEach(validId);
    const state = await this.load(projectId);
    const item = state.candidates[candidateId];
    if (!item || !(await this.options.mayRead(projectId, item.knowledgeId))) return null;
    const body = await this.readBody(item.uri);
    if (body === null || sha(body) !== item.contentHash) throw new Error("fixed Wiki candidate unavailable or changed");
    const { uri: _uri, decision, ...rest } = item;
    return { ...rest, body, decision: decision ?? null, status: this.candidateStatus(state, item) };
  }
  async propose(candidate: KnowledgeCandidate): Promise<KnowledgeCandidate> {
    const { projectId, knowledgeId, candidateId, candidateRevision } = candidate;
    [projectId, knowledgeId, candidateId, candidateRevision, candidate.actorId, candidate.operationId].forEach(validId);
    if (candidate.expectedRevision) validId(candidate.expectedRevision);
    if (Buffer.byteLength(candidate.body) > maxBody || !hashPattern.test(candidate.contentHash) || sha(candidate.body) !== candidate.contentHash) throw new Error("candidate body/hash invalid");
    if (!candidate.title || candidate.title.length > 240 || candidate.sources.length > 100 || candidate.relations.length > 100 ||
      candidate.sources.some((s) => !s.sourceKey || s.sourceKey.length > 400 || !hashPattern.test(s.contentHash))) throw new Error("candidate metadata invalid");
    for (const relation of candidate.relations) {
      [relation.edgeId, relation.fromKnowledgeId, relation.fromRevision, relation.toKnowledgeId, relation.toRevision].forEach(validId);
      if (relation.fromKnowledgeId !== knowledgeId || relation.fromRevision !== candidateRevision) throw new Error("relation source must be the candidate revision");
    }
    if (!(await this.options.mayPropose(candidate))) throw new Error("candidate permission denied");
    return this.locked(projectId, async (state) => {
      if (state.ingestions?.[candidate.operationId] || state.operations[candidate.operationId]) throw new Error("operation ID reused");
      const existing = state.candidates[candidateId];
      if (existing) {
        if (existing.contentHash !== candidate.contentHash || existing.operationId !== candidate.operationId ||
          existing.knowledgeId !== candidate.knowledgeId || existing.candidateRevision !== candidate.candidateRevision ||
          existing.expectedRevision !== candidate.expectedRevision || existing.title !== candidate.title ||
          existing.pageType !== candidate.pageType || existing.epistemicStatus !== candidate.epistemicStatus ||
          existing.actorId !== candidate.actorId || JSON.stringify(existing.sources) !== JSON.stringify(candidate.sources) ||
          JSON.stringify(existing.relations) !== JSON.stringify(candidate.relations)) throw new Error("candidate ID conflict");
        if (sha((await this.readBody(existing.uri)) ?? "") !== existing.contentHash) throw new Error("candidate body drift");
        return candidate;
      }
      const edgeIds = new Set<string>();
      for (const relation of candidate.relations) {
        if (edgeIds.has(relation.edgeId) || !state.revisions[key(relation.toKnowledgeId, relation.toRevision)]) throw new Error("duplicate or missing fixed relation target");
        edgeIds.add(relation.edgeId);
      }
      const uri = this.uri(projectId, knowledgeId, "candidates", candidateId);
      if (!(await this.ensureBody(uri, candidate.body, candidate.contentHash))) throw new Error("candidate write unconfirmed");
      const { body: _body, ...metadata } = candidate;
      state.candidates[candidateId] = { ...metadata, uri };
      state.generation++; await this.save(projectId, state);
      return candidate;
    });
  }
  async review(projectId: string, decision: CandidateDecision): Promise<void> {
    validId(projectId); validId(decision.reviewerId);
    if (!(await this.options.mayReview(projectId, decision.reviewerId))) throw new Error("review permission denied");
    await this.locked(projectId, async (state) => {
      const candidate = state.candidates[decision.candidateId];
      if (!candidate || candidate.candidateRevision !== decision.candidateRevision || candidate.contentHash !== decision.contentHash || candidate.expectedRevision !== decision.expectedRevision) throw new Error("review candidate mismatch");
      if (candidate.decision && JSON.stringify(candidate.decision) !== JSON.stringify(decision)) throw new Error("review decision already recorded");
      candidate.decision = decision; state.generation++; await this.save(projectId, state);
    });
  }
  private result(operationId: string, op: Operation): PublishResult {
    if (op.status === "published") return { status: "published", operationId, revision: op.revision! };
    if (op.status === "conflict") return { status: "conflict", operationId, currentRevision: op.currentRevision ?? null };
    return { status: "unknown", operationId, reason: "external write requires reconciliation" };
  }
  async publish(projectId: string, candidateId: string, operationId: string, actorId: string): Promise<PublishResult> {
    [projectId, candidateId, operationId, actorId].forEach(validId);
    return this.locked(projectId, async (state) => {
      const candidate = state.candidates[candidateId];
      if (!candidate) throw new Error("candidate missing");
      if (state.ingestions?.[operationId]) throw new Error("operation ID reused");
      const previous = state.operations[operationId];
      if (previous && previous.candidateId !== candidateId) throw new Error("operation ID reused for another candidate");
      if (actorId !== this.options.maintainerId || !(await this.options.mayPublish(projectId, actorId))) throw new Error("single maintainer publish gate denied");
      if (previous?.status === "published" || previous?.status === "conflict") return this.result(operationId, previous);
      if (previous?.status === "unknown") return { status: "unknown", operationId, reason: "reconcile the previous external write before retrying" };
      if (candidate.decision?.decision !== "accept") throw new Error("candidate lacks accepted review");
      if (candidate.sources.some((source) => source.state !== "reachable" || state.withdrawnSources.includes(source.sourceKey))) {
        throw new Error("candidate source unavailable or withdrawn");
      }
      const current = state.heads[candidate.knowledgeId] ?? null;
      if (state.revisions[key(candidate.knowledgeId, candidate.candidateRevision)]) throw new Error("knowledge revision already exists");
      if (current !== candidate.expectedRevision) {
        const op: Operation = { candidateId, status: "conflict", currentRevision: current };
        state.operations[operationId] = op; state.generation++; await this.save(projectId, state);
        return this.result(operationId, op);
      }
      const prior = current && state.revisions[key(candidate.knowledgeId, current)];
      if (prior) {
        try { const old = await this.readBody(prior.uri); if (old === null || sha(old) !== prior.contentHash) throw new Error("old revision drift"); }
        catch { return { status: "unknown", operationId, reason: "current OpenViking revision cannot be verified" }; }
      }
      const body = await this.readBody(candidate.uri);
      if (body === null || sha(body) !== candidate.contentHash) throw new Error("candidate body unavailable or changed");
      const uri = this.uri(projectId, candidate.knowledgeId, "revisions", candidate.candidateRevision);
      if (!previous) {
        state.operations[operationId] = { candidateId, status: "unknown" };
        state.generation++; await this.save(projectId, state); // Durable intent before external side effect.
      }
      if (!(await this.ensureBody(uri, body, candidate.contentHash))) return { status: "unknown", operationId, reason: "OpenViking publish unconfirmed" };
      const metadata: Metadata = {
        projectId, knowledgeId: candidate.knowledgeId, revision: candidate.candidateRevision,
        previousRevision: current, title: candidate.title, contentHash: candidate.contentHash,
        pageType: candidate.pageType, epistemicStatus: candidate.epistemicStatus, validity: "valid",
        sources: candidate.sources, relations: candidate.relations, createdAt: new Date().toISOString(), uri,
      };
      state.revisions[key(candidate.knowledgeId, metadata.revision)] = metadata;
      state.heads[candidate.knowledgeId] = metadata.revision;
      delete state.validityOverrides[candidate.knowledgeId];
      state.operations[operationId] = { candidateId, status: "published", revision: metadata.revision };
      state.generation++; await this.save(projectId, state);
      return { status: "published", operationId, revision: metadata.revision };
    });
  }
  async reconcile(projectId: string, operationId: string, actorId: string): Promise<PublishResult | null> {
    [projectId, operationId, actorId].forEach(validId);
    if (actorId !== this.options.maintainerId || !(await this.options.mayReconcile(projectId, actorId))) throw new Error("single maintainer reconcile gate denied");
    return this.locked(projectId, async (state) => {
      if (state.ingestions?.[operationId]) throw new Error("operation ID reused");
      const op = state.operations[operationId];
      if (!op) return null;
      if (op.status !== "unknown") return this.result(operationId, op);
      const candidate = state.candidates[op.candidateId];
      if (!candidate) return { status: "unknown", operationId, reason: "candidate manifest missing" };
      const current = state.heads[candidate.knowledgeId] ?? null;
      if (state.revisions[key(candidate.knowledgeId, candidate.candidateRevision)]) return { status: "unknown", operationId, reason: "revision already recorded under another operation" };
      if (current !== candidate.expectedRevision) return { status: "unknown", operationId, reason: "manifest baseline changed during external write" };
      const uri = this.uri(projectId, candidate.knowledgeId, "revisions", candidate.candidateRevision);
      let body: string | null;
      try { body = await this.readBody(uri); } catch { return { status: "unknown", operationId, reason: "OpenViking read unavailable" }; }
      if (body === null || sha(body) !== candidate.contentHash) return { status: "unknown", operationId, reason: "external revision absent or changed" };
      const metadata: Metadata = {
        projectId, knowledgeId: candidate.knowledgeId, revision: candidate.candidateRevision,
        previousRevision: current, title: candidate.title, contentHash: candidate.contentHash,
        pageType: candidate.pageType, epistemicStatus: candidate.epistemicStatus, validity: "valid",
        sources: candidate.sources, relations: candidate.relations, createdAt: new Date().toISOString(), uri,
      };
      state.revisions[key(candidate.knowledgeId, metadata.revision)] = metadata;
      state.heads[candidate.knowledgeId] = metadata.revision;
      delete state.validityOverrides[candidate.knowledgeId];
      if (candidate.sources.some((source) => state.withdrawnSources.includes(source.sourceKey))) state.validityOverrides[candidate.knowledgeId] = "needs_review";
      state.operations[operationId] = { candidateId: op.candidateId, status: "published", revision: metadata.revision };
      state.generation++; await this.save(projectId, state);
      return { status: "published", operationId, revision: metadata.revision };
    });
  }
  async retractSource(projectId: string, sourceKey: string, operationId: string, actorId: string): Promise<string[]> {
    [projectId, operationId, actorId].forEach(validId);
    if (!sourceKey || sourceKey.length > 400 || actorId !== this.options.maintainerId || !(await this.options.mayPublish(projectId, actorId))) throw new Error("source withdrawal denied");
    return this.locked(projectId, async (state) => {
      const affectedSet = new Set(Object.entries(state.heads).filter(([id, revision]) => {
        const page = state.revisions[key(id, revision)];
        return page?.sources.some((s) => s.sourceKey === sourceKey) || page?.relations.some((r) => r.sourceKeys.includes(sourceKey));
      }).map(([id]) => id));
      // Internal dependencies may extend beyond the pages citing the original source.
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, revision] of Object.entries(state.heads)) {
          if (affectedSet.has(id)) continue;
          const page = state.revisions[key(id, revision)];
          if (page?.relations.some((r) => r.type === "supports" &&
            (affectedSet.has(r.fromKnowledgeId) || affectedSet.has(r.toKnowledgeId)))) {
            affectedSet.add(id); changed = true;
          }
        }
      }
      const affected = [...affectedSet].sort();
      if (state.ingestions?.[operationId]) throw new Error("operation ID reused");
      const op = state.operations[operationId];
      if (op && op.candidateId !== `withdraw:${sourceKey}`) throw new Error("operation ID reused");
      if (!state.withdrawnSources.includes(sourceKey)) state.withdrawnSources.push(sourceKey);
      for (const id of affected) state.validityOverrides[id] = "needs_review";
      state.operations[operationId] = { candidateId: `withdraw:${sourceKey}`, status: "published", revision: "withdrawal" };
      state.generation++; await this.save(projectId, state);
      return affected;
    });
  }
}
