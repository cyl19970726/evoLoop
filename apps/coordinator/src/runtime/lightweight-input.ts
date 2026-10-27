import { createHash } from "node:crypto";
import type { BasisSet, RuntimeRunRecord, TaskRevision } from "@evoloop/contracts";
import type { FixedDocumentSummary } from "./materials.js";
import { PreflightError } from "./preflight-report.js";

export const lightweightInputProtocol = "evoloop-lightweight-v1";
const maxInputBytes = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function preview(value: string, maxBytes: number) {
  let text = "", bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    text += character; bytes += size;
  }
  // A long encoded token is a material pointer, never useful as a partial first-message excerpt.
  text = text.replace(/data:[^\s;,]{1,100};base64,[A-Za-z0-9+/=]+/gi, "[encoded resource omitted]")
    .replace(/[A-Za-z0-9+/=]{256,}/g, "[long token omitted]");
  return { text, totalBytes: Buffer.byteLength(value, "utf8"), truncated: bytes < Buffer.byteLength(value, "utf8") };
}

/** This is the exact native Turn message; the Run inputHash still hashes run.input alone. */
export function buildLightweightInput(run: RuntimeRunRecord, revision: TaskRevision, basis: BasisSet,
  documents: FixedDocumentSummary[]) {
  if (revision.id !== run.taskRevisionId || revision.taskId !== run.taskId ||
      basis.id !== run.basisSetId || basis.taskRevisionId !== run.taskRevisionId ||
      documents.length !== new Set(documents.map(document => `${document.documentId}:${document.revisionId}`)).size ||
      !documents.some(document => document.documentId === revision.contentDocumentId &&
        document.revisionId === revision.contentRevisionId))
    throw new PreflightError("FIXED_SOURCE_INVALID", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId });
  const source = (document: FixedDocumentSummary) => ({ role: document.documentId === revision.contentDocumentId &&
    document.revisionId === revision.contentRevisionId ? "primary" : "basis", ...document });
  const fixed = {
    protocol: lightweightInputProtocol, projectId: run.projectId, taskId: run.taskId,
    taskRevisionId: run.taskRevisionId, basisSetId: run.basisSetId,
    runId: run.id, sessionId: run.sessionId, operationId: run.operationId,
    title: revision.title,
    taskPreview: preview(revision.content, 1200), acceptancePreview: preview(revision.acceptance, 1200),
    runInstructionPreview: { ...preview(run.input, 4096), inputHash: run.inputHash },
    fixedDocuments: documents.map(source),
    taskCatalogPath: `/api/projects/${run.projectId}/tasks/${run.taskId}/revisions/${run.taskRevisionId}/materials`,
  };
  const input = `[evoloop-run-operation:${run.operationId}]\n${JSON.stringify(fixed)}\n` +
    "This is a bounded handoff, not the full Task or original materials. Use the scoped evoLoop CLI already supplied to this Session: read the fixed Task material catalog, then page through required text and fetch selected assets separately. Verify returned revision IDs and SHA-256. Read the complete Run instruction and Task acceptance before acting if an excerpt is marked truncated. Preserve the fixed basis; a newer current revision is not a substitute. Native Turn completion is not Delivery or consumer use.";
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength > maxInputBytes) throw new PreflightError("INPUT_LIMIT", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId }, byteLength, maxInputBytes);
  return { protocol: lightweightInputProtocol, input, contentHash: hash(input), byteLength };
}
