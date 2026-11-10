// The three writes of Git 与外部来源登记 as commands for the shared command form (shared/command): registering a fixed
// Git file, recording how a formal document relates to a process revision, and deciding on a task's fixed external
// source. Each goes to its own reference route; the request body is exactly the fields that route takes (the
// coordinator adds the project, the task and the actor from the address and the signed-in identity), so the command's
// `type`, `projectId` and the receipt-only `taskId` never go into it. Pure, so the page and its tests agree.
import { formalSourceDecisionSchema, registerGitReferenceSchema, taskExternalReferenceSchema } from "@evoloop/contracts/references";
import { commitPattern, hashPattern } from "./referencePresentation";

/** The request body of each write, field by field (plus the operation ID). */
export const referenceBodyFields = {
  "reference.git": ["referenceId", "repositoryId", "path", "commit", "contentHash"],
  "reference.formal": ["decisionId", "gitReferenceId", "documentId", "documentRevisionId", "decision", "reason"],
  "reference.task": ["decisionId", "taskRevisionId", "expectedTaskVersion", "slotId", "expectedHeadVersion", "decision", "kind", "referenceId",
    "revision", "contentHash", "reason", "actionImpact"],
} as const;
export type ReferenceCommandType = keyof typeof referenceBodyFields;

const typeOf = (command: Record<string, unknown>): ReferenceCommandType => {
  const type = command.type as ReferenceCommandType;
  if (!Object.hasOwn(referenceBodyFields, type)) throw new Error("不是来源登记的写入。");
  return type;
};

/** What is sent for a built command: its route's fields and the operation ID, nothing else. */
export function referenceBody(command: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(referenceBodyFields[typeOf(command)].map(field => [field, command[field]])), operationId: command.operationId };
}

/** The route a built command is sent to. */
export function referencePath(command: Record<string, unknown>): string {
  const root = `/api/projects/${encodeURIComponent(String(command.projectId))}/references`;
  const type = typeOf(command);
  if (type === "reference.git") return `${root}/git`;
  if (type === "reference.formal") return `${root}/formal-decisions`;
  return `${root}/tasks/${encodeURIComponent(String(command.taskId))}/decisions`;
}

/** Checks a built command with the route's own schema, as the coordinator will read it. Throws when it does not fit. */
export function checkReferenceCommand(candidate: Record<string, unknown>, actorId: string): void {
  const type = typeOf(candidate);
  const read = { ...referenceBody(candidate), projectId: candidate.projectId, actorId };
  if (type === "reference.git") registerGitReferenceSchema.parse(read);
  else if (type === "reference.formal") formalSourceDecisionSchema.parse(read);
  else taskExternalReferenceSchema.parse({ ...read, taskId: candidate.taskId });
}

/** A text over the contract's limit is named with its length; it is never cut. */
function within(value: string, max: number, label: string): string {
  if (value.length > max) throw new Error(`${label}最多 ${max} 字，现在是 ${value.length} 字，请删减后再提交。`);
  return value;
}

export interface GitValues { repositoryId: string; path: string; commit: string; contentHash: string }

/** 登记 Git 固定来源. `taskId` only names the task on the recovery receipt. */
export function gitReferenceCommand(values: GitValues, ids: { referenceId: string; taskId?: string | undefined }): Record<string, unknown> {
  if (!values.repositoryId.trim() || !values.path.trim() || !commitPattern.test(values.commit) || !hashPattern.test(values.contentHash))
    throw new Error("请填写已登记仓库、相对路径、完整 commit 和原文 SHA-256。");
  return { type: "reference.git", referenceId: ids.referenceId, repositoryId: within(values.repositoryId.trim(), 4000, "仓库"),
    path: within(values.path.trim(), 1024, "相对路径"), commit: values.commit, contentHash: values.contentHash, ...ids.taskId ? { taskId: ids.taskId } : {} };
}

export interface FormalValues { gitReferenceId: string; documentId: string; documentRevisionId: string; decision: "adopted" | "rejected" | "incorporated"; reason: string }

/** 记录正式文档与过程文档的关系. */
export function formalDecisionCommand(values: FormalValues, ids: { decisionId: string; taskId?: string | undefined }): Record<string, unknown> {
  if (!values.gitReferenceId.trim() || !values.documentId.trim() || !values.documentRevisionId.trim() || !values.reason.trim())
    throw new Error("请填写固定 Git 引用、过程文档与修订，以及理由。");
  return { type: "reference.formal", decisionId: ids.decisionId, gitReferenceId: values.gitReferenceId.trim(), documentId: values.documentId.trim(),
    documentRevisionId: values.documentRevisionId.trim(), decision: values.decision, reason: within(values.reason.trim(), 4000, "理由"),
    ...ids.taskId ? { taskId: ids.taskId } : {} };
}

export interface TaskReferenceValues {
  slotId: string; headVersion: number; decision: "adopt" | "retain" | "replace"; kind: "git" | "wiki" | "run";
  referenceId: string; revision: string; contentHash: string; reason: string; actionImpact: string;
}

/**
 * 为当前任务修订采用外部依据. The task's version and revision are the ones recorded when the form opened (`seen`), never
 * the ones on screen when it is sent.
 */
export function taskReferenceCommand(values: TaskReferenceValues, seen: { taskVersion: number; revisionId: string },
  ids: { decisionId: string; taskId: string }): Record<string, unknown> {
  if (!values.referenceId.trim() || !values.revision.trim() || !hashPattern.test(values.contentHash) || !values.reason.trim() || !values.actionImpact.trim())
    throw new Error("请提供固定来源、采用理由和它将改变的实际行动。");
  return { type: "reference.task", taskId: ids.taskId, decisionId: ids.decisionId, taskRevisionId: seen.revisionId, expectedTaskVersion: seen.taskVersion,
    slotId: values.slotId, expectedHeadVersion: values.headVersion, decision: values.decision, kind: values.kind,
    referenceId: within(values.referenceId.trim(), 512, "固定引用"), revision: within(values.revision.trim(), 512, "固定版本"), contentHash: values.contentHash,
    reason: within(values.reason.trim(), 4000, "采用理由"), actionImpact: within(values.actionImpact.trim(), 4000, "会改变的实际行动") };
}
