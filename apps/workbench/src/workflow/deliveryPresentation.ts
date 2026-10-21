import type { Document, DocumentRevision } from "@evoloop/contracts";
import { safeArtifactHref } from "../api.ts";

export interface DeliveryArtifactInput {
  artifactRef: string;
  artifactRevision: string;
  contentHash: string;
}

export type DeliveryTarget =
  | { kind: "document"; documentId: string; revisionId: string; href: string }
  | { kind: "fallback"; label: string; href: string | null };

const uuid = "[0-9a-f-]{36}";
const documentRoute = new RegExp(`^#/p/([^/?#]+)/documents/(${uuid})\\?revision=(${uuid})$`, "i");

/** Only a fixed document route in the current project may be given a fetched title. */
export function deliveryTarget(input: DeliveryArtifactInput, projectId: string): DeliveryTarget {
  const safe = safeArtifactHref(input.artifactRef, projectId);
  const match = safe && documentRoute.exec(safe);
  if (match) {
    if (decodeURIComponent(match[1]!) !== projectId || match[3]!.toLowerCase() !== input.artifactRevision.toLowerCase())
      return { kind: "fallback", label: "链接与交付固定修订不一致", href: null };
    return { kind: "document", documentId: match[2]!, revisionId: match[3]!, href: safe! };
  }
  if (!safe) return { kind: "fallback", label: "无法安全打开的产物引用", href: null };
  if (safe.startsWith("#/p/")) return { kind: "fallback", label: "项目内产物链接（标题未核实）", href: safe };
  try {
    const url = new URL(safe);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.hash.startsWith("#/p/"))
      return { kind: "fallback", label: "其他项目或无法核实的本机链接", href: null };
    return { kind: "fallback", label: `外部产物 · ${url.hostname}`, href: safe };
  } catch { return { kind: "fallback", label: "未识别的产物引用", href: null }; }
}

/** A current document name may label an old revision only after that exact original is read. */
export function verifiedDocumentTitle(input: DeliveryArtifactInput, target: Extract<DeliveryTarget, { kind: "document" }>, projectId: string, document: Document, revision: DocumentRevision): string | null {
  if (document.projectId !== projectId || document.id.toLowerCase() !== target.documentId.toLowerCase()
    || revision.projectId !== projectId || revision.documentId.toLowerCase() !== target.documentId.toLowerCase()
    || revision.id.toLowerCase() !== target.revisionId.toLowerCase()
    || revision.contentHash.toLowerCase() !== input.contentHash.toLowerCase()) return null;
  const title = document.title.trim();
  return title && !new RegExp(`^${uuid}(?:\\.[a-z0-9]+)?$`, "i").test(title) ? title : null;
}
