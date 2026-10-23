import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ApiClient } from "./client.js";
import type { BasisSet, DocumentRevision, RuntimeRunRecord, TaskDetail, TaskRevision } from "@evoloop/contracts";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";

const MAX_BUNDLE = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** A fixed material is invalid or unavailable; transport and filesystem errors retain their own types. */
export class MaterialError extends Error {
  readonly code = "MATERIAL_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "MaterialError";
  }
}
export type ReadClient = Pick<ApiClient, "get">;
export interface VerifiedAsset { path: string; mediaType: string; contentHash: string; size: number; base64: string }
export interface VerifiedOriginal { status: "complete"; revision: DocumentRevision; body: string; assets: VerifiedAsset[]; totalBytes: number }
export interface MaterialFailure { kind: "task" | "document" | "git" | "wiki" | "run"; id: string; revisionId: string | null; reason: string }
export interface ExternalOriginal { reference: TaskExternalReferenceRecord; body: string }
export interface TaskContext {
  status: "complete" | "partial"; projectId: string; taskId: string; taskRevisionId: string;
  task: TaskDetail["task"] | null; revision: TaskRevision | null; basis: BasisSet | null;
  history: Array<{ revision: TaskRevision; basis: BasisSet | null }> | null;
  documents: VerifiedOriginal[]; externalReferences: ExternalOriginal[]; failures: MaterialFailure[];
}
function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaterialError(`${label} is invalid`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new MaterialError(`${label} is invalid`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new MaterialError(`${label} is invalid`);
  return value;
}
function uuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new MaterialError(`${label} must be a UUID`);
  return value;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function utf8(body: string): Buffer { return Buffer.from(body, "utf8"); }
function decode(encoded: unknown): Buffer {
  if (typeof encoded !== "string" || encoded.length > 22_400_000 || !BASE64.test(encoded)) throw new MaterialError("Resource base64 is invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new MaterialError("Resource base64 is noncanonical");
  return bytes;
}
function relativePath(value: unknown): string {
  const path = string(value, "Resource path");
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".DS_Store"))
    throw new MaterialError("Resource path is unsafe");
  return path;
}
function fixedPath(projectId: string): string { return `/api/projects/${uuid(projectId, "Project ID")}`; }
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Reverify server-authorized fixed original bytes and the exact immutable manifest. */
export async function readOriginal(client: ReadClient, projectId: string, documentId: string, revisionId: string): Promise<VerifiedOriginal> {
  const path = `${fixedPath(projectId)}/documents/${uuid(documentId, "Document ID")}/revisions/${uuid(revisionId, "Revision ID")}/original`;
  const response = obj(await client.get(path), "Original response");
  const revision = obj(response.revision, "Document revision") as unknown as DocumentRevision;
  if (revision.projectId !== projectId || revision.documentId !== documentId || revision.id !== revisionId)
    throw new MaterialError("Original revision scope differs from requested fixed revision");
  if (!((revision.format === "markdown" && revision.mediaType === "text/markdown") ||
      (revision.format === "html" && revision.mediaType === "text/html"))) throw new MaterialError("Original format and media type disagree");
  if ((revision.body === null) === (revision.payloadRef === null)) throw new MaterialError("Original storage metadata is invalid");
  const read = obj(response, "Original response");
  if (read.status !== "available") throw new MaterialError(`Fixed original unavailable: ${string(read.reason, "Unavailable reason")}`);
  const body = string(read.body, "Original body");
  const bytes = utf8(body);
  if (bytes.length > MAX_BUNDLE || !SHA.test(revision.contentHash) || digest(bytes) !== revision.contentHash)
    throw new MaterialError("Original body exceeds limit or fails SHA-256 verification");
  if (revision.body !== null && (revision.body !== body || revision.assetsManifest.length !== 0))
    throw new MaterialError("Inline original differs from revision metadata");
  const manifest = list(revision.assetsManifest, "Resource manifest");
  const supplied = list(read.assets, "Original resources");
  if (manifest.length > 50 || supplied.length !== manifest.length) throw new MaterialError("Original resource manifest is incomplete");
  const expected = new Map<string, Record<string, unknown>>();
  const names = new Set<string>();
  for (const raw of manifest) {
    const entry = obj(raw, "Resource manifest entry");
    const name = relativePath(entry.path);
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(key)) throw new MaterialError("Original resource path is duplicated");
    names.add(key); expected.set(name, entry);
  }
  let totalBytes = bytes.length;
  const assets: VerifiedAsset[] = [];
  const seen = new Set<string>();
  for (const raw of supplied) {
    const item = obj(raw, "Original resource");
    const name = relativePath(item.path);
    const entry = expected.get(name);
    if (!entry || seen.has(name) || item.mediaType !== entry.mediaType || typeof entry.mediaType !== "string")
      throw new MaterialError("Original resource differs from manifest");
    const resourceBytes = decode(item.base64);
    if (!Number.isSafeInteger(entry.size) || resourceBytes.length !== entry.size || !SHA.test(string(entry.contentHash, "Resource hash")) ||
        digest(resourceBytes) !== entry.contentHash) throw new MaterialError("Original resource fails size or SHA-256 verification");
    totalBytes += resourceBytes.length;
    if (totalBytes > MAX_BUNDLE) throw new MaterialError("Original bundle exceeds 16 MiB");
    seen.add(name);
    assets.push({ path: name, mediaType: entry.mediaType, contentHash: entry.contentHash, size: resourceBytes.length,
      base64: item.base64 as string });
  }
  if (revision.body !== null && assets.length) throw new MaterialError("Inline original has external resources");
  return { status: "complete", revision, body, assets, totalBytes };
}

