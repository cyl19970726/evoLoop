import type {
  Command, CommandResult, Document, DocumentDetail, DocumentRevision,
  Impact, Operation, Page, Principal, Project, Task, TaskDetail, TaskRevision, BasisSet, Goal, GoalRevision, Stage, StageRevision, StageReview,
  DiscussionRecord, DiscussionEvent,
  EvaluationRevision, EvaluationAttempt, EvaluationAssessment, EvaluationConclusion, EvaluationSourceSignature, EvaluationFixedRef,
} from "@evoloop/contracts";

export interface Session {
  principal: Principal;
  capabilities: Record<string, boolean>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

export async function request<T>(token: string, path: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      signal: controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { if (response.ok) throw new ApiError(0, "响应不完整，操作结果尚未确认"); }
    if (!response.ok) {
      const details = body && typeof body === "object" ? body as { message?: unknown; error?: unknown } : {};
      const message = typeof details.message === "string" ? details.message : typeof details.error === "string" ? details.error : `请求失败（${response.status}）`;
      throw new ApiError(response.status, message, body);
    }
    if (body === null || body === undefined) throw new ApiError(0, "响应不完整，操作结果尚未确认");
    return body as T;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(0, "连接中断或超时，操作结果尚未确认");
  } finally { clearTimeout(timeout); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCommandResult(value: unknown, operationId: string): value is CommandResult {
  if (!isRecord(value) || value.operationId !== operationId) return false;
  return value.status === "applied" ? typeof value.entityId === "string"
    : value.status === "rejected" && typeof value.code === "string" && typeof value.message === "string";
}
function checkedCommandResult(value: unknown, operationId: string): CommandResult {
  if (!isCommandResult(value, operationId)) throw new ApiError(0, "操作响应无法核实，请按原操作 ID 查询结果");
  return value;
}
function checkedOperation(value: unknown, operationId: string): Operation {
  if (!isRecord(value) || value.id !== operationId || typeof value.projectId !== "string"
    || typeof value.actorId !== "string" || typeof value.commandType !== "string"
    || !isCommandResult(value.result, operationId)) throw new ApiError(0, "操作记录响应无法核实，请稍后用同一 ID 查询");
  return value as unknown as Operation;
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const key = (value: string) => encodeURIComponent(value);

export function api(token: string, timeoutMs = 15000) {
  const call = <T>(path: string, init?: RequestInit) => request<T>(token, path, timeoutMs, init);
  return {
    session: () => call<Session>("/api/session"),
    project: (p: string) => call<Project>(projectPath(p)),
    goals: (p: string, cursor?: string) => call<Page<Goal>>(`${projectPath(p)}/goals?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    goalRevisions: (p: string, id: string) => call<GoalRevision[]>(`${projectPath(p)}/goals/${key(id)}/revisions`),
    stageRevisions: (p: string, id: string) => call<StageRevision[]>(`${projectPath(p)}/stages/${key(id)}/revisions`),
    stages: (p: string) => call<Stage[]>(`${projectPath(p)}/stages`),
    stageReviews: (p: string, id: string) => call<StageReview[]>(`${projectPath(p)}/stages/${key(id)}/reviews`),
    discussions: (p: string, cursor?: string) => call<Page<DiscussionRecord>>(`${projectPath(p)}/discussions?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    discussion: (p: string, id: string) => call<DiscussionRecord>(`${projectPath(p)}/discussions/${key(id)}`),
    discussionEvents: (p: string, id: string) => call<DiscussionEvent[]>(`${projectPath(p)}/discussions/${key(id)}/events`),
    documents: (p: string, cursor?: string) => call<Page<Document>>(`${projectPath(p)}/documents?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    document: (p: string, id: string) => call<DocumentDetail>(`${projectPath(p)}/documents/${key(id)}`),
    documentRevision: (p: string, id: string, revision: string) => call<DocumentRevision>(`${projectPath(p)}/documents/${key(id)}/revisions/${key(revision)}`),
    tasks: (p: string, cursor?: string) => call<Page<Task>>(`${projectPath(p)}/tasks?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    task: (p: string, id: string) => call<TaskDetail>(`${projectPath(p)}/tasks/${key(id)}`),
    taskRevisions: (p: string, id: string) => call<Array<{ revision: TaskRevision; basis: BasisSet | null }>>(`${projectPath(p)}/tasks/${key(id)}/revisions`),
    taskRevision: (p: string, id: string, revision: string) => call<{ revision: TaskRevision; basis: BasisSet | null }>(`${projectPath(p)}/tasks/${key(id)}/revisions/${key(revision)}`),
    evaluations: (p: string, cursor?: string, taskId?: string, knowledgePageId?: string) => call<Page<EvaluationRevision>>(`${projectPath(p)}/evaluations?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}${taskId ? `&taskId=${key(taskId)}` : ""}${knowledgePageId ? `&knowledgePageId=${key(knowledgePageId)}` : ""}`),
    evaluation: (p: string, id: string, revision?: string) => call<{ revision: EvaluationRevision; revisions: EvaluationRevision[]; attempts: EvaluationAttempt[]; assessments: EvaluationAssessment[]; conclusions: EvaluationConclusion[] }>(`${projectPath(p)}/evaluations/${key(id)}${revision ? `?revision=${key(revision)}` : ""}`),
    evaluationSourceTask: (p: string, taskId: string) => call<{ sourceTaskRevisionId: string; sourceSignature: EvaluationSourceSignature }>(`${projectPath(p)}/evaluations/source-task/${key(taskId)}`),
    evaluationPacket: (p: string, id: string, revisionId: string, attemptId: string) => call<{ content: string; contentHash: string; manifestHash: string; builderVersion: string; sources: EvaluationFixedRef[] }>(`${projectPath(p)}/evaluations/${key(id)}/attempts/${key(attemptId)}/packet?revision=${key(revisionId)}`),
    impacts: (p: string) => call<Impact[]>(`${projectPath(p)}/impacts`),
    operation: async (p: string, id: string) => checkedOperation(await call<unknown>(`${projectPath(p)}/operations/${key(id)}`), id),
    command: async (command: Command) => checkedCommandResult(await call<unknown>("/api/commands", { method: "POST", body: JSON.stringify(command) }), command.operationId),
  };
}

/** Only navigate to this project's known hash routes or ordinary web URLs. */
export function safeArtifactHref(value: string, projectId: string): string | null {
  const reference = value.trim();
  if (reference.startsWith("#/p/")) {
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const knownRoute = new RegExp(`^#/p/([^/?#]+)/(?:overview|work|knowledge|(?:tasks|documents)/${uuid}(?:\\?revision=${uuid})?)$|^#/p/([^/?#]+)/knowledge\\?knowledgeId=${uuid}&knowledgeRevision=${uuid}$|^#/p/([^/?#]+)/evaluations/${uuid}\\?revision=${uuid}$`, "i");
    const match = knownRoute.exec(reference);
    if (!match) return null;
    try { return decodeURIComponent(match[1] ?? match[2] ?? match[3]!) === projectId ? reference : null; }
    catch { return null; }
  }
  try {
    const url = new URL(reference);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
    // Pilot artifacts may name another local frontend port. Keep this project's
    // valid fixed deep link in the authenticated workbench; preserve the original text.
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && ["/", "/app/"].includes(url.pathname) && !url.search && url.hash.startsWith("#/p/")) {
      const local = safeArtifactHref(url.hash, projectId);
      if (local) return local;
    }
    return url.href;
  } catch { return null; }
}

export function isUnconfirmed(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

const staleConflictCodes = new Set([
  "VERSION_CONFLICT", "BASELINE_CHANGED", "DOCUMENT_CHANGED", "DECISION_TARGET_CHANGED",
  "REVIEW_TARGET_CHANGED", "TARGET_CHANGED",
]);
/** A 409 can be a correct business refusal; only changed observed versions or pointers require readback. */
export function isStaleConflict(value: unknown): boolean {
  const code = value instanceof ApiError && isRecord(value.detail) ? value.detail.code : value;
  return typeof code === "string" && staleConflictCodes.has(code);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "暂时无法读取数据";
}
