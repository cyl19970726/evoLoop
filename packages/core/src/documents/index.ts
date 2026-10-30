import { reviewMetadata, validatePreviousReview } from "./organization-review.js";
import type { BlobPayload, BlobStore } from "@evoloop/contracts/sources";
import { documentPayloadCommandSchema } from "@evoloop/contracts/process-documents";
import type { DocumentPayloadCommand, DocumentPayloadRevision, DocumentPayloadTransaction, DocumentPayloadUnitOfWork, RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { AppliedResult, CommandResult, Operation, OutboxEvent, Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new DomainError("INVALID_COMMAND", "Unsupported command value");
  return result;
}

function requireWriter(principal: Principal, command: DocumentPayloadCommand): void {
  if (!principal.actorId || !principal.projectIds.includes(command.projectId) ||
    !principal.permissions.includes("write") || command.author !== principal.actorId)
    throw new DomainError("FORBIDDEN", "Project write permission and matching author are required");
}

function sameOperation(prior: Operation, actorId: string, hash: string): CommandResult {
  if (prior.actorId !== actorId || prior.commandHash !== hash)
    throw new DomainError("OPERATION_REUSED", "Operation ID was used for a different command");
  return prior.result;
}

const safePath = (value: string): boolean => value.length <= 240 && value !== "." && !value.startsWith("/") &&
  !value.includes("\\") && !value.includes("\0") && !value.includes("?") && !value.includes("#") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value);

