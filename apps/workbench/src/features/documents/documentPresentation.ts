// Words and small decisions for the document list and the reader (docs/frontend/pages/documents.md). Pure, so the
// inner rail, the table, the reader and the right column say the same thing, and tests read them without a browser.
// Interface words follow docs/frontend/principles.md (界面用语): no implementation words, raw IDs only in the source layer.
import type { Document, DocumentDetail, DocumentKind, DocumentListKind, DocumentStatus, DocumentTaskReference, TaskState } from "@evoloop/contracts";
import type { StatusTone } from "@evoloop/ui";
import { returnPlaceOf, type ReturnPlace } from "../../shared/returnLink";
import type { Original } from "../../shared/ui/OriginalDocumentReader";

export const kindLabel: Record<DocumentKind, string> = {
  issue: "问题", spec: "规范", discussion: "讨论", report: "报告", organization_review: "复盘", task: "任务正文", brief: "简报",
};
export const lifecycleLabel: Record<DocumentStatus, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
export const lifecycleTone: Record<DocumentStatus, StatusTone> = { draft: "idle", published: "done", archived: "history" };
export const relationLabel: Record<DocumentTaskReference["relations"][number], string> = {
  content: "任务正文", link: "已关联", basis: "固定依据", delivery: "交付物", origin: "产出的文档",
};
export const taskStateLabel: Record<TaskState, string> = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
export const taskStateTone: Record<TaskState, StatusTone> = { todo: "idle", in_progress: "progress", done: "done", cancelled: "history" };
export const runStateLabel: Record<string, string> = {
  requested: "待派发", dispatching: "派发中", running: "运行中", completed: "运行结束", failed: "运行失败", interrupted: "已中断", unknown: "结果未知",
};

/**
 * The run a document came from, as the reader says it: produced by one run, when it started and where it stands. The
 * run's identifier stays in 完整标识; until the run is read back and matches, only that a run was registered is said.
 */
export function originRunSummary(run: { createdAt: string; state: string } | null | undefined, reading: boolean, time: (iso: string) => string): string {
  if (!run) return `由一次登记的运行产生 · ${reading ? "正在核对" : "未能核实"}`;
  return `由一次运行产生 · 开始于 ${time(run.createdAt)} · ${runStateLabel[run.state] ?? "状态未识别"}`;
}

export type KindFilter = "all" | DocumentListKind;
export type StatusFilter = "active" | DocumentStatus | "all";
export const statusFilterLabel: Record<StatusFilter, string> = {
  active: "未归档", draft: "草稿", published: "已发布", archived: "已归档", all: "全部状态",
};
/**
 * What a reader can filter the list by, in this order after 全部类型. 交付报告 and 其他报告 are not stored kinds: the server reads
 * them from the Deliveries (a document a Task's Delivery names as its artifact, and a report that is not one).
 */
export const kindFilters: Array<[Exclude<KindFilter, "all">, string]> = [
  ["brief", "简报"], ["organization_review", "复盘"], ["delivery_report", "交付报告"], ["task", "任务正文"], ["spec", "规范"],
  ["discussion", "讨论"], ["issue", "问题"], ["other_report", "其他报告"],
];
export const isKindFilter = (value: string | null | undefined): value is KindFilter => value === "all" || kindFilters.some(([key]) => key === value);
export const isStatusFilter = (value: string | null | undefined): value is StatusFilter => !!value && value in statusFilterLabel;

/** The list conditions as an address query (only what differs from the default), so a refresh, back and a shared link keep them. */
export function listQuery(state: { query: string; kind: KindFilter; status: StatusFilter }): string {
  const params = new URLSearchParams();
  if (state.kind !== "all") params.set("kind", state.kind);
  if (state.status !== "active") params.set("status", state.status);
  if (state.query.trim()) params.set("q", state.query.trim());
  return params.toString();
}
/** The conditions an address names; missing or unknown values are the defaults. `named` tells whether it named any at all. */
export function listConditionsFrom(search: string): { kind: KindFilter; status: StatusFilter; query: string; named: boolean } {
  const params = new URLSearchParams(search);
  const kind = params.get("kind"), status = params.get("status"), query = params.get("q");
  return { kind: isKindFilter(kind) ? kind : "all", status: isStatusFilter(status) ? status : "active", query: query?.slice(0, 200) ?? "",
    named: params.has("kind") || params.has("status") || params.has("q") };
}

export const kindText = (kind: DocumentKind | null | undefined): string => kind ? kindLabel[kind] : "未分类";

/** How the current revision relates to the published one, for a list row or the version block. */
export function publicationText(document: Pick<Document, "status" | "currentRevisionId" | "adoptedRevisionId">): string {
  if (document.status === "draft" || !document.adoptedRevisionId) return "尚未发布";
  return document.currentRevisionId === document.adoptedRevisionId ? "当前与发布版一致" : "有未发布的修订";
}

/** The strongest reference a task holds on this document, said as a short label. */
export function referenceText(relations: readonly DocumentTaskReference["relations"][number][]): string {
  for (const relation of ["delivery", "origin", "basis", "content"] as const) if (relations.includes(relation)) return relationLabel[relation];
  return relationLabel.link;
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

/**
 * Where the reader's way back goes, as a place the link names (返回任务：<名称>, 返回智能体：<名称>, 返回总览 …;
 * shared/returnLink.ts). An address that is not a page of this project goes back to the document list.
 */
export function documentReturnPlace(path: string, projectId: string): { href: string; place: ReturnPlace } {
  const place = returnPlaceOf(path, projectId);
  return place ? { href: path, place } : { href: `/p/${projectId}/documents`, place: { kind: "page", section: "documents" } };
}

/** What the list covers, so a search or filter never reads as the whole project when pages are still unread. */
export { coverageText } from "../../shared/listCoverage";

/** The empty list, distinguished by why it is empty. The server filters and searches every document, so an empty answer is complete. */
export function emptyListText({ filtered }: { filtered: boolean }): { title: string; reason: string } {
  if (filtered) return { title: "没有符合条件的文档", reason: "已在全部文档里查过；可以清除筛选或换个关键词。" };
  return { title: "还没有过程文档", reason: "工作中产生的方案、报告和讨论保存后会出现在这里。可以与负责的智能体确认下一份文档。" };
}
