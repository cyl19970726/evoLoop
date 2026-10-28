import { createHash } from "node:crypto";
import { open, rm, writeFile } from "node:fs/promises";
import type { ApiClient } from "./client.js";
import { MaterialError } from "./materials.js";
import { parseQueueHandoff } from "@evoloop/contracts/runtime-handoff";

const sha = /^[0-9a-f]{64}$/i;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytePrefix = (value: string, limit: number) => {
  let result = "", size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > limit) break;
    result += character; size += bytes;
  }
  return { text: result, bytes: size, truncated: size < Buffer.byteLength(value, "utf8") };
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaterialError("Fixed material response is invalid");
  return value as Record<string, unknown>;
};
const exact = (actual: unknown, expected: string, label: string) => {
  if (actual !== expected) throw new MaterialError(`${label} differs from the requested fixed material`);
};
export function fixedHash(value: string | undefined, label: string): string {
  if (!value || !sha.test(value)) throw new MaterialError(`${label} must be a SHA-256 hash`);
  return value.toLowerCase();
}
const root = (projectId: string) => `/api/projects/${projectId}`;

export async function materialCatalog(client: ApiClient, projectId: string, taskId: string, revisionId: string) {
  const result = object(await client.get(`${root(projectId)}/tasks/${taskId}/revisions/${revisionId}/materials`));
  exact(result.projectId, projectId, "Project"); exact(result.taskId, taskId, "Task");
  exact(result.taskRevisionId, revisionId, "Task revision");
  if (!Array.isArray(result.documents) || result.documents.length < 1 || result.documents.length > 21 ||
      !Array.isArray(result.externalReferences) || result.externalReferences.length > 100)
    throw new MaterialError("Fixed material catalog is malformed or unbounded");
  const seen = new Set<string>();
  for (const raw of result.documents) {
    const item = object(raw);
    if (typeof item.documentId !== "string" || typeof item.revisionId !== "string" || seen.has(item.documentId) ||
        !sha.test(String(item.contentHash)) || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 0 ||
        !Array.isArray(item.assets) || item.assets.length > 50)
      throw new MaterialError("Fixed document catalog entry is invalid");
    seen.add(item.documentId);
    for (const rawAsset of item.assets) {
      const asset = object(rawAsset);
      if (!sha.test(String(asset.contentHash)) || !Number.isSafeInteger(asset.sizeBytes) || Number(asset.sizeBytes) < 0)
        throw new MaterialError("Fixed asset catalog entry is invalid");
    }
  }
  for (const raw of result.externalReferences) {
    const item = object(raw);
    if (!["git", "wiki", "run"].includes(String(item.kind)) || !sha.test(String(item.contentHash)) ||
        typeof item.referenceId !== "string" || typeof item.revision !== "string")
      throw new MaterialError("Fixed external reference catalog entry is invalid");
  }
  return result;
}

export async function materialBody(client: ApiClient, projectId: string, documentId: string, revisionId: string,
  expectedHash: string, cursor: number, limit: number) {
  const query = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
  const result = object(await client.get(`${root(projectId)}/documents/${documentId}/revisions/${revisionId}/body?${query}`));
  exact(result.projectId, projectId, "Project"); exact(result.documentId, documentId, "Document");
  exact(result.revisionId, revisionId, "Document revision"); exact(result.contentHash, expectedHash, "Document hash");
  const body = result.body;
  if (typeof body !== "string" || result.startByte !== cursor || !Number.isSafeInteger(result.endByte) ||
      !Number.isSafeInteger(result.totalBytes) || Number(result.endByte) < cursor ||
      Number(result.endByte) > Number(result.totalBytes) ||
      Buffer.byteLength(body, "utf8") !== Number(result.endByte) - cursor ||
      result.truncated !== (result.endByte !== result.totalBytes) ||
      result.nextCursor !== (result.truncated ? String(result.endByte) : null))
    throw new MaterialError("Fixed UTF-8 body page is inconsistent");
  if (cursor === 0 && result.truncated === false && hash(Buffer.from(body, "utf8")) !== expectedHash)
    throw new MaterialError("Complete fixed body hash mismatch");
  return result;
}

