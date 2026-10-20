import { z } from "zod";
import type { BlobPayload } from "./sources.js";
import type { Document, DocumentDecision, Operation, OutboxEvent } from "./index.js";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const relative = z.string().min(1).max(240);
const assetSchema = z.strictObject({ path: relative, blobId: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(16 * 1024 * 1024), mediaType: z.string().min(1).max(255) });
const common = {
  projectId: id, operationId: id, documentId: id, revisionId: id,
  format: z.enum(["markdown", "html"]), mediaType: z.enum(["text/markdown", "text/html"]),
  originalName: relative, author: text, reason: text,
};
const source = z.discriminatedUnion("storage", [
  z.strictObject({ storage: z.literal("inline"), body: z.string().min(1).max(65536) }),
  z.strictObject({ storage: z.literal("blob"), payloadRef: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(16 * 1024 * 1024), entrypoint: relative.nullable(), assets: z.array(assetSchema).max(50) }),
]);
export const documentPayloadCommandSchema = z.strictObject({
  ...common, mode: z.enum(["create", "revise"]), title: z.string().trim().min(1).max(240).optional(),
  expectedVersion: z.number().int().positive().optional(), kind: z.enum(["task", "issue", "spec", "discussion", "report"]).nullable().optional(), source,
}).superRefine((command, ctx) => {
  if (command.format === "markdown" && command.mediaType !== "text/markdown" || command.format === "html" && command.mediaType !== "text/html")
    ctx.addIssue({ code: "custom", message: "format and media type disagree", path: ["mediaType"] });
  if (command.mode === "create" && (!command.title || command.expectedVersion !== undefined) ||
      command.mode === "revise" && (command.expectedVersion === undefined || command.kind !== undefined))
    ctx.addIssue({ code: "custom", message: "create requires title; revise requires expectedVersion", path: ["mode"] });
  if (command.kind === "task") ctx.addIssue({ code: "custom", message: "Task primary documents are created through task.create", path: ["kind"] });
});
export type DocumentPayloadCommand = z.infer<typeof documentPayloadCommandSchema>;

const documentUploadSchema = z.strictObject({ blobId: id, base64: z.string().max(22_400_000) });
export const documentImportSchema = z.strictObject({ command: documentPayloadCommandSchema, uploads: z.array(documentUploadSchema).max(51) });

export interface DocumentAsset { path: string; blobId: string; contentHash: string; size: number; mediaType: string }
export interface DocumentPayloadRevision {
  projectId: string; documentId: string; id: string; previousRevisionId: string | null;
  format: "markdown" | "html"; mediaType: "text/markdown" | "text/html"; originalName: string;
  body: string | null; payloadRef: string | null; contentHash: string;
  entrypoint: string | null; assetsManifest: DocumentAsset[];
  author: string; reason: string; createdAt: string;
}
export interface RegisteredDocumentBlob extends BlobPayload {
  documentId: string; revisionId: string; role: "main" | "asset"; relativePath: string | null;
}
export interface RegisteredGitSource { id: string; ref: import("./sources.js").GitSourceRef; state: "reachable" | "unavailable" | "withdrawn"; observedAt: string }
export interface DocumentPayloadReader {
  getOperation(id: string): Promise<Operation | null>;
  getDocumentPayloadRevision(documentId: string, revisionId: string): Promise<DocumentPayloadRevision | null>;
  listDocumentAssets(documentId: string, revisionId: string): Promise<DocumentAsset[]>;
  getRegisteredBlob(id: string): Promise<RegisteredDocumentBlob | null>;
  getGitSourceRef(id: string): Promise<RegisteredGitSource | null>;
}
export interface DocumentPayloadTransaction extends DocumentPayloadReader {
  savepoint<T>(action: () => Promise<T>): Promise<T>;
  insertOperation(operation: Operation): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
  getDocument(id: string): Promise<Document | null>;
  insertDocument(document: Document): Promise<void>;
  updateDocument(document: Document, expectedVersion: number): Promise<void>;
  insertDocumentPayloadRevision(revision: DocumentPayloadRevision): Promise<void>;
  registerDocumentBlob(blob: RegisteredDocumentBlob): Promise<void>;
  insertDocumentDecision(decision: DocumentDecision): Promise<void>;
}
export interface DocumentPayloadUnitOfWork {
  transaction<T>(projectId: string, action: (tx: DocumentPayloadTransaction) => Promise<T>): Promise<T>;
  read<T>(projectId: string, action: (reader: DocumentPayloadReader) => Promise<T>): Promise<T>;
}
