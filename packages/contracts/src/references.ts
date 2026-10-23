import { z } from "zod";
import type { BasisSet, Document, Impact, Operation, OutboxEvent, Principal, Task, TaskRevision, RuntimeRunRecord, RuntimeSessionRecord } from "./index.js";
import type { RegisteredGitSource, DocumentPayloadRevision } from "./process-documents.js";

const id = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const note = z.string().trim().min(1).max(4000);
const fixed = { projectId: id, operationId: id, actorId: note };
export const registerGitReferenceSchema = z.strictObject({ ...fixed, referenceId: id,
  repositoryId: note, path: z.string().min(1).max(1024), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  contentHash: sha });
export type RegisterGitReference = z.infer<typeof registerGitReferenceSchema>;
export const formalSourceDecisionSchema = z.strictObject({ ...fixed, decisionId: id, gitReferenceId: id,
  documentId: id, documentRevisionId: id, decision: z.enum(["adopted", "rejected", "incorporated"]), reason: note });
export type FormalSourceDecisionCommand = z.infer<typeof formalSourceDecisionSchema>;
export type ExternalReferenceKind = "git" | "wiki" | "run";
export type ExternalReferenceDecision = "adopt" | "retain" | "replace";
export const taskExternalReferenceSchema = z.strictObject({ ...fixed, decisionId: id, taskId: id,
  taskRevisionId: id, expectedTaskVersion: z.number().int().positive(), slotId: id,
  expectedHeadVersion: z.number().int().nonnegative(), decision: z.enum(["adopt", "retain", "replace"]),
  kind: z.enum(["git", "wiki", "run"]), referenceId: z.string().min(1).max(512),
  revision: z.string().min(1).max(512), contentHash: sha,
  reason: note, actionImpact: note }).superRefine((value, ctx) => {
  if ((value.kind === "git" || value.kind === "run") && !id.safeParse(value.referenceId).success)
    ctx.addIssue({ code: "custom", path: ["referenceId"], message: "Git and Run reference IDs must be UUIDs" });
  if (value.kind === "run" && !id.safeParse(value.revision).success)
    ctx.addIssue({ code: "custom", path: ["revision"], message: "Run Task revision must be a UUID" });
});
export type TaskExternalReferenceCommand = z.infer<typeof taskExternalReferenceSchema>;
/** Trusted runner supplies only identity; the reference transaction resolves all authority itself. */
export interface StudyReferenceProvenance { declarationId: string; loopId: string; inboxId: string; sourceDecisionId: string }
export interface FormalSourceDecision {
  projectId: string; id: string; gitReferenceId: string; documentId: string; documentRevisionId: string;
  decision: "adopted" | "rejected" | "incorporated"; actorId: string; reason: string; createdAt: string;
}
export interface TaskExternalReferenceRecord {
  projectId: string; id: string; taskId: string; taskRevisionId: string; slotId: string; version: number;
  decision: ExternalReferenceDecision; kind: ExternalReferenceKind; referenceId: string; revision: string;
  contentHash: string; reason: string; actionImpact: string; actorId: string; createdAt: string;
  observedCurrentRevision: string; observedCurrentHash: string; observedCurrentValidity: "valid";
  studyProvenance?: StudyReferenceProvenance | null;
}
export interface TaskExternalReferenceHead { projectId: string; taskId: string; slotId: string; version: number; decisionId: string }
export interface ReferenceReader {
  getOperation(id: string): Promise<Operation | null>;
  getGitSourceRef(id: string): Promise<RegisteredGitSource | null>;
  getDocument(id: string): Promise<Document | null>;
  getDocumentPayloadRevision(documentId: string, revisionId: string): Promise<DocumentPayloadRevision | null>;
  getTask(id: string): Promise<Task | null>;
  getTaskRevision(taskId: string, revisionId: string): Promise<TaskRevision | null>;
  getRuntimeRun(id: string): Promise<RuntimeRunRecord | null>;
  getRuntimeSession(id: string): Promise<RuntimeSessionRecord | null>;
  listImpacts(taskId?: string): Promise<Impact[]>;
  getBasisSet(taskId: string, revisionId: string, basisSetId: string): Promise<BasisSet | null>;
  getTaskExternalHead(taskId: string, slotId: string): Promise<TaskExternalReferenceHead | null>;
  getTaskExternalSnapshot(taskId: string, taskRevisionId: string, slotId: string): Promise<TaskExternalReferenceRecord | null>;
  listTaskExternalSnapshot(taskId: string, taskRevisionId: string): Promise<TaskExternalReferenceRecord[]>;
  listTaskExternalReferences(taskId: string): Promise<TaskExternalReferenceRecord[]>;
  listFormalSourceDecisions(gitReferenceId: string): Promise<FormalSourceDecision[]>;
}
export interface ReferenceTransaction extends ReferenceReader {
  resolveStudyReferenceAuthority(provenance: StudyReferenceProvenance, targetTaskId: string,
    actorId: string): Promise<{source: TaskExternalReferenceRecord; declaringActorId: string} | null>;
  savepoint<T>(action: () => Promise<T>): Promise<T>;
  insertOperation(operation: Operation): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
  insertGitSourceRef(id: string, ref: RegisteredGitSource["ref"], state: RegisteredGitSource["state"], observedAt: string): Promise<void>;
  insertFormalSourceDecision(value: FormalSourceDecision): Promise<void>;
  insertTaskExternalDecision(value: TaskExternalReferenceRecord): Promise<void>;
  advanceTaskExternalHead(value: TaskExternalReferenceHead, expectedVersion: number): Promise<boolean>;
  insertTaskRevision(value: TaskRevision): Promise<void>;
  insertSealedBasisSet(value: BasisSet): Promise<void>;
  updateTask(value: Task, expectedVersion: number): Promise<void>;
}
export interface ReferenceUnitOfWork {
  read<T>(projectId: string, action: (reader: ReferenceReader) => Promise<T>): Promise<T>;
  transaction<T>(projectId: string, action: (tx: ReferenceTransaction) => Promise<T>): Promise<T>;
}
export function requireReferencePrincipal(principal: Principal, projectId: string, actorId: string, permission: "read" | "write" | "review"): void {
  if (!principal.actorId || principal.actorId !== actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes(permission))
    throw new Error("Project reference authority is unavailable");
}
