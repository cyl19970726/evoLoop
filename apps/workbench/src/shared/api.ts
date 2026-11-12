import type {
  Command, CommandResult, Document, DocumentDetail, DocumentRevision, DocumentRevisionPage, DocumentStatusFilter,
  Impact, Operation, Page, Principal, Project, Task, TaskDetail, TaskRevision, BasisSet, DocumentTaskReference, Goal, GoalRevision, Stage, StageRevision, StageReview,
  DiscussionRecord, DiscussionEvent,
  EvaluationRevision, EvaluationAttempt, EvaluationAssessment, EvaluationConclusion, EvaluationSourceSignature, EvaluationFixedRef,
  TaskTimingView,
  TaskTimingSeriesPage,
} from "@evoloop/contracts";
export type { TaskTimingView, TaskTimingSeriesSummary, TaskTimingSeriesPage } from "@evoloop/contracts";
export type { DocumentRevisionPage, DocumentRevisionState, DocumentRevisionSummary } from "@evoloop/contracts";
import type { WorkTaskStatus } from "./workStatusPresentation";
import { reportUnauthorized, requestAuth } from "./identity";
import { describeError } from "./errorPresentation";
export { errorCode, errorDiagnostic } from "./errorPresentation";
import type {
  LeaderWorkChangesPage, LeaderWorkDependenciesCommand, LeaderWorkDocument, LeaderWorkPage,
  LeaderWorkPlanCommand, LeaderWorkReviewCommand, LeaderWorkTask,
} from "@evoloop/contracts/work-index";
import type { ProviderHoldListing } from "@evoloop/contracts/provider-hold";
import type { ProjectCapabilitiesView, ProjectMembersView, ProjectRepositoriesView } from "@evoloop/contracts/project-configuration";
export type {
  ProjectCapabilitiesView, ProjectCapability, ProjectMember, ProjectMembersView, ProjectRepositoriesView, ProjectRepository,
} from "@evoloop/contracts/project-configuration";

export interface Session {
  principal: Principal;
  capabilities: Record<string, boolean>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

async function requestJson<T>(token: string, path: string, timeoutMs: number, init?: RequestInit, allowNull = false): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const auth = requestAuth(token);
    const response = await fetch(path, {
      ...init,
      credentials: auth.credentials,
      headers: { ...auth.headers, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { if (response.ok) throw new ApiError(0, "响应不完整，操作结果尚未确认"); }
    if (response.status === 401) reportUnauthorized();
    if (!response.ok) {
      const details = body && typeof body === "object" ? body as { message?: unknown; error?: unknown } : {};
      const message = typeof details.message === "string" ? details.message : typeof details.error === "string" ? details.error : `请求失败（${response.status}）`;
      throw new ApiError(response.status, message, body);
    }
    if ((body === null && !allowNull) || body === undefined) throw new ApiError(0, "响应不完整，操作结果尚未确认");
    return body as T;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(0, "连接中断或超时，操作结果尚未确认");
  } finally { clearTimeout(timeout); }
}

export function request<T>(token: string, path: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  return requestJson<T>(token, path, timeoutMs, init);
}

/** Only opt-in GET endpoints whose contract explicitly permits JSON null use this. */
export function requestNullable<T>(token: string, path: string, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  return requestJson<T | null>(token, path, timeoutMs, { signal }, true);
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
    || typeof value.commandHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.commandHash)
    || !isCommandResult(value.result, operationId)) throw new ApiError(0, "操作记录响应无法核实，请稍后用同一 ID 查询");
  return value as unknown as Operation;
}

