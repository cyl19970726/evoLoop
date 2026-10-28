import { idSchema } from "@evoloop/contracts";
import { documentImportSchema } from "@evoloop/contracts/process-documents";
import { z, knowledgeCandidateInputSchema, knowledgeOperationInputSchema, knowledgeReviewInputSchema } from "@evoloop/contracts/knowledge";
import { runtimeReconcileSchema } from "@evoloop/contracts/runtime";
import { ordinaryRunSubmissionSchema } from "@evoloop/contracts/ordinary-run-submission";
import { formalSourceDecisionSchema, registerGitReferenceSchema, taskExternalReferenceSchema } from "@evoloop/contracts/references";
import type { Intent, Recovery } from "./receipts.js";

export type RequestName =
  | "document.import"
  | "knowledge.propose" | "knowledge.review" | "knowledge.publish" | "knowledge.reconcile" | "knowledge.retract-source"
  | "reference.git-register" | "reference.formal-decide" | "reference.task-decide"
  | "runtime.reconcile" | "runtime.recover" | "ordinary.submit";

export class RequestInputError extends Error {
  readonly code = "INVALID_INPUT" as const;
  constructor(message: string) { super(message); this.name = "RequestInputError"; }
}

interface RequestHelp {
  name: RequestName;
  requiredBodyKeys: readonly string[];
  targetId: string | null;
  operationId: "body" | "localReceipt";
  recovery: Recovery["kind"];
}
const help: readonly RequestHelp[] = [
  { name: "document.import", requiredBodyKeys: ["command", "uploads", "command.projectId", "command.operationId", "command.documentId", "command.revisionId", "command.mode", "command.source"], targetId: null, operationId: "body", recovery: "core" },
  { name: "knowledge.propose", requiredBodyKeys: ["operationId", "knowledgeId", "candidateId", "candidateRevision", "expectedRevision", "title", "body", "pageType", "epistemicStatus", "sources"], targetId: null, operationId: "body", recovery: "candidate" },
  { name: "knowledge.review", requiredBodyKeys: ["candidateRevision", "contentHash", "expectedRevision", "decision", "reason"], targetId: "candidateId", operationId: "localReceipt", recovery: "candidate" },
  { name: "knowledge.publish", requiredBodyKeys: ["operationId"], targetId: "candidateId", operationId: "body", recovery: "publish" },
  { name: "knowledge.reconcile", requiredBodyKeys: [], targetId: "original publish operationId", operationId: "localReceipt", recovery: "publish" },
  { name: "knowledge.retract-source", requiredBodyKeys: ["operationId"], targetId: "process documentId", operationId: "body", recovery: "manual" },
  { name: "reference.git-register", requiredBodyKeys: ["operationId", "referenceId", "repositoryId", "path", "commit", "contentHash"], targetId: null, operationId: "body", recovery: "core" },
  { name: "reference.formal-decide", requiredBodyKeys: ["operationId", "decisionId", "gitReferenceId", "documentId", "documentRevisionId", "decision", "reason"], targetId: null, operationId: "body", recovery: "core" },
  { name: "reference.task-decide", requiredBodyKeys: ["operationId", "decisionId", "taskRevisionId", "expectedTaskVersion", "slotId", "expectedHeadVersion", "decision", "kind", "referenceId", "revision", "contentHash", "reason", "actionImpact"], targetId: "taskId", operationId: "body", recovery: "core" },
  { name: "runtime.reconcile", requiredBodyKeys: ["expectedVersion", "reason"], targetId: "runId", operationId: "localReceipt", recovery: "manual" },
  { name: "runtime.recover", requiredBodyKeys: [], targetId: null, operationId: "localReceipt", recovery: "manual" },
  { name: "ordinary.submit", requiredBodyKeys: ["projectId", "operationId", "submissionId", "runId", "taskId", "sessionId", "taskRevisionId", "runInputHash", "deliveryOperationId", "deliveryIntent"], targetId: null, operationId: "body", recovery: "ordinary" },
];
export function requestTypes(): unknown[] { return help.map(item => ({ ...item, requiredBodyKeys: [...item.requiredBodyKeys] })); }