/** Publish a verified bundle as one new directory; cleanup removes failed temporary writes. */
export async function exportOriginal(read: VerifiedOriginal, destinationDirectory: string): Promise<string> {
  if (read.status !== "complete" || !destinationDirectory || !read.revision) throw new MaterialError("Verified original is required");
  const destination = resolve(destinationDirectory);
  const parent = dirname(destination);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new MaterialError("Export parent must be a real directory");
  try { await lstat(destination); throw new MaterialError("Export destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const originalName = relativePath(read.revision.originalName);
  if (originalName.includes("/")) throw new MaterialError("Original filename is unsafe");
  const mainName = read.revision.entrypoint === null ? originalName : relativePath(read.revision.entrypoint);
  const names = new Set<string>();
  for (const name of [mainName, ...read.assets.map(asset => relativePath(asset.path)), "manifest.json"]) {
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(key)) throw new MaterialError("Export files contain duplicate paths");
    names.add(key);
  }
  // Recheck the in-memory verified object: callers may have mutated it after readOriginal.
  const bodyBytes = utf8(read.body);
  if (digest(bodyBytes) !== read.revision.contentHash ||
      (read.revision.body !== null && read.revision.body !== read.body)) throw new MaterialError("Original body changed before export");
  const manifest = new Map(read.revision.assetsManifest.map(asset => [asset.path, asset]));
  if (manifest.size !== read.assets.length) throw new MaterialError("Original resource manifest changed before export");
  let totalBytes = bodyBytes.length;
  const assetBytes = read.assets.map(asset => {
    const expected = manifest.get(asset.path);
    if (!expected || expected.contentHash !== asset.contentHash || expected.size !== asset.size ||
        expected.mediaType !== asset.mediaType) throw new MaterialError("Original resource manifest changed before export");
    const bytes = decode(asset.base64);
    if (bytes.length !== asset.size || digest(bytes) !== asset.contentHash) throw new MaterialError("Original resource changed before export");
    totalBytes += bytes.length;
    return { path: asset.path, bytes };
  });
  if (totalBytes > MAX_BUNDLE || totalBytes !== read.totalBytes) throw new MaterialError("Export bundle size differs from verified original");
  const temporary = await mkdtemp(join(parent, `.${basename(destination)}-tmp-`));
  try {
    const put = async (path: string, bytes: Uint8Array): Promise<void> => {
      const target = resolve(temporary, path);
      if (!target.startsWith(`${temporary}${sep}`)) throw new MaterialError("Export path escapes temporary directory");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    };
    await put(mainName, bodyBytes);
    for (const asset of assetBytes) await put(asset.path, asset.bytes);
    await put("manifest.json", utf8(JSON.stringify({ revision: read.revision, totalBytes, assets: read.assets.map(({ base64: _base64, ...asset }) => asset) }, null, 2)));
    try { await lstat(destination); throw new MaterialError("Export destination already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(temporary, destination);
    return destination;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

/** Read every sealed basis and explicitly frozen external source for a chosen Task revision. */
export async function readTaskContext(client: ReadClient, projectId: string, taskId: string, revisionId?: string): Promise<TaskContext> {
  const root = `${fixedPath(projectId)}/tasks/${uuid(taskId, "Task ID")}`;
  const failures: MaterialFailure[] = [];
  let detail: TaskDetail;
  try { detail = obj(await client.get(root), "Task detail") as unknown as TaskDetail; }
  catch (error) { return { status: "partial", projectId, taskId, taskRevisionId: revisionId ?? "", task: null, revision: null,
    basis: null, history: null, documents: [], externalReferences: [], failures: [{ kind: "task", id: taskId, revisionId: revisionId ?? null, reason: reason(error) }] }; }
  if (detail.task?.projectId !== projectId || detail.task?.id !== taskId || detail.revision?.id !== detail.task.currentRevisionId)
    throw new MaterialError("Task detail scope or current revision is inconsistent");
  const selectedId = revisionId ? uuid(revisionId, "Task revision ID") : detail.revision.id;
  let revision: TaskRevision | null = null;
  let basis: BasisSet | null = null;
  try {
    const selected = revisionId ? obj(await client.get(`${root}/revisions/${selectedId}`), "Task revision") : detail;
    revision = obj(selected.revision, "Task revision") as unknown as TaskRevision;
    basis = selected.basis === null ? null : obj(selected.basis, "Basis set") as unknown as BasisSet;
    if (revision.projectId !== projectId || revision.taskId !== taskId || revision.id !== selectedId ||
        (revision.basisSetId === null) !== (basis === null) ||
        (basis && (basis.projectId !== projectId || basis.taskId !== taskId || basis.taskRevisionId !== selectedId || basis.id !== revision.basisSetId || basis.sealed !== true)))
      throw new MaterialError("Selected Task revision or sealed basis scope is inconsistent");
  } catch (error) { failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: reason(error) }); }
  let history: TaskContext["history"] = null;
  try {
    const raw = list(await client.get(`${root}/revisions`), "Task revision history");
    history = raw.map(value => obj(value, "History item") as unknown as { revision: TaskRevision; basis: BasisSet | null });
    if (history.length > 10_000 || history.some(item => item.revision?.taskId !== taskId || item.revision?.projectId !== projectId) ||
        (revision && !history.some(item => item.revision.id === revision.id))) throw new MaterialError("Task history differs from fixed revision");
  } catch (error) { history = null; failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: `History: ${reason(error)}` }); }
  const documents: VerifiedOriginal[] = [];
  // Context is a single materialized response. The per-original bound alone would
  // otherwise permit twenty 16 MiB basis documents in one JSON result.
  let contextBytes = 0;
  let budgetExhausted = false;
  const sources: Array<{ documentId: string; revisionId: string }> = [];
  if (revision) {
    try {
      sources.push({ documentId: uuid(revision.contentDocumentId, "Task content document"),
        revisionId: uuid(revision.contentRevisionId, "Task content revision") });
      if (typeof revision.content !== "string") throw new MaterialError("Task content projection is missing");
    } catch (error) { failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: reason(error) }); }
  }
  if (basis) {
    if (!Array.isArray(basis.members) || basis.members.length < 1 || basis.members.length > 20 ||
        new Set(basis.members.map(member => member.documentId)).size !== basis.members.length)
      failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: "Sealed basis members are invalid or duplicated" });
    else for (const member of basis.members) {
      const existing = sources.find(source => source.documentId === member.documentId);
      if (existing && existing.revisionId !== member.revisionId)
        failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: "Task primary content and sealed basis disagree" });
      else if (!existing) sources.push(member);
    }
  }
  for (const member of sources) {
    if (budgetExhausted) {
      failures.push({ kind: "document", id: member.documentId, revisionId: member.revisionId,
        reason: "Fixed original was not read because complete Task context exceeds 16 MiB; use original for this revision" });
      continue;
    }
    try {
      const original = await readOriginal(client, projectId, member.documentId, member.revisionId);
      if (member.documentId === revision?.contentDocumentId && original.body !== revision.content)
        throw new MaterialError("Task content projection differs from its fixed original");
      if (contextBytes + original.totalBytes > MAX_BUNDLE) {
        budgetExhausted = true;
        failures.push({ kind: "document", id: member.documentId, revisionId: member.revisionId,
          reason: "Complete fixed original would exceed the 16 MiB Task context budget; use original for this revision" });
        continue;
      }
      contextBytes += original.totalBytes;
      documents.push(original);
    }
    catch (error) { failures.push({ kind: "document", id: member.documentId, revisionId: member.revisionId, reason: reason(error) }); }
  }
  const externalReferences: ExternalOriginal[] = [];
  if (revision) {
    try {
      const snapshots = list(await client.get(`${fixedPath(projectId)}/references/tasks/${taskId}/revisions/${selectedId}`), "External reference snapshot");
      if (snapshots.length > 100) throw new MaterialError("External reference snapshot exceeds 100 slots");
      const seenSlots = new Set<string>();
      for (const raw of snapshots) {
        const fixed = obj(raw, "External reference") as unknown as TaskExternalReferenceRecord;
        if (seenSlots.has(fixed.slotId)) { failures.push({ kind: fixed.kind, id: fixed.referenceId, revisionId: fixed.revision, reason: "Duplicate external reference slot" }); continue; }
        seenSlots.add(fixed.slotId);
        try {
          if (fixed.projectId !== projectId || fixed.taskId !== taskId || fixed.taskRevisionId !== selectedId ||
              fixed.observedCurrentValidity !== "valid" || !SHA.test(fixed.contentHash)) throw new MaterialError("Fixed external reference scope or baseline is invalid");
          if (budgetExhausted) throw new MaterialError("Fixed original was not read because complete Task context exceeds 16 MiB; read this reference separately");
          const body = fixed.kind === "git" ? await readGit(client, projectId, fixed) :
            fixed.kind === "wiki" ? await readWiki(client, projectId, fixed) :
              fixed.kind === "run" ? await readRun(client, projectId, fixed) : (() => { throw new MaterialError("Unknown external reference kind"); })();
          const size = utf8(body).length;
          if (contextBytes + size > MAX_BUNDLE) {
            budgetExhausted = true;
            throw new MaterialError("Complete fixed original would exceed the 16 MiB Task context budget; read this reference separately");
          }
          contextBytes += size;
          externalReferences.push({ reference: fixed, body });
        } catch (error) { failures.push({ kind: fixed.kind, id: fixed.referenceId,
          revisionId: fixed.revision, reason: reason(error) }); }
      }
    } catch (error) { failures.push({ kind: "task", id: taskId, revisionId: selectedId, reason: `External snapshot: ${reason(error)}` }); }
  }
  return { status: failures.length ? "partial" : "complete", projectId, taskId, taskRevisionId: selectedId,
    task: detail.task, revision, basis, history, documents, externalReferences, failures };
}
async function readRun(client: ReadClient, projectId: string, fixed: TaskExternalReferenceRecord): Promise<string> {
  const run = obj(await client.get(`${fixedPath(projectId)}/runtime/runs/${uuid(fixed.referenceId, "Run ID")}`), "Fixed Run") as unknown as RuntimeRunRecord;
  if (run.projectId !== projectId || run.id !== fixed.referenceId || run.taskRevisionId !== fixed.revision ||
      run.inputHash !== fixed.contentHash || !["completed", "failed", "interrupted"].includes(run.state) || !run.nativeTurnId)
    throw new MaterialError("Fixed Run input identity or terminal binding differs from the adopted reference");
  return JSON.stringify({runId: run.id, sourceTaskId: run.taskId, sourceTaskRevisionId: run.taskRevisionId,
    inputHash: run.inputHash, state: run.state, evidenceRead: `read run ${run.id} --project ${projectId} --trace`,
    note: "The inputHash identifies fixed input, not transcript content. Check trace completeness before drawing conclusions."});
}
async function readGit(client: ReadClient, projectId: string, fixed: TaskExternalReferenceRecord): Promise<string> {
  if (fixed.observedCurrentRevision !== fixed.revision || fixed.observedCurrentHash !== fixed.contentHash)
    throw new MaterialError("Git review baseline differs from fixed commit");
  const response = obj(await client.get(`${fixedPath(projectId)}/references/git/${uuid(fixed.referenceId, "Git reference ID")}`), "Git original");
  const ref = obj(response.ref, "Git source reference");
  if (response.status !== "available" || ref.projectId !== projectId || ref.commit !== fixed.revision || ref.contentHash !== fixed.contentHash)
    throw new MaterialError("Fixed Git original is unavailable or differs from registration");
  const bytes = decode(response.base64);
  if (bytes.length > MAX_BUNDLE || digest(bytes) !== fixed.contentHash) throw new MaterialError("Fixed Git original fails SHA-256 verification");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new MaterialError("Fixed Git original is not UTF-8 text"); }
}
async function readWiki(client: ReadClient, projectId: string, fixed: TaskExternalReferenceRecord): Promise<string> {
  const pagePath = `${fixedPath(projectId)}/knowledge/pages/${encodeURIComponent(fixed.referenceId)}`;
  const fixedRaw = await client.get(`${pagePath}?revision=${encodeURIComponent(fixed.revision)}`);
  const currentRaw = await client.get(pagePath);
  const page = obj(fixedRaw, "Fixed Wiki page");
  const current = obj(currentRaw, "Current Wiki page");
  if (page.projectId !== projectId || current.projectId !== projectId || page.revision !== fixed.revision ||
      page.contentHash !== fixed.contentHash || page.validity !== "valid" || page.observedValidity !== "valid" ||
      current.validity !== "valid" || current.observedValidity !== "valid" ||
      current.revision !== fixed.observedCurrentRevision || current.contentHash !== fixed.observedCurrentHash ||
      (current.revision !== fixed.revision && fixed.decision !== "retain"))
    throw new MaterialError("Fixed Wiki original changed, was withdrawn, or needs another review");
  const body = string(page.body, "Fixed Wiki body");
  const bytes = utf8(body);
  if (bytes.length > MAX_BUNDLE || digest(bytes) !== fixed.contentHash) throw new MaterialError("Fixed Wiki original fails SHA-256 verification");
  return body;
}