export async function materialRunInput(client: ApiClient, projectId: string, runId: string, expectedHash: string,
  cursor = 0, limit = 4096, out?: string) {
  const page = async (at: number) => {
    const query = new URLSearchParams({ cursor: String(at), limit: String(limit) });
    const result = object(await client.get(`${root(projectId)}/runtime/runs/${runId}/input?${query}`));
    exact(result.projectId, projectId, "Project"); exact(result.runId, runId, "Run");
    exact(result.inputHash, expectedHash, "Run input hash");
    if (typeof result.body !== "string" || result.startByte !== at || !Number.isSafeInteger(result.endByte) ||
        !Number.isSafeInteger(result.totalBytes) || Number(result.endByte) < at ||
        Number(result.endByte) > Number(result.totalBytes) ||
        Buffer.byteLength(result.body, "utf8") !== Number(result.endByte) - at ||
        result.truncated !== (result.endByte !== result.totalBytes) ||
        result.nextCursor !== (result.truncated ? String(result.endByte) : null))
      throw new MaterialError("Fixed Run input page is inconsistent");
    return result;
  };
  if (!out) {
    const result = await page(cursor);
    if (cursor === 0 && result.truncated === false && hash(Buffer.from(String(result.body), "utf8")) !== expectedHash)
      throw new MaterialError("Complete fixed Run input hash mismatch");
    return result;
  }
  if (cursor !== 0) throw new MaterialError("Run input export must start at byte zero");
  const file = await open(out, "wx", 0o600);
  let committed = false;
  try {
    const digest = createHash("sha256");
    let at = 0, total: number | null = null;
    for (;;) {
      const result = await page(at);
      if (total !== null && result.totalBytes !== total) throw new MaterialError("Run input length changed between pages");
      total = Number(result.totalBytes);
      const bytes = Buffer.from(String(result.body), "utf8");
      if (bytes.length === 0 && result.truncated) throw new MaterialError("Run input page did not advance");
      digest.update(bytes);
      await file.writeFile(bytes);
      at = Number(result.endByte);
      if (!result.truncated) break;
    }
    if (digest.digest("hex") !== expectedHash) throw new MaterialError("Complete fixed Run input hash mismatch");
    committed = true;
    return { status: "exported", projectId, runId, inputHash: expectedHash, sizeBytes: total, path: out };
  } finally {
    await file.close();
    if (!committed) await rm(out, { force: true });
  }
}