const emptySchema = z.strictObject({});
const referenceGitBody = registerGitReferenceSchema.omit({ projectId: true, actorId: true });
const referenceFormalBody = formalSourceDecisionSchema.omit({ projectId: true, actorId: true });
// The source schema has a cross-field refinement, so Zod disallows .omit().
// Derive its route-body shape from the same fields; full validation below retains the refinement.
const { projectId: _projectField, actorId: _actorField, taskId: _taskField, ...referenceTaskShape } = taskExternalReferenceSchema.shape;
const referenceTaskBody = z.strictObject(referenceTaskShape);
function bodySchema(name: string) {
  switch (name as RequestName) {
    case "document.import": return documentImportSchema;
    case "knowledge.propose": return knowledgeCandidateInputSchema;
    case "knowledge.review": return knowledgeReviewInputSchema;
    case "knowledge.publish":
    case "knowledge.retract-source": return knowledgeOperationInputSchema;
    case "knowledge.reconcile":
    case "runtime.recover": return emptySchema;
    case "reference.git-register": return referenceGitBody;
    case "reference.formal-decide": return referenceFormalBody;
    case "reference.task-decide": return referenceTaskBody;
    case "runtime.reconcile": return runtimeReconcileSchema;
    case "ordinary.submit": return ordinaryRunSubmissionSchema;
    default: throw new RequestInputError(`Unsupported request ${name}; inspect request types`);
  }
}
export function requestSchema(name: string): unknown { return z.toJSONSchema(bodySchema(name)); }

function validateBody(name: string, value: unknown): void {
  const checked = bodySchema(name).safeParse(value);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const field = issue?.path.length ? issue.path.join(".") : "body";
    throw new RequestInputError(`${name}: invalid ${field} (${issue?.message ?? "schema mismatch"})`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RequestInputError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (key.startsWith("command.")) continue;
    if (!(key in value)) throw new RequestInputError(`${label} requires ${key}`);
  }
}
function scoped(value: Record<string, unknown>, projectId: string): void {
  if (value.projectId !== undefined && value.projectId !== projectId) throw new RequestInputError("Request projectId differs from route projectId");
  const command = value.command;
  if (command !== undefined && object(command, "command").projectId !== projectId)
    throw new RequestInputError("Nested command projectId differs from route projectId");
}
function optionalId(value: unknown, label: string): string {
  try { return idSchema.parse(value); } catch { throw new RequestInputError(`${label} must be a UUID`); }
}
function operation(value: Record<string, unknown>): string { return optionalId(value.operationId, "operationId"); }
function target(value: string | undefined, meaning: string | null): string | null {
  if (meaning === null) {
    if (value !== undefined) throw new RequestInputError("This request does not use --id");
    return null;
  }
  if (value === undefined) throw new RequestInputError(`This request requires --id (${meaning})`);
  return optionalId(value, meaning);
}
function localId(value: string | undefined): string {
  if (value === undefined) throw new RequestInputError("This request has no server operationId; provide --receipt UUID");
  return optionalId(value, "local receipt ID");
}
function noServerOperation(value: Record<string, unknown>): void {
  if ("operationId" in value) throw new RequestInputError("This endpoint has no server operationId; use --receipt UUID for local recovery");
}
function emptyBody(value: Record<string, unknown>): void {
  if (Object.keys(value).length) throw new RequestInputError("This endpoint accepts an empty JSON object only");
}
function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || !value[key]) throw new RequestInputError(`${key} must be a nonempty string`);
}
function requireNumber(value: Record<string, unknown>, key: string): void {
  if (!Number.isInteger(value[key]) || (value[key] as number) < 1) throw new RequestInputError(`${key} must be a positive integer`);
}

