import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";

export interface OriginalResource { path: string; mediaType: string; base64: string }
export type DocumentOriginalRead =
  | { status: "available"; body: string; assets: OriginalResource[] }
  | { status: "unavailable"; reason: string };
export type ReadDocumentOriginal = (principal: Principal, revision: DocumentPayloadRevision) => Promise<DocumentOriginalRead>;

const maxOriginalBytes = 16 * 1024 * 1024;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{64}$/;

export interface FixedDocumentSummary {
  documentId: string; revisionId: string; contentHash: string; format: "markdown" | "html";
  mediaType: string; bodyBytes: number | null; assetCount: number; assetBytes: number;
}

/** Verify bounded fixed metadata without loading original bytes into the native Turn input. */
export function fixedDocumentSummary(revision: DocumentPayloadRevision): FixedDocumentSummary {
  if ((revision.format === "markdown" && revision.mediaType !== "text/markdown") ||
      (revision.format === "html" && revision.mediaType !== "text/html"))
    throw new Error("Fixed document format and media type disagree");
  if ((revision.body === null) === (revision.payloadRef === null) ||
      (revision.body !== null && revision.assetsManifest.length > 0) || !shaPattern.test(revision.contentHash))
    throw new Error("Fixed document storage metadata is invalid");
  const bodyBytes = revision.body === null ? null : Buffer.byteLength(revision.body, "utf8");
  if (revision.body !== null && (bodyBytes! > maxOriginalBytes || sha256(Buffer.from(revision.body, "utf8")) !== revision.contentHash))
    throw new Error("Fixed inline document fails size or SHA256 verification");
  if (revision.assetsManifest.length > 50) throw new Error("Fixed document resource manifest exceeds 50 assets");
  let assetBytes = 0;
  const paths = new Set<string>();
  for (const asset of revision.assetsManifest) {
    if (!asset.path || asset.path.length > 240 || !asset.blobId || !shaPattern.test(asset.contentHash) ||
        !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > maxOriginalBytes ||
        !asset.mediaType || paths.has(asset.path)) throw new Error("Fixed document resource manifest is invalid");
    paths.add(asset.path);
    assetBytes += asset.size;
  }
  if (assetBytes + (bodyBytes ?? 0) > maxOriginalBytes) throw new Error("Fixed document bundle exceeds 16 MiB");
  return { documentId: revision.documentId, revisionId: revision.id, contentHash: revision.contentHash,
    format: revision.format, mediaType: revision.mediaType, bodyBytes,
    assetCount: revision.assetsManifest.length, assetBytes };
}

/** A fixed original is all-or-nothing. Its resources are encoded into the input, never executed. */
export async function fixedDocumentMaterial(
  principal: Principal, revision: DocumentPayloadRevision, readOriginal?: ReadDocumentOriginal,
): Promise<string> {
  if ((revision.format === "markdown" && revision.mediaType !== "text/markdown") ||
      (revision.format === "html" && revision.mediaType !== "text/html"))
    throw new Error("Fixed document format and media type disagree");
  if (revision.body !== null && revision.payloadRef !== null ||
      revision.body === null && revision.payloadRef === null)
    throw new Error("Fixed document original has invalid storage metadata");
  if (revision.body !== null && revision.assetsManifest.length)
    throw new Error("Inline document cannot have external resources");

  const read = revision.body !== null
    ? { status: "available" as const, body: revision.body, assets: [] }
    : readOriginal ? await readOriginal(principal, revision) : { status: "unavailable" as const, reason: "reader_not_configured" };
  if (read.status !== "available") throw new Error(`Fixed document original is unavailable: ${read.reason}`);
  if (typeof read.body !== "string" || !Array.isArray(read.assets))
    throw new Error("Fixed document reader returned invalid content");
  const bodyBytes = Buffer.from(read.body, "utf8");
  if (bodyBytes.length > maxOriginalBytes || sha256(bodyBytes) !== revision.contentHash)
    throw new Error("Fixed document original exceeds 16 MiB or fails SHA256 verification");

  const expected = new Map(revision.assetsManifest.map(asset => [asset.path, asset]));
  if (expected.size !== revision.assetsManifest.length || read.assets.length !== expected.size)
    throw new Error("Fixed document resource manifest is incomplete or duplicated");
  let totalBytes = bodyBytes.length;
  const seen = new Set<string>();
  const resources: OriginalResource[] = [];
  for (const resource of read.assets) {
    const asset = expected.get(resource.path);
    if (!asset || seen.has(resource.path) || resource.mediaType !== asset.mediaType ||
        typeof resource.base64 !== "string" || resource.base64.length > 22_400_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(resource.base64))
      throw new Error("Fixed document resource is unexpected or invalid");
    const bytes = Buffer.from(resource.base64, "base64");
    if (bytes.toString("base64") !== resource.base64 || bytes.length !== asset.size ||
        sha256(bytes) !== asset.contentHash)
      throw new Error("Fixed document resource fails size or SHA256 verification");
    totalBytes += bytes.length;
    if (totalBytes > maxOriginalBytes) throw new Error("Complete fixed document bundle exceeds 16 MiB");
    seen.add(resource.path);
    resources.push({ path: resource.path, mediaType: resource.mediaType, base64: resource.base64 });
  }
  // JSON escaping preserves the complete original and keeps untrusted HTML inert in this process.
  return `Process document ${revision.documentId}, immutable revision ${revision.id}, SHA256 ${revision.contentHash}\n` +
    JSON.stringify({ format: revision.format, mediaType: revision.mediaType, originalName: revision.originalName,
      entrypoint: revision.entrypoint, body: read.body, resources });
}
