// Words and small decisions for the document list and the reader (docs/frontend/pages/documents.md). Pure, so the
// inner rail, the table, the reader and the right column say the same thing, and tests read them without a browser.
// Interface words follow docs/frontend/principles.md (界面用语): no implementation words, raw IDs only in the source layer.
import type { Document, DocumentDetail, DocumentKind, DocumentStatus, DocumentTaskReference, TaskState } from "@evoloop/contracts";
import type { StatusTone } from "@evoloop/ui";
import { parseRoute, type Section } from "../../shared/routes";
import type { Original } from "../../shared/ui/OriginalDocumentReader";

export const kindLabel: Record<DocumentKind, string> = {
  issue: "问题", spec: "规范", discussion: "讨论", report: "报告", organization_review: "组织复盘", task: "任务正文",
};
export const lifecycleLabel: Record<DocumentStatus, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
export const lifecycleTone: Record<DocumentStatus, StatusTone> = { draft: "idle", published: "done", archived: "history" };
export const relationLabel: Record<DocumentTaskReference["relations"][number], string> = {
  content: "任务正文", link: "已关联", basis: "固定依据",
};
export const taskStateLabel: Record<TaskState, string> = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
export const taskStateTone: Record<TaskState, StatusTone> = { todo: "idle", in_progress: "progress", done: "done", cancelled: "history" };
export const runStateLabel: Record<string, string> = {
  requested: "待派发", dispatching: "派发中", running: "运行中", completed: "运行结束", failed: "运行失败", interrupted: "已中断", unknown: "结果未知",
};

export type KindFilter = "all" | DocumentKind;
export type StatusFilter = "active" | DocumentStatus | "all";
export const statusFilterLabel: Record<StatusFilter, string> = {
  active: "未归档", draft: "草稿", published: "已发布", archived: "已归档", all: "全部状态",
};
/** Kinds a reader can filter by; 任务正文 is listed too, since task bodies are documents as well. */
export const kindFilters = Object.entries(kindLabel) as Array<[DocumentKind, string]>;

export const kindText = (kind: DocumentKind | null | undefined): string => kind ? kindLabel[kind] : "未分类";

/** How the current revision relates to the published one, for a list row or the version block. */
export function publicationText(document: Pick<Document, "status" | "currentRevisionId" | "adoptedRevisionId">): string {
  if (document.status === "draft" || !document.adoptedRevisionId) return "尚未发布";
  return document.currentRevisionId === document.adoptedRevisionId ? "当前与发布版一致" : "有未发布的修订";
}

/** The strongest reference a task holds on this document, said as a short label. */
export function referenceText(relations: readonly DocumentTaskReference["relations"][number][]): string {
  return relations.includes("basis") ? relationLabel.basis : relations.includes("content") ? relationLabel.content : relationLabel.link;
}

export interface ReadingStanding {
  /** Two to six words for the header: which version is on screen. */
  label: string;
  /** Not the current revision: the reader needs a way to the current one. */
  historical: boolean;
  /** A note that stays visible while reading, or null when there is nothing to warn about. */
  note: string | null;
}

/** Which version the reader is on: the fixed revision opened, compared with the current and the published one. */
export function readingStanding(revisionId: string, detail: Pick<DocumentDetail, "current" | "adopted">): ReadingStanding {
  const current = detail.current.id, adopted = detail.adopted?.id ?? null;
  if (revisionId === current) {
    if (adopted === current) return { label: "当前版 · 已发布", historical: false, note: null };
    return { label: "当前版 · 尚未发布", historical: false,
      note: adopted ? "这一版还没有发布，已发布的是较早一版；引用前请核对任务固定的依据。" : null };
  }
  if (revisionId === adopted) return { label: "已发布版 · 不是当前版", historical: true,
    note: "你在读已发布的那一版。当前版已更新但还没有发布，请核对任务实际采用的版本。" };
  return { label: "固定历史版", historical: true, note: "你在读固定的历史版本，当前版已更新。请核对任务实际采用的版本。" };
}

/** Where the Markdown text on screen comes from, or why there is none yet. */
export type MarkdownSource =
  | { state: "ready"; text: string }
  | { state: "reading" }
  | { state: "failed"; error: unknown }
  | { state: "unavailable"; reason: string };

/**
 * The text saved with the revision, else the text of its original (an uploaded file or an import saves only the
 * original). An original already read stays on screen when a later read fails.
 */
export function markdownSource(body: string | null, original: { data?: Original; error: unknown }): MarkdownSource {
  if (body !== null) return { state: "ready", text: body };
  if (original.data?.status === "available") return { state: "ready", text: original.data.body };
  if (original.data?.status === "unavailable") return { state: "unavailable", reason: original.data.reason };
  if (original.error) return { state: "failed", error: original.error };
  return { state: "reading" };
}

// Address rules: `/sessions?session=` is one agent (智能体); `/runtime`, with or without a session, is 分工与运行.
const sourceLabels: Partial<Record<Section, string>> = {
  documents: "文档列表", document: "文档", task: "任务", work: "任务列表", "create-task": "任务", inbox: "待我验收",
  sessions: "智能体", runtime: "分工与运行", knowledge: "知识空间", overview: "总览", schedules: "日程", evaluations: "评价",
  journey: "目标与阶段", discussions: "分工讨论", reviews: "组织复盘", roles: "职责", repository: "仓库规范",
};

/** What the return link goes back to, named for the reader (返回来源 · 任务). */
export function returnSourceLabel(path: string): string {
  const route = parseRoute(path);
  if (!route.projectId) return "项目列表";
  return sourceLabels[route.section] ?? "上一页";
}

/** What the list covers, so a search or filter never reads as the whole project when pages are still unread. */
export { coverageText } from "../../shared/listCoverage";

/** The empty list, distinguished by why it is empty. */
export function emptyListText({ filtered, more }: { filtered: boolean; more: boolean }): { title: string; reason: string } {
  if (filtered) return { title: "已载入范围没有匹配的文档",
    reason: more ? "还有后续页面没有读；载入更多才能确认全部结果，或清除筛选。" : "可以清除筛选或换个关键词。" };
  if (more) return { title: "这一页没有未归档的文档", reason: "还有后续页面没有读；载入更多才能确认。" };
  return { title: "还没有过程文档", reason: "工作中产生的方案、报告和讨论保存后会出现在这里。可以与负责的智能体确认下一份文档。" };
}