/** Route registry only: full business validation remains with the coordinator and core. */
export function prepareRequest(name: string, projectIdInput: string, bodyInput: unknown, targetId?: string, localReceiptId?: string): Intent {
  const projectId = optionalId(projectIdInput, "projectId");
  const spec = help.find(item => item.name === name);
  if (!spec) throw new RequestInputError(`Unsupported request ${name}; inspect request types`);
  const body = object(bodyInput, "Request body");
  scoped(body, projectId);
  const id = target(targetId, spec.targetId);
  if (name === "reference.task-decide" && body.taskId !== undefined && body.taskId !== id)
    throw new RequestInputError("Body taskId differs from route taskId");
  requireKeys(body, spec.requiredBodyKeys, name);
  if (spec.operationId === "body" && localReceiptId !== undefined) throw new RequestInputError("This request uses body.operationId, not --receipt");
  if (spec.operationId === "localReceipt") noServerOperation(body);
  validateBody(name, body);
  const serverOperationId = spec.operationId === "body" ? operation(name === "document.import" ? object(body.command, "command") : body) : null;
  const receiptId = serverOperationId ?? localId(localReceiptId);
  const base = `/api/projects/${projectId}`;
  let path: string;
  let recovery: Recovery;
  let confirmation: Intent["confirmation"];
  switch (name as RequestName) {
    case "document.import": {
      if (object(body.command, "command").projectId !== projectId) throw new RequestInputError("Import requires matching command project");
      path = `${base}/documents/import`; recovery = { kind: "core", path: `${base}/operations/${receiptId}` }; confirmation = "command";
      break;
    }
    case "knowledge.propose": {
      for (const key of ["knowledgeId", "candidateId", "candidateRevision"]) optionalId(body[key], key);
      requireString(body, "title"); requireString(body, "body");
      if (!Array.isArray(body.sources)) throw new RequestInputError("sources must be an array");
      path = `${base}/knowledge/candidates`; recovery = { kind: "candidate", path: `${base}/knowledge/candidates/${body.candidateId}` }; confirmation = "candidate";
      break;
    }
    case "knowledge.review": {
      noServerOperation(body);
      optionalId(body.candidateRevision, "candidateRevision"); requireString(body, "contentHash"); requireString(body, "reason");
      path = `${base}/knowledge/candidates/${id}/review`; recovery = { kind: "manual", path: `${base}/knowledge/candidates/${id}` }; confirmation = "review";
      break;
    }
    case "knowledge.publish": {
      path = `${base}/knowledge/candidates/${id}/publish`;
      recovery = { kind: "publish", path: `${base}/knowledge/operations/${receiptId}/reconcile` }; confirmation = "publish";
      break;
    }
    case "knowledge.reconcile": {
      noServerOperation(body); emptyBody(body);
      path = `${base}/knowledge/operations/${id}/reconcile`;
      recovery = { kind: "publish", path }; confirmation = "publish-reconcile";
      break;
    }
    case "knowledge.retract-source": {
      path = `${base}/knowledge/sources/${id}/retract`;
      recovery = { kind: "manual", path: `${base}/knowledge/sources/documents` }; confirmation = "ack";
      break;
    }
    case "reference.git-register": {
      const command = registerGitReferenceSchema.safeParse({ ...body, projectId, actorId: body.actorId ?? "authenticated actor" });
      if (!command.success) throw new RequestInputError(`Invalid fixed Git reference: ${command.error.issues[0]?.message ?? "schema mismatch"}`);
      path = `${base}/references/git`; recovery = { kind: "core", path: `${base}/operations/${receiptId}` }; confirmation = "command";
      break;
    }
    case "reference.formal-decide": {
      const command = formalSourceDecisionSchema.safeParse({ ...body, projectId, actorId: body.actorId ?? "authenticated actor" });
      if (!command.success) throw new RequestInputError(`Invalid formal source decision: ${command.error.issues[0]?.message ?? "schema mismatch"}`);
      path = `${base}/references/formal-decisions`; recovery = { kind: "core", path: `${base}/operations/${receiptId}` }; confirmation = "command";
      break;
    }
    case "reference.task-decide": {
      const command = taskExternalReferenceSchema.safeParse({ ...body, projectId, taskId: id, actorId: body.actorId ?? "authenticated actor" });
      if (!command.success) throw new RequestInputError(`Invalid task reference decision: ${command.error.issues[0]?.message ?? "schema mismatch"}`);
      path = `${base}/references/tasks/${id}/decisions`; recovery = { kind: "core", path: `${base}/operations/${receiptId}` }; confirmation = "command";
      break;
    }
    case "runtime.reconcile": {
      noServerOperation(body); requireNumber(body, "expectedVersion"); requireString(body, "reason");
      path = `${base}/runtime/runs/${id}/reconcile`;
      recovery = { kind: "manual", path: `${base}/runtime/runs/${id}/events` }; confirmation = "runtime-reconcile";
      break;
    }
    case "runtime.recover": {
      noServerOperation(body); emptyBody(body);
      path = `${base}/runtime/recover`; recovery = { kind: "manual", path: `${base}/runtime` }; confirmation = "runtime-recover";
      break;
    }
    case "ordinary.submit": {
      path = `${base}/ordinary-runs/submissions`;
      recovery = { kind: "ordinary", path: `${base}/ordinary-runs/operations/${receiptId}` };
      confirmation = "ack";
      break;
    }
  }
  return { projectId, id: receiptId,
    operationId: name === "knowledge.reconcile" ? id : serverOperationId,
    ...(id ? { targetId: id } : {}), kind: name, path: path!, body: bodyInput,
    recovery: recovery!, confirmation: confirmation! };
}
