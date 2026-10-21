import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { commandSchema, idSchema } from "@evoloop/contracts";
import { ApiClient, CliApiError } from "./client.js";

type Json = Record<string, unknown>;
export const record = (value: unknown): Json | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => {
  const object = record(child);
  return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])) : child;
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export interface Recovery { kind: "core" | "candidate" | "publish" | "ingestion" | "manual"; path: string }
export interface Intent {
  projectId: string; id: string; operationId: string | null; kind: string; path: string; body: unknown; recovery: Recovery;
  confirmation: "command" | "candidate" | "publish" | "ingestion" | "ack" | "review" | "publish-reconcile" | "runtime-reconcile" | "runtime-recover";
  targetId?: string;
}
export interface Receipt extends Intent {
  apiUrl: string; credentialHash: string; requestHash: string; createdAt: string; updatedAt: string;
  actorId?: string;
  state: "pending" | "confirmed" | "rejected"; result?: unknown; lastError?: unknown;
}
export class ReceiptError extends Error {
  constructor(public code: string, message: string, public data: unknown = null) { super(message); }
}
export interface VerifiedActor { actorId: string; projectIds: string[] }
export class ReceiptStore {
  readonly directory: string;
  constructor(directory?: string) { this.directory = resolve(directory || join(homedir(), ".local", "state", "evoloop", "operations")); }
  private file(id: string): string { return join(this.directory, `${idSchema.parse(id)}.json`); }
  async get(id: string): Promise<Receipt> {
    const file = this.file(id);
    let text: string;
    try { text = await readFile(join(this.directory, `.${id}.terminal.json`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = await readFile(file, "utf8"); }
    const parsed: unknown = JSON.parse(text);
    const value = record(parsed);
    if (!value || value.id !== id || !["pending", "confirmed", "rejected"].includes(String(value.state)) ||
      typeof value.apiUrl !== "string" || typeof value.credentialHash !== "string" || typeof value.requestHash !== "string" ||
      !record(value.recovery) || typeof record(value.recovery)?.path !== "string") throw new ReceiptError("INVALID_RECEIPT", "Local receipt is invalid.");
    return value as unknown as Receipt;
  }
  async list(): Promise<unknown[]> {
    let files: string[];
    try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const values: unknown[] = [];
    for (const file of files.filter(file => /^[\da-f-]{36}\.json$/i.test(file)).sort()) {
      const entry = await this.get(file.slice(0, -5));
      values.push({ receiptId: entry.id, operationId: entry.operationId, projectId: entry.projectId, kind: entry.kind, state: entry.state,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt, recovery: entry.recovery });
    }
    return values;
  }
  async prepare(apiUrl: string, token: string, intent: Intent, actor?: VerifiedActor): Promise<{ receipt: Receipt; existing: boolean }> {
    idSchema.parse(intent.projectId); idSchema.parse(intent.id);
    if (intent.operationId !== null) idSchema.parse(intent.operationId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const requestHash = sha(canonical(intent));
    const credentialHash = sha(token);
    const now = new Date().toISOString();
    if (actor && !actor.projectIds.includes(intent.projectId)) throw new ReceiptError("RECEIPT_SCOPE_MISMATCH", "Authenticated identity cannot access this project.");
    const receipt: Receipt = { ...intent, apiUrl, credentialHash, requestHash, ...(actor ? { actorId: actor.actorId } : {}), state: "pending", createdAt: now, updatedAt: now };
    const temporary = join(this.directory, `.${intent.id}-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(receipt, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, this.file(intent.id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.get(intent.id);
        this.checkScope(existing, apiUrl, token, actor);
        if (existing.requestHash !== requestHash || existing.projectId !== intent.projectId)
          throw new ReceiptError("OPERATION_REUSE", "This receipt ID already belongs to a different saved intent. Preserve the original receipt.", { receiptId: intent.id });
        return { receipt: existing, existing: true };
      }
      return { receipt, existing: false };
    } finally { await rm(temporary, { force: true }); }
  }
  checkScope(receipt: Receipt, apiUrl: string, token: string, actor?: VerifiedActor): void {
    const sameIdentity = actor && receipt.actorId === actor.actorId && actor.projectIds.includes(receipt.projectId);
    // Token hashes are a conservative fallback for older receipts without a server-verified actor.
    if (receipt.apiUrl !== apiUrl || receipt.credentialHash !== sha(token) && !sameIdentity ||
      actor && (receipt.actorId !== undefined && receipt.actorId !== actor.actorId || !actor.projectIds.includes(receipt.projectId)))
      throw new ReceiptError("RECEIPT_SCOPE_MISMATCH", "Use the same API origin and a server-verified identity authorized for the original project.");
  }
  async update(receipt: Receipt, change: Partial<Pick<Receipt, "state" | "result" | "lastError">>): Promise<Receipt> {
    const saved = await this.get(receipt.id);
    if (saved.state !== "pending") return saved;
    const next = { ...saved, ...change, updatedAt: new Date().toISOString() };
    const temporary = join(this.directory, `.${receipt.id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (next.state !== "pending") {
        try { await link(temporary, join(this.directory, `.${receipt.id}.terminal.json`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return this.get(receipt.id); }
      }
      await rename(temporary, this.file(receipt.id));
    } finally { await rm(temporary, { force: true }); }
    return this.get(receipt.id);
  }
}

function confirmed(receipt: Receipt, result: unknown): boolean {
  const value = record(result), body = record(receipt.body);
  if (!value) return false;
  if (receipt.confirmation === "command") return value.status === "applied" && value.operationId === receipt.operationId && typeof value.entityId === "string";
  if (receipt.confirmation === "publish" || receipt.confirmation === "publish-reconcile") return value.status === "published" && value.operationId === receipt.operationId && typeof value.revision === "string";
  if (receipt.confirmation === "candidate") return value.operationId === receipt.operationId && value.candidateId === body?.candidateId &&
    value.candidateRevision === body?.candidateRevision && value.knowledgeId === body?.knowledgeId &&
    value.contentHash === sha(String(body?.body));
  if (receipt.confirmation === "ingestion") {
    const source = record(value.source);
    return value.operationId === receipt.operationId && value.actorId === receipt.actorId &&
      source?.sourceKey === `document:${body?.documentId}` && source.originRevision === body?.revisionId &&
      typeof source.contentHash === "string" && /^[a-f0-9]{64}$/.test(source.contentHash) &&
      typeof value.title === "string" && value.title.length > 0 && value.indexStatus === "unverified" &&
      ["submitted", "completed", "failed"].includes(String(value.status)) &&
      (value.taskId === null || typeof value.taskId === "string");
  }
  if (receipt.confirmation === "review") {
    const decision = record(value.decision);
    return value.status === "recorded" && !!decision && decision.candidateId === receipt.targetId && typeof decision.reviewerId === "string" &&
      ["candidateRevision", "contentHash", "expectedRevision", "decision", "reason"].every(key => decision[key] === body?.[key]);
  }
  if (receipt.confirmation === "runtime-recover") return value.available === true && (value.error === null || value.error === undefined);
  if (receipt.confirmation === "runtime-reconcile") return value.id === receipt.targetId && value.projectId === receipt.projectId &&
    typeof value.version === "number" && typeof body?.expectedVersion === "number" && value.version >= body.expectedVersion &&
    ["reserved", "dispatching", "running", "completed", "failed", "interrupted", "unknown", "abandoned"].includes(String(value.state));
  return value.status === "recorded" && receipt.operationId !== null && value.operationId === receipt.operationId;
}
function rejected(receipt: Receipt, result: unknown): boolean {
  const value = record(result);
  return !!value && value.operationId === receipt.operationId && (value.status === "rejected" || value.status === "conflict");
}
function pending(receipt: Receipt, extra?: unknown): ReceiptError {
  return new ReceiptError("RESULT_UNCONFIRMED", "The original intent is saved. Reconcile this receipt; do not dispatch a new operation ID.",
    { receiptId: receipt.id, operationId: receipt.operationId, state: receipt.state, recovery: receipt.recovery, observation: extra ?? null });
}

export async function dispatchMutation(client: ApiClient, store: ReceiptStore, apiUrl: string, token: string, intent: Intent,
  diagnostic: (value: unknown) => void, actor?: VerifiedActor): Promise<unknown> {
  const prepared = await store.prepare(apiUrl, token, intent, actor);
  const receipt = prepared.receipt;
  diagnostic({ receiptId: receipt.id, operationId: receipt.operationId, receipt: join(store.directory, `${receipt.id}.json`), state: receipt.state });
  if (prepared.existing) {
    if (receipt.state === "confirmed") return receipt.result;
    if (receipt.state === "rejected") throw new ReceiptError("OPERATION_REJECTED", "Read the saved rejection and refresh the affected object before changing the intent.", receipt.result ?? receipt.lastError);
    throw pending(receipt);
  }
  return submitReceipt(client, store, receipt);
}

async function submitReceipt(client: ApiClient, store: ReceiptStore, receipt: Receipt, replay = false): Promise<unknown> {
  let result: unknown;
  try { result = await client.post(receipt.path, receipt.body); }
  catch (error) {
    if (replay && error instanceof CliApiError && rejected(receipt, error.data)) {
      await store.update(receipt, { state: "rejected", result: error.data });
      throw new ReceiptError("OPERATION_REJECTED", "The service rejected the original intent.", error.data);
    }
    // A retry-time HTTP denial says nothing about an older request still finishing.
    // Only the original operation's result can resolve that pending receipt.
    const known = !replay && error instanceof CliApiError && !error.unconfirmed;
    const details = error instanceof CliApiError ? { code: error.code, status: error.status, data: error.data } : { code: "REQUEST_UNAVAILABLE" };
    await store.update(receipt, { state: known ? "rejected" : "pending", lastError: details });
    if (known) throw error;
    throw pending(receipt, details);
  }
  if (receipt.confirmation === "publish-reconcile") result = record(result)?.result;
  if (rejected(receipt, result)) {
    await store.update(receipt, { state: "rejected", result });
    throw new ReceiptError("OPERATION_REJECTED", "The service rejected the original intent.", result);
  }
  if (!confirmed(receipt, result)) {
    await store.update(receipt, { state: "pending", result });
    throw pending(receipt, result);
  }
  await store.update(receipt, { state: "confirmed", result });
  return result;
}

/** Explicit replay of one immutable, transactional core command; never an external action retry. */
export async function retryReceipt(client: ApiClient, store: ReceiptStore, apiUrl: string, token: string, id: string,
  diagnostic: (value: unknown) => void, actor?: VerifiedActor): Promise<Receipt> {
  const receipt = await store.get(id);
  store.checkScope(receipt, apiUrl, token, actor);
  if (!receipt.actorId || !actor || receipt.actorId !== actor.actorId)
    throw new ReceiptError("RETRY_UNSUPPORTED", "Replay requires the original server-verified actor. Older receipts can only be reconciled.");
  const intent: Intent = { id: receipt.id, projectId: receipt.projectId, operationId: receipt.operationId,
    kind: receipt.kind, path: receipt.path, body: receipt.body, confirmation: receipt.confirmation,
    recovery: receipt.recovery, ...(receipt.targetId === undefined ? {} : { targetId: receipt.targetId }) };
  if (sha(canonical(intent)) !== receipt.requestHash)
    throw new ReceiptError("INVALID_RECEIPT", "Saved intent changed; preserve the original receipt and reconcile it.");
  const command = commandSchema.safeParse(receipt.body);
  if (receipt.path !== "/api/commands" || receipt.confirmation !== "command" || receipt.recovery.kind !== "core" ||
    !receipt.operationId || receipt.recovery.path !== `/api/projects/${receipt.projectId}/operations/${receipt.operationId}` ||
    !command.success || command.data.projectId !== receipt.projectId || command.data.operationId !== receipt.operationId ||
    command.data.type !== receipt.kind || canonical(command.data) !== canonical(receipt.body))
    throw new ReceiptError("RETRY_UNSUPPORTED", "Only a saved /api/commands intent can be replayed. External actions require their own reconciliation.");
  if (receipt.state !== "pending") return receipt;
  try { return await reconcileReceipt(client, store, apiUrl, token, id, actor); }
  catch (error) {
    const observation = error instanceof ReceiptError ? record(record(error.data)?.observation) : null;
    if (!(error instanceof ReceiptError) || error.code !== "RESULT_UNCONFIRMED" ||
      observation?.status !== 404 || observation.code !== "OPERATION_NOT_FOUND") throw error;
  }
  // A 404 is not absence proof. The core's project lock and operation digest make
  // replay of this exact ID/actor/body safe even if the first request is still finishing.
  const latest = await store.get(id);
  if (latest.state !== "pending") return latest;
  diagnostic({ receiptId: id, operationId: receipt.operationId, action: "retry_same_core_intent" });
  await submitReceipt(client, store, receipt, true);
  return store.get(id);
}

export async function reconcileReceipt(client: ApiClient, store: ReceiptStore, apiUrl: string, token: string, id: string, actor?: VerifiedActor): Promise<Receipt> {
  const receipt = await store.get(id);
  store.checkScope(receipt, apiUrl, token, actor);
  if (receipt.state !== "pending") return receipt;
  let observed: unknown;
  try {
    observed = receipt.recovery.kind === "publish" ? await client.post(receipt.recovery.path, {}) : await client.get(receipt.recovery.path);
  } catch (error) {
    const details = error instanceof CliApiError ? { code: error.code, status: error.status } : { code: "READ_UNAVAILABLE" };
    await store.update(receipt, { lastError: details });
    throw pending(receipt, details);
  }
  if (receipt.recovery.kind === "manual") {
    await store.update(receipt, { lastError: { code: "MANUAL_RECONCILIATION_REQUIRED", observation: observed } });
    throw pending(receipt, observed);
  }
  const result = receipt.recovery.kind === "core" ? record(observed)?.result : receipt.recovery.kind === "publish" ? record(observed)?.result : observed;
  if (receipt.recovery.kind === "core" && (record(observed)?.id !== receipt.operationId || record(observed)?.projectId !== receipt.projectId)) throw pending(receipt, observed);
  const command = receipt.path === "/api/commands" ? commandSchema.safeParse(receipt.body) : null;
  const expectedActor = receipt.actorId ?? actor?.actorId;
  if (receipt.recovery.kind === "core" && command?.success && expectedActor) {
    const operation = record(observed);
    const expectedHash = sha(canonical({ actorId: expectedActor, command: command.data }));
    if (operation?.actorId !== expectedActor || operation.commandType !== command.data.type || operation.commandHash !== expectedHash)
      throw pending(receipt, { code: "OPERATION_INTENT_MISMATCH" });
  }
  if (rejected(receipt, result)) return store.update(receipt, { state: "rejected", result });
  if (confirmed(receipt, result)) return store.update(receipt, { state: "confirmed", result });
  await store.update(receipt, { result });
  throw pending(receipt, result);
}
