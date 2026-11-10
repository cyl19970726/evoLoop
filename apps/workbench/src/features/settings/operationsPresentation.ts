// 结果未知的操作: which object the original operation was about, from its receipt alone. A receipt keeps one object ID
// (the command's discussion, task, goal, stage or document ID, in that order, else the project ID; app/App.tsx) and the
// command type; which kind of object the ID names follows from the type. Pure, so the page and its tests agree.
import type { ReactNode } from "react";

/** The page title: the same words as 待我处理 in the navigation and the narrow top bar (app/shell/spaces.ts). */
export const operationsTitle = "结果未知的操作";

/** The receipt fields this page reads. `actorId` is the identity that saved it, the one reading this page. */
export interface ReceiptFacts { actorId: string; projectId: string; taskId: string; operationId: string; commandType: string }

/** One saved receipt as app/App.tsx hands it to the page: the receipt itself and its check card (核对与同 ID 重试). */
export interface OperationItem { receipt: ReceiptFacts; check: ReactNode }

export type OriginKind = "task" | "document" | "goal" | "stage" | "discussion";
export type OriginArea = "agents" | "runtime" | "roles" | "schedules" | "evaluations" | "repository" | "work" | "documents" | "journey" | "discussions";

/**
 * Where the operation's object is: an object ID with the kinds it may be (read in order; the first that exists is it),
 * or only the area of the project when the receipt names no object (its ID is the project's).
 */
export type ReceiptOrigin =
  | { kind: "object"; id: string; candidates: readonly OriginKind[] }
  | { kind: "area"; area: OriginArea | null };

export const originKindLabel: Record<OriginKind, string> = { task: "任务", document: "文档", goal: "目标", stage: "阶段", discussion: "分工讨论" };
export const originAreaLabel: Record<OriginArea, string> = {
  agents: "智能体", runtime: "团队 › 分工与运行", roles: "团队 › 职责", schedules: "日程", evaluations: "评价与后果",
  repository: "仓库规范", work: "任务列表", documents: "过程文档", journey: "目标与阶段", discussions: "团队 › 分工讨论",
};
/** The kind of thing an area holds, for “回执没有记下是哪个…”. */
const areaThing: Record<OriginArea, string> = {
  agents: "智能体", runtime: "运行", roles: "职责", schedules: "日程", evaluations: "评价", repository: "来源",
  work: "任务", documents: "文档", journey: "目标或阶段", discussions: "讨论",
};

const startsWith = (type: string, ...prefixes: string[]) => prefixes.some(prefix => type.startsWith(prefix));

/** The kinds an object ID on a receipt of this command type may be, most likely first. */
export function originCandidates(commandType: string): readonly OriginKind[] {
  if (startsWith(commandType, "discussion.")) return ["discussion"];
  // stage.propose carries its goal and its stage; the goal is kept first.
  if (startsWith(commandType, "goal.") || commandType === "stage.propose") return ["goal"];
  if (startsWith(commandType, "stage.")) return ["stage"];
  if (startsWith(commandType, "document.")) return ["document"];
  // A formal decision names its process document, and the task when it was recorded from one.
  if (commandType === "reference.formal") return ["task", "document"];
  return ["task"];
}

/** The area a receipt that names only the project belongs to, or null when the type says nothing about it. */
export function originArea(commandType: string): OriginArea | null {
  if (startsWith(commandType, "session.", "runtime.session.", "runtime.run.")) return "agents";
  if (startsWith(commandType, "runtime.", "queue.")) return "runtime";
  if (startsWith(commandType, "role.", "host.")) return "roles";
  if (startsWith(commandType, "schedule.")) return "schedules";
  if (startsWith(commandType, "evaluation.")) return "evaluations";
  if (startsWith(commandType, "reference.")) return "repository";
  if (startsWith(commandType, "task.", "work.", "observation.", "delivery.")) return "work";
  if (startsWith(commandType, "document.")) return "documents";
  if (startsWith(commandType, "goal.", "stage.")) return "journey";
  if (startsWith(commandType, "discussion.")) return "discussions";
  return null;
}

export function receiptOrigin(receipt: ReceiptFacts): ReceiptOrigin {
  const id = receipt.taskId.trim();
  if (!id || id === receipt.projectId) return { kind: "area", area: originArea(receipt.commandType) };
  return { kind: "object", id, candidates: originCandidates(receipt.commandType) };
}

const projectPath = (projectId: string) => `/p/${encodeURIComponent(projectId)}`;
/** Where “返回” leads from the object: this page. */
export const operationsPath = (projectId: string) => `${projectPath(projectId)}/operations`;

/**
 * The object's address, carrying the way back to this page with the parameters the task and agent pages read for a
 * return (`return`, the identity it is for as `actor`, and `returnTitle`). The document page reads `return` as 返回来源;
 * a page that does not read them keeps the browser's own back.
 */
export function originHref(projectId: string, kind: OriginKind, id: string, actorId: string): string {
  const back = new URLSearchParams({ return: operationsPath(projectId), actor: actorId, returnTitle: operationsTitle });
  const key = encodeURIComponent(id);
  switch (kind) {
    case "task": return `${projectPath(projectId)}/tasks/${key}?${back}`;
    case "document": return `${projectPath(projectId)}/documents/${key}?${back}`;
    case "goal": return `${projectPath(projectId)}/journey?goal=${key}&${back}`;
    case "stage": return `${projectPath(projectId)}/journey?stage=${key}&${back}`;
    case "discussion": return `${projectPath(projectId)}/discussions?discussion=${key}&${back}`;
  }
}

const areaSection: Record<OriginArea, string> = {
  agents: "sessions", runtime: "runtime", roles: "roles", schedules: "schedules", evaluations: "evaluations",
  repository: "repository", work: "work", documents: "documents", journey: "journey", discussions: "discussions",
};
export const areaHref = (projectId: string, area: OriginArea) => `${projectPath(projectId)}/${areaSection[area]}`;

/** What reading the object found: its kind and name, or that it is not in this project, or that it could not be read. */
export type OriginRead =
  | { state: "reading" }
  | { state: "found"; kind: OriginKind; name: string }
  | { state: "missing" }
  | { state: "failed"; reason: string };

/** The sentence beside “打开原对象”. A missing object is said as such: a create whose result is unknown may not exist yet. */
export function originText(origin: ReceiptOrigin, read: OriginRead): string {
  if (origin.kind === "area") {
    if (!origin.area) return "回执只记下了项目，没有记下原操作所在的对象，无法判断该回到哪里。";
    return `回执只记下了项目，没有记下是哪个${areaThing[origin.area]}；可以到${originAreaLabel[origin.area]}核对。`;
  }
  const kinds = origin.candidates.map(kind => originKindLabel[kind]).join("或");
  switch (read.state) {
    case "reading": return `原操作所在：${kinds}（名称正在读取）`;
    case "found": return `原操作所在：${originKindLabel[read.kind]} · ${read.name}`;
    case "missing": return `在本项目里读不到这个${kinds}。如果原操作是新建，它可能还没有建立；先按操作 ID 核对。`;
    case "failed": return `原操作所在的${kinds}暂时读不到（${read.reason}），无法判断它现在的状态。`;
  }
}

/** The kind to link to: the one found, or the most likely one while reading or when the read failed. Null when missing. */
export function originLinkKind(origin: ReceiptOrigin, read: OriginRead): OriginKind | null {
  if (origin.kind === "area" || read.state === "missing") return null;
  return read.state === "found" ? read.kind : origin.candidates[0] ?? null;
}