/** One verified first read for v2 Runs; large Task bodies stay in the fixed body pager. */
export async function materialHandoff(client: ApiClient, projectId: string, runId: string, expectedHash: string) {
  let cursor = 0, input = "";
  for (;;) {
    const page = await materialRunInput(client, projectId, runId, expectedHash, cursor, 8192);
    input += page.body as string;
    if (!page.truncated) break;
    cursor = page.endByte as number;
    if (Buffer.byteLength(input, "utf8") > 256 * 1024) throw new MaterialError("Fixed handoff is too large");
  }
  exact(hash(Buffer.from(input, "utf8")), expectedHash, "Complete Run input hash");
  const handoff = parseQueueHandoff(input);
  if (!handoff) throw new MaterialError("Legacy Run: use run-input with its original hash and fixed Task materials");
  const identity = object(await client.get("/api/session"));
  const actor = object(identity.principal).actorId;
  if (actor !== handoff.channel.recipientActorId) throw new MaterialError("This CLI identity is not the fixed Task recipient");
  const task = object(await client.get(`${root(projectId)}/tasks/${handoff.taskId}/revisions/${handoff.taskRevisionId}`));
  const revision = object(task.revision);
  exact(revision.id, handoff.taskRevisionId, "Task revision");
  exact(revision.taskId, handoff.taskId, "Task");
  exact(revision.projectId, projectId, "Project");
  exact(revision.basisSetId, handoff.basisSetId, "Basis set");
  const catalog = await materialCatalog(client, projectId, handoff.taskId, handoff.taskRevisionId);
  exact(catalog.basisSetId, handoff.basisSetId, "Catalog basis set");
  const content = revision.content;
  if (typeof content !== "string" || typeof revision.acceptance !== "string" || typeof revision.title !== "string")
    throw new MaterialError("Fixed Task content is invalid");
  const fullIntroduction = content.split(/^## /m)[0]!.trim();
  const introduction = bytePrefix(fullIntroduction, 2048);
  const fullBoundarySections = content.split(/(?=^## )/m).filter(section =>
    /^## [^\n]*(?:范围|边界|限制)/.test(section)).map(section => section.trim());
  let boundaryBudget = 6144;
  const boundarySections: string[] = [];
  for (const section of fullBoundarySections) {
    if (boundaryBudget === 0) break;
    const excerpt = bytePrefix(section, boundaryBudget);
    boundarySections.push(excerpt.text);
    boundaryBudget -= excerpt.bytes;
    if (excerpt.truncated) break;
  }
  const boundarySectionsTruncated = boundarySections.length < fullBoundarySections.length ||
    boundarySections.some((section, index) => section !== fullBoundarySections[index]);
  const primary = (catalog.documents as Array<Record<string, unknown>>)[0]!;
  exact(primary.documentId, String(revision.contentDocumentId), "Primary Document");
  exact(primary.revisionId, String(revision.contentRevisionId), "Primary Document revision");
  exact(primary.contentHash, hash(Buffer.from(content, "utf8")), "Primary Document content hash");
  return { protocol: handoff.protocol, projectId, runId, inputHash: expectedHash,
    taskId: handoff.taskId, taskRevisionId: handoff.taskRevisionId, basisSetId: handoff.basisSetId,
    title: revision.title, introduction: introduction.text, introductionTruncated: introduction.truncated,
    acceptance: revision.acceptance, boundarySections, boundarySectionsTotal: fullBoundarySections.length,
    boundarySectionsTruncated, contentBytes: Buffer.byteLength(content, "utf8"),
    contentComplete: fullIntroduction === content.trim(),
    fullContentCommand: primary.bodyCommand, change: {kind:handoff.kind,reason:handoff.reason,
      previousRun:handoff.previousRun ? {...handoff.previousRun,
        readCommand:`evoloop run-input ${handoff.previousRun.id} --project ${projectId} --hash ${handoff.previousRun.inputHash}`} : null,
      requiredLegacyInput:handoff.legacySource ? {...handoff.legacySource,
        reason:"This Run chain began with a legacy instruction. Read and verify that exact source before acting; the current fixed Task revision controls any later changes.",
        readCommand:`evoloop run-input ${handoff.legacySource.id} --project ${projectId} --hash ${handoff.legacySource.inputHash} --out NEW_PRIVATE_FILE`} : null,
      answeredQuestions:handoff.answers.map(answer => ({...answer,
        bodyCommand:`evoloop body ${answer.documentId} --project ${projectId} --revision ${answer.revisionId} --hash ${answer.contentHash}`}))},
    taskChannel: {discussionId:handoff.channel.discussionId,recipientActorId:handoff.channel.recipientActorId,
      issuerActorId:handoff.channel.issuerActorId,
      readCommand:`evoloop read discussion ${handoff.channel.discussionId} --project ${projectId}`},
    materials:catalog };
}

export async function materialAsset(client: ApiClient, projectId: string, documentId: string, revisionId: string,
  blobId: string, documentHash: string, assetHash: string, out?: string) {
  // A pinned document hash must be supplied even though the asset response carries its own hash.
  const result = object(await client.get(`${root(projectId)}/documents/${documentId}/revisions/${revisionId}/assets/${blobId}`));
  exact(result.projectId, projectId, "Project"); exact(result.documentId, documentId, "Document");
  exact(result.revisionId, revisionId, "Document revision"); exact(result.blobId, blobId, "Asset");
  exact(result.documentContentHash, documentHash, "Document hash");
  exact(result.contentHash, assetHash, "Asset hash");
  if (typeof result.base64 !== "string" || result.base64.length > 22_400_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64))
    throw new MaterialError("Fixed asset encoding is invalid");
  const bytes = Buffer.from(result.base64, "base64");
  if (bytes.toString("base64") !== result.base64 || bytes.length !== result.size || hash(bytes) !== assetHash)
    throw new MaterialError("Fixed asset size or hash mismatch");
  if (out) {
    await writeFile(out, bytes, { flag: "wx", mode: 0o600 });
    return { status: "exported", projectId, documentId, revisionId, blobId, documentHash, contentHash: assetHash,
      sizeBytes: bytes.length, path: out };
  }
  return result;
}