/** A project configuration view must be about the project asked for, and say whether it is available. */
function checkedProjectView<T extends { projectId: string; status: string }>(value: unknown, projectId: string): T {
  if (!isRecord(value) || value.projectId !== projectId
    || !(value.status === "available" ? Array.isArray(value.items) : value.status === "unavailable" && typeof value.reason === "string"))
    throw new ApiError(0, "项目配置响应与所选项目不符；请重新读取。");
  return value as T;
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const key = (value: string) => encodeURIComponent(value);

/** Server API. Without a token argument requests use the signed-in identity (shared/identity.ts). */
export function api(token = "", timeoutMs = 15000) {
  const call = <T>(path: string, init?: RequestInit) => request<T>(token, path, timeoutMs, init);
  const leaderWrite = async <T extends { operationId: string }>(path: string, command: T & { type?: string }): Promise<CommandResult> => {
    const body = { ...command } as Record<string, unknown>;
    delete body.type;
    return checkedCommandResult(await call<unknown>(path, { method: "PUT", body: JSON.stringify(body) }), command.operationId);
  };
  return {
    session: () => call<Session>("/api/session"),
    project: (p: string) => call<Project>(projectPath(p)),
    providerHolds: (p: string) => call<ProviderHoldListing>(`${projectPath(p)}/runtime/provider-holds`),
    /** Repositories configured for this project; `unavailable` is not "none". */
    projectRepositories: async (p: string) => checkedProjectView<ProjectRepositoriesView>(await call<unknown>(`${projectPath(p)}/repositories`), p),
    /** Capabilities judged for this project, or marked as one setting for the whole service. */
    projectCapabilities: async (p: string) => checkedProjectView<ProjectCapabilitiesView>(await call<unknown>(`${projectPath(p)}/capabilities`), p),
    /** This project's member identities and permissions; `unavailable` when the host has no member source. */
    projectMembers: async (p: string) => checkedProjectView<ProjectMembersView>(await call<unknown>(`${projectPath(p)}/members`), p),
    goals: (p: string, cursor?: string) => call<Page<Goal>>(`${projectPath(p)}/goals?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    goalRevisions: (p: string, id: string) => call<GoalRevision[]>(`${projectPath(p)}/goals/${key(id)}/revisions`),
    stageRevisions: (p: string, id: string) => call<StageRevision[]>(`${projectPath(p)}/stages/${key(id)}/revisions`),
    stages: (p: string) => call<Stage[]>(`${projectPath(p)}/stages`),
    /** The deployed version (public: no login): commit, build time and process start time. */
    version: (signal?: AbortSignal) => call<import("@evoloop/contracts/milestones").VersionInfo>("/api/version", { signal }),
    /** The roadmap phases with the status and date of the stage linked to each. */
    milestones: (p: string, signal?: AbortSignal) => call<import("@evoloop/contracts/milestones").MilestonesView>(`${projectPath(p)}/milestones`, { signal }),
    stageReviews: (p: string, id: string) => call<StageReview[]>(`${projectPath(p)}/stages/${key(id)}/reviews`),
    discussions: (p: string, cursor?: string, kind?: DiscussionRecord["kind"]) => call<Page<DiscussionRecord>>(`${projectPath(p)}/discussions?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}${kind ? `&kind=${key(kind)}` : ""}`),
    discussion: (p: string, id: string) => call<DiscussionRecord>(`${projectPath(p)}/discussions/${key(id)}`),
    discussionEvents: (p: string, id: string) => call<DiscussionEvent[]>(`${projectPath(p)}/discussions/${key(id)}/events`),
    documents: (p: string, cursor?: string, kind?: Document["kind"], status?: DocumentStatusFilter, signal?: AbortSignal) =>
      call<Page<Document>>(`${projectPath(p)}/documents?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}${kind ? `&kind=${key(kind)}` : ""}${status ? `&status=${key(status)}` : ""}`, { signal }),
    document: (p: string, id: string) => call<DocumentDetail>(`${projectPath(p)}/documents/${key(id)}`),
    documentTasks: (p: string, id: string, cursor?: string, signal?: AbortSignal) => call<Page<DocumentTaskReference>>(
      `${projectPath(p)}/documents/${key(id)}/tasks?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`, { signal }),
    documentRevision: (p: string, id: string, revision: string) => call<DocumentRevision>(`${projectPath(p)}/documents/${key(id)}/revisions/${key(revision)}`),
    /**
     * Newest-first revision metadata without bodies (limit 1..100, server default 50); pass nextCursor back
     * unchanged. Item numbers never change, but current/published are only true for the `document` head of
     * the page that carried them: after loading another page, recompute every loaded item's state from the
     * newest page's `document`, and when `document.version` differs from the first page, say so and offer to
     * reload from the first page (newer revisions sit above it).
     */
    documentRevisions: (p: string, id: string, page: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
      call<DocumentRevisionPage>(`${projectPath(p)}/documents/${key(id)}/revisions?limit=${page.limit ?? 50}${
        page.cursor ? `&cursor=${key(page.cursor)}` : ""}`, signal ? { signal } : undefined),
    tasks: (p: string, cursor?: string, signal?: AbortSignal) => call<Page<Task>>(`${projectPath(p)}/tasks?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`, signal ? { signal } : undefined),
    workStatuses: (p: string, taskIds: string[], signal?: AbortSignal) => call<{items: WorkTaskStatus[]}>(
      `${projectPath(p)}/orchestration/work-status?taskIds=${taskIds.map(key).join(",")}`, signal ? { signal } : undefined),
    leaderWork: (p: string, view: "tasks" | "documents", cursor?: string, includeClosed = false, signal?: AbortSignal) =>
      call<LeaderWorkPage<LeaderWorkTask | LeaderWorkDocument>>(
        `${projectPath(p)}/work-management/index?view=${view}&limit=50${cursor ? `&cursor=${key(cursor)}` : ""}${includeClosed ? "&includeClosed=true" : ""}`, { signal }),
    leaderTask: (p: string, id: string) => call<LeaderWorkTask>(
      `${projectPath(p)}/work-management/tasks/${key(id)}`),
    acceptanceRelay: (p: string, id: string) => call<{ items: import("@evoloop/contracts/acceptance-relay").AcceptanceRelayView[] }>(
      `${projectPath(p)}/tasks/${key(id)}/acceptance-relay`),
    acceptanceOverview: (p: string, cursor?: string) => call<import("@evoloop/contracts/acceptance-relay").AcceptanceOverviewView>(
      `${projectPath(p)}/acceptance-relay/overview?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    acceptanceMine: (p: string) => call<{ items: import("@evoloop/contracts/acceptance-relay").AcceptanceHumanItem[] }>(
      `${projectPath(p)}/acceptance-relay/mine`),
    leaderPlan: (p: string, id: string, command: LeaderWorkPlanCommand & { type?: string }) =>
      leaderWrite(`${projectPath(p)}/work-management/tasks/${key(id)}/plan`, command),
    leaderDependencies: (p: string, id: string, command: LeaderWorkDependenciesCommand & { type?: string }) =>
      leaderWrite(`${projectPath(p)}/work-management/tasks/${key(id)}/dependencies`, command),
    leaderReview: (p: string, id: string, command: LeaderWorkReviewCommand & { type?: string }) =>
      leaderWrite(`${projectPath(p)}/work-management/tasks/${key(id)}/review`, command),
    leaderWorkChanges: (p: string, cursor?: string, limit = 100) => call<LeaderWorkChangesPage>(
      `${projectPath(p)}/work-management/changes?limit=${limit}${cursor ? `&cursor=${key(cursor)}` : ""}`),
    leaderNotices: (p: string, taskId: string, cursor?: string) => call<import("@evoloop/contracts/leader-notices").LeaderNoticePage>(
      `${projectPath(p)}/work-management/notices?taskId=${key(taskId)}&limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    task: (p: string, id: string) => call<TaskDetail>(`${projectPath(p)}/tasks/${key(id)}`),
    taskTiming: async (p: string, id: string) => {
      const timing = await requestNullable<TaskTimingView>(token, `${projectPath(p)}/tasks/${key(id)}/timing`, timeoutMs);
      if (timing && (timing.projectId !== p || timing.taskId !== id || typeof timing.rootTaskId !== "string" || !timing.rootTaskId
        || !Number.isSafeInteger(timing.version) || timing.version < 1
        || !timing.futureTemplate || ![timing.futureTemplate.title, timing.futureTemplate.content, timing.futureTemplate.acceptance].every(value => typeof value === "string" && value.trim())
        || !Array.isArray(timing.occurrences) || timing.occurrences.some(item => typeof item.taskId !== "string")))
        throw new ApiError(0, "执行时间响应与所选任务不符；请重新读取。");
      return timing;
    },
    /** The project's timed Tasks (one-time and daily series, stopped included), a page at a time. */
    taskTimings: async (p: string, cursor?: string, signal?: AbortSignal) => {
      const page = await requestJson<TaskTimingSeriesPage>(token, `${projectPath(p)}/task-timings?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`, timeoutMs, { signal });
      if (!page || !Array.isArray(page.items) || page.items.some(item => item.projectId !== p || typeof item.seriesId !== "string" || typeof item.rootTaskId !== "string" || !item.latestTask || typeof item.latestTask.taskId !== "string"))
        throw new ApiError(0, "定时任务响应与当前项目不符；请重新读取。");
      return page;
    },
    /** Drain mode: instance-wide state of the release gate (not project scoped). */
    instanceDrain: (signal?: AbortSignal) => requestJson<import("@evoloop/contracts/instance-drain").InstanceDrainView>(token, "/api/instance/drain", timeoutMs, { signal }),
    taskRevisions: (p: string, id: string) => call<Array<{ revision: TaskRevision; basis: BasisSet | null }>>(`${projectPath(p)}/tasks/${key(id)}/revisions`),
    taskRevision: (p: string, id: string, revision: string) => call<{ revision: TaskRevision; basis: BasisSet | null }>(`${projectPath(p)}/tasks/${key(id)}/revisions/${key(revision)}`),
    evaluations: (p: string, cursor?: string, taskId?: string, knowledgePageId?: string) => call<Page<EvaluationRevision>>(`${projectPath(p)}/evaluations?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}${taskId ? `&taskId=${key(taskId)}` : ""}${knowledgePageId ? `&knowledgePageId=${key(knowledgePageId)}` : ""}`),
    evaluation: (p: string, id: string, revision?: string) => call<{ revision: EvaluationRevision; revisions: EvaluationRevision[]; attempts: EvaluationAttempt[]; assessments: EvaluationAssessment[]; conclusions: EvaluationConclusion[] }>(`${projectPath(p)}/evaluations/${key(id)}${revision ? `?revision=${key(revision)}` : ""}`),
    evaluationSourceTask: (p: string, taskId: string) => call<{ sourceTaskRevisionId: string; sourceSignature: EvaluationSourceSignature }>(`${projectPath(p)}/evaluations/source-task/${key(taskId)}`),
    evaluationPacket: (p: string, id: string, revisionId: string, attemptId: string) => call<{ content: string; contentHash: string; manifestHash: string; builderVersion: string; sources: EvaluationFixedRef[] }>(`${projectPath(p)}/evaluations/${key(id)}/attempts/${key(attemptId)}/packet?revision=${key(revisionId)}`),
    impacts: (p: string) => call<Impact[]>(`${projectPath(p)}/impacts`),
    usageOverview: (p: string, day: string) => call<import("@evoloop/contracts").UsageOverview>(`${projectPath(p)}/runtime/usage?from=${day}&to=${day}`),
    decisionsForMe: (p: string) => call<import("@evoloop/contracts/decision-requests").DecisionsForMe>(`${projectPath(p)}/decisions-for-me`),
    operation: async (p: string, id: string) => checkedOperation(await call<unknown>(`${projectPath(p)}/operations/${key(id)}`), id),
    command: async (command: Command) => checkedCommandResult(await call<unknown>("/api/commands", { method: "POST", body: JSON.stringify(command) }), command.operationId),
  };
}

/** Only navigate to this project's known routes or ordinary web URLs. */
export function safeArtifactHref(value: string, projectId: string): string | null {
  const reference = value.trim();
  // Stored references use the former `#/p/…` form; path links are accepted too. Both open as a path.
  if (reference.startsWith("#/p/") || reference.startsWith("/p/")) {
    const route = reference.startsWith("#") ? reference.slice(1) : reference;
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const knownRoute = new RegExp(`^/p/([^/?#]+)/(?:overview|work|knowledge|(?:tasks|documents)/${uuid}(?:\\?revision=${uuid})?)$|^/p/([^/?#]+)/knowledge\\?knowledgeId=${uuid}&knowledgeRevision=${uuid}$|^/p/([^/?#]+)/evaluations/${uuid}\\?revision=${uuid}$`, "i");
    const match = knownRoute.exec(route);
    if (!match) return null;
    try { return decodeURIComponent(match[1] ?? match[2] ?? match[3]!) === projectId ? route : null; }
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
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname.startsWith("/p/") && !url.hash) {
      const local = safeArtifactHref(`${url.pathname}${url.search}`, projectId);
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
  "REVIEW_TARGET_CHANGED", "TARGET_CHANGED", "WORK_INDEX_CHANGED",
]);
/** A 409 can be a correct business refusal; only changed observed versions or pointers require readback. */
export function isStaleConflict(value: unknown): boolean {
  const code = value instanceof ApiError && isRecord(value.detail) ? value.detail.code : value;
  return typeof code === "string" && staleConflictCodes.has(code);
}

/**
 * What went wrong, in Chinese, for the body of a page (shared/errorPresentation.ts): a known service code in words, a
 * Chinese answer as it is, anything else as a general sentence. No closing period. The original answer is
 * `errorDetail` (for an expandable 诊断信息) and `errorDiagnostic` (for a layer that is diagnostic already).
 */
export function errorText(error: unknown): string {
  return describeError(error).text;
}

/** The original answer when `errorText` replaced it, else null. */
export function errorDetail(error: unknown): string | null {
  return describeError(error).detail;
}