function validate(command: DocumentPayloadCommand): void {
  if (!safePath(command.originalName) || command.originalName.includes("/")) throw new DomainError("INVALID_COMMAND", "Unsafe original filename");
  if (command.source.storage === "inline") {
    if (new TextEncoder().encode(command.source.body).length > 65536)
      throw new DomainError("INVALID_COMMAND", "Inline document exceeds 65536 UTF-8 bytes");
    if (command.format === "html" && /<\s*script\b|\bon[a-z]+\s*=|\bsrcdoc\s*=|\b(?:src|href|action)\s*=|@import\b|url\s*\(/i.test(command.source.body))
      throw new DomainError("INVALID_COMMAND", "Inline HTML must be self-contained and inert");
    return;
  }
  const source = command.source;
  if (source.entrypoint !== null && (!safePath(source.entrypoint) || command.format !== "html"))
    throw new DomainError("INVALID_COMMAND", "Unsafe bundle entrypoint");
  if (command.format === "html" && !source.entrypoint) throw new DomainError("INVALID_COMMAND", "HTML bundle requires an entrypoint");
  if (source.assets.length && source.entrypoint === null) throw new DomainError("INVALID_COMMAND", "Assets require a bundle entrypoint");
  const seen = new Set<string>();
  for (const asset of source.assets) {
    if (!safePath(asset.path) || seen.has(asset.path) || asset.blobId === source.payloadRef)
      throw new DomainError("INVALID_COMMAND", "Unsafe or duplicate asset path or blob ID");
    seen.add(asset.path);
  }
  if (source.entrypoint && seen.has(source.entrypoint)) throw new DomainError("INVALID_COMMAND", "Entrypoint duplicates asset path");
  if (new Set(source.assets.map((a) => a.blobId)).size !== source.assets.length)
    throw new DomainError("INVALID_COMMAND", "Duplicate asset blob ID");
}

export interface DocumentPayloadDependencies {
  blobs: BlobStore;
  uow: DocumentPayloadUnitOfWork;
  hashText(value: string): string;
  nextId(): string;
  now(): string;
}

/** Every external byte is verified and published before opening the database transaction. */
export async function importDocumentPayload(
  deps: DocumentPayloadDependencies, principal: Principal, input: unknown,
  bytesByBlobId: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<CommandResult> {
  const command = documentPayloadCommandSchema.parse(input);
  requireWriter(principal, command);
  const commandHash = deps.hashText(canonicalJson({ actorId: principal.actorId, command }));
  const prior = await deps.uow.read(command.projectId, reader => reader.getOperation(command.operationId));
  if (prior) return sameOperation(prior, principal.actorId, commandHash);
  try { validate(command); }
  catch (error) {
    if (error instanceof DomainError) return persistRejected(deps, principal, command, commandHash, error);
    throw error;
  }
  const registrations: RegisteredDocumentBlob[] = [];
  try { if (command.source.storage === "blob") {
    const source = command.source;
    const parts: Array<{ payload: BlobPayload; role: "main" | "asset"; path: string | null }> = [
      { payload: { id: source.payloadRef, projectId: command.projectId, contentHash: source.contentHash, size: source.size, mediaType: command.mediaType }, role: "main", path: null },
      ...source.assets.map((asset) => ({ payload: { id: asset.blobId, projectId: command.projectId, contentHash: asset.contentHash, size: asset.size, mediaType: asset.mediaType }, role: "asset" as const, path: asset.path })),
    ];
    for (const part of parts) {
      const bytes = bytesByBlobId.get(part.payload.id);
      if (!bytes || bytes.length !== part.payload.size)
        throw new DomainError("INVALID_COMMAND", "Missing or mismatched document resource bytes");
      let prepared;
      try { prepared = await deps.blobs.prepare(part.payload, bytes); }
      catch (error) {
        if (error instanceof Error && /hash or size mismatch/.test(error.message))
          throw new DomainError("INVALID_COMMAND", "Document resource hash or size mismatch");
        throw error;
      }
      if (!(await deps.blobs.verify(prepared))) throw new DomainError("INVALID_COMMAND", "Document resource failed verification");
      await deps.blobs.publish(prepared);
      registrations.push({ ...part.payload, documentId: command.documentId, revisionId: command.revisionId,
        role: part.role, relativePath: part.path });
    }
  }} catch (error) {
    if (error instanceof DomainError) return persistRejected(deps, principal, command, commandHash, error);
    throw error;
  }
  return deps.uow.transaction(command.projectId, async (tx) => {
    const existing = await tx.getOperation(command.operationId);
    if (existing) return sameOperation(existing, principal.actorId, commandHash);
    const createdAt = deps.now();
    let result: CommandResult;
    try {
      result = await tx.savepoint(() => applyDocumentPayload(tx, command, registrations, deps.hashText, createdAt));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      result = rejection(command.operationId, error);
    }
    await tx.insertOperation(operation(command, principal.actorId, commandHash, result, createdAt));
    if (result.status === "applied") await tx.appendOutbox(outbox(deps, command, result, createdAt));
    return result;
  });
}

function rejection(operationId: string, error: DomainError): CommandResult {
  return { status: "rejected", operationId, code: error.code, message: error.message,
    ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) };
}
function operation(command: DocumentPayloadCommand, actorId: string, commandHash: string,
  result: CommandResult, createdAt: string): Operation {
  return { projectId: command.projectId, id: command.operationId, actorId, commandHash,
    commandType: "document.payload", result, createdAt };
}
function outbox(deps: DocumentPayloadDependencies, command: DocumentPayloadCommand,
  result: AppliedResult, createdAt: string): OutboxEvent {
  return { projectId: command.projectId, id: deps.nextId(), operationId: command.operationId,
    effectKey: `${command.projectId}:document:${command.documentId}`, kind: "document",
    entityId: command.documentId, version: result.version!, createdAt };
}
async function persistRejected(deps: DocumentPayloadDependencies, principal: Principal,
  command: DocumentPayloadCommand, commandHash: string, error: DomainError): Promise<CommandResult> {
  return deps.uow.transaction(command.projectId, async (tx) => {
    const prior = await tx.getOperation(command.operationId);
    if (prior) return sameOperation(prior, principal.actorId, commandHash);
    const result = rejection(command.operationId, error);
    await tx.insertOperation(operation(command, principal.actorId, commandHash, result, deps.now()));
    return result;
  });
}

/** Called only after the coordinator has verified every external resource. */
async function applyDocumentPayload(
  tx: DocumentPayloadTransaction, command: DocumentPayloadCommand, registrations: RegisteredDocumentBlob[],
  hashText: (value: string) => string, now: string,
): Promise<AppliedResult> {
  const current = await tx.getDocument(command.documentId);
  if (command.mode === "create" && current) throw new DomainError("ALREADY_EXISTS", "Document already exists");
  if (command.mode === "revise" && !current) throw new DomainError("NOT_FOUND", "Document was not found");
  if (current?.kind === "task") throw new DomainError("TASK_CONTENT_OWNED", "Task content must be changed through task.update");
  if (current?.status === "archived") throw new DomainError("DOCUMENT_ARCHIVED", "Restore the document before revision");
  if (current && current.version !== command.expectedVersion)
    throw new DomainError("VERSION_CONFLICT", "Document changed since it was read", current.version);
  const kind = command.kind ?? current?.kind ?? null;
  if (current && command.kind !== undefined && command.kind !== current.kind &&
      !(command.kind === "organization_review" && (current.kind === "report" || current.kind === null)))
    throw new DomainError("INVALID_DOCUMENT_KIND", "Only an existing report can be classified as an organization review");
  const previous = current ? await tx.getDocumentPayloadRevision(current.id, current.currentRevisionId) : null;
  const organizationReview = reviewMetadata(kind, command.organizationReview, previous?.organizationReview);
  await validatePreviousReview(organizationReview, command.projectId, command.documentId,
    id => tx.getDocument(id), (id, revision) => tx.getDocumentPayloadRevision(id, revision));
  const source = command.source;
  const revision: DocumentPayloadRevision = {
    projectId: command.projectId, documentId: command.documentId, id: command.revisionId,
    previousRevisionId: current?.currentRevisionId ?? null, format: command.format, mediaType: command.mediaType,
    originalName: command.originalName, body: source.storage === "inline" ? source.body : null,
    payloadRef: source.storage === "blob" ? source.payloadRef : null,
    contentHash: source.storage === "inline" ? hashText(source.body) : source.contentHash,
    entrypoint: source.storage === "blob" ? source.entrypoint : null,
    assetsManifest: source.storage === "blob" ? source.assets : [],
    author: command.author, reason: command.reason, createdAt: now,
    ...(organizationReview ? { organizationReview } : {}),
  };
  if (!current) await tx.insertDocument({ projectId: command.projectId, id: command.documentId,
    title: command.title!, version: 1, currentRevisionId: command.revisionId, adoptedRevisionId: null,
    kind, status: "draft" });
  await tx.insertDocumentPayloadRevision(revision);
  for (const blob of registrations) await tx.registerDocumentBlob(blob);
  if (current) await tx.updateDocument({ ...current, kind, version: current.version + 1, currentRevisionId: command.revisionId }, current.version);
  return { status: "applied", operationId: command.operationId, entityId: command.documentId,
    revisionId: command.revisionId, version: current ? current.version + 1 : 1 };
}
