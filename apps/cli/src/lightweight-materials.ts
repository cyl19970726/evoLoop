import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { ApiClient } from "./client.js";
import { MaterialError } from "./materials.js";

const sha = /^[0-9a-f]{64}$/i;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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
