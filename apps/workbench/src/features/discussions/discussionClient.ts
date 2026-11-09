// Reads for the 分工讨论 page. They run without a token argument (the signed-in identity) and check that every
// answer belongs to the project and object that was asked for.
import type { DiscussionEvent, DiscussionRecord, Document, DocumentDetail, DocumentRevision, Goal, Page, Stage, Task } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { api, request } from "../../shared/api";
import { roleClient } from "../../shared/roleClient";
import type { VerifiedDocumentHead } from "./commands";

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const get = <T>(path: string, signal?: AbortSignal) => request<T>("", path, 15000, { signal });

export type Choices = { goals: Goal[]; stages: Stage[]; tasks: Task[]; documents: Document[]; roles: RoleRecord[] };

/** Every page of a list, up to 1000 items; past that the list cannot be offered completely and the read fails. */
async function complete<T>(label: string, load: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const values: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    values.push(...page.items);
    if (values.length > 1000 || (values.length === 1000 && page.nextCursor))
      throw new Error(`${label}超过 1000 项，无法完整提供选择；请缩小项目范围。`);
    if (!page.nextCursor) return values;
    if (seen.has(page.nextCursor)) throw new Error(`${label}分页游标重复，无法确认清单完整。`);
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}

/** Goals, stages, tasks, documents and roles: what a discussion can fix and what a decision can link to. */
export async function readChoices(projectId: string): Promise<Choices> {
  const client = api(), roles = roleClient("", projectId);
  const [goals, stages, tasks, documents, roleItems] = await Promise.all([
    complete("目标", cursor => client.goals(projectId, cursor)),
    client.stages(projectId),
    complete("任务", cursor => client.tasks(projectId, cursor)),
    complete("过程文档", cursor => client.documents(projectId, cursor)),
    complete("职责", cursor => roles.list(cursor)),
  ]);
  if ([...goals, ...stages, ...tasks, ...documents, ...roleItems].some(item => item.projectId !== projectId))
    throw new Error("选择清单里有其他项目的对象");
  return { goals, stages, tasks, documents, roles: roleItems };
}

export interface DiscussionList { scope: string; items: DiscussionRecord[]; nextCursor: string | null }

/** The first `pages` pages of one list scope; `scope` travels with the answer so a stale scope is never shown as current. */
export async function readDiscussions(projectId: string, kind: DiscussionRecord["kind"] | "all", pages: number, signal: AbortSignal): Promise<DiscussionList> {
  const items = new Map<string, DiscussionRecord>(), seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    if (kind !== "all") query.set("kind", kind);
    const answer = await get<Page<DiscussionRecord>>(`${base(projectId)}/discussions?${query}`, signal);
    if (answer.items.some(item => item.projectId !== projectId || (kind !== "all" && item.kind !== kind)))
      throw new Error("讨论列表返回了其他范围的记录");
    for (const item of answer.items) items.set(item.id, item);
    if (answer.nextCursor && (answer.nextCursor === cursor || seen.has(answer.nextCursor))) throw new Error("讨论分页没有前进，列表尚未读全");
    cursor = answer.nextCursor;
    if (!cursor) break;
    seen.add(cursor);
  }
  return { scope: kind, items: [...items.values()], nextCursor: cursor };
}

export async function readDiscussion(projectId: string, id: string, signal: AbortSignal): Promise<{ record: DiscussionRecord; events: DiscussionEvent[] }> {
  const [record, events] = await Promise.all([
    get<DiscussionRecord>(`${base(projectId)}/discussions/${encodeURIComponent(id)}`, signal),
    get<DiscussionEvent[]>(`${base(projectId)}/discussions/${encodeURIComponent(id)}/events`, signal),
  ]);
  if (record.projectId !== projectId || record.id !== id || events.some(event => event.discussionId !== id || event.projectId !== projectId))
    throw new Error("讨论记录与所选讨论不符");
  return { record, events };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One fixed package revision, read in full and checked against its SHA-256. */
export async function readVerifiedPackage(projectId: string, documentId: string, revisionId: string, signal?: AbortSignal): Promise<{ revision: DocumentRevision; body: string }> {
  const path = `${base(projectId)}/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}`;
  const revision = await get<DocumentRevision>(path, signal);
  if (revision.projectId !== projectId || revision.documentId !== documentId || revision.id !== revisionId)
    throw new Error("交接包原件不属于当前项目或指定修订");
  let content = revision.body;
  if (content === null) {
    const original = await get<{ status: string; body?: string; assets?: unknown[] }>(`${path}/original`, signal);
    if (original.status !== "available" || typeof original.body !== "string" || original.assets?.length)
      throw new Error("固定原件或其资源不能完整读取");
    content = original.body;
  }
  if (revision.format !== "markdown" || content === null) throw new Error("交接包不是完整的 Markdown 原文");
  if (await sha256(content) !== revision.contentHash) throw new Error("交接包原文与登记的 SHA-256 不一致");
  return { revision, body: content };
}

/** The discussion document's current head, verified the same way; it can differ from what the discussion registered. */
export async function readDocumentHead(projectId: string, documentId: string, signal?: AbortSignal): Promise<VerifiedDocumentHead> {
  const detail = await get<DocumentDetail>(`${base(projectId)}/documents/${encodeURIComponent(documentId)}`, signal);
  if (detail.document.projectId !== projectId || detail.document.id !== documentId || detail.current.projectId !== projectId
    || detail.current.documentId !== documentId || detail.current.id !== detail.document.currentRevisionId)
    throw new Error("讨论文档的当前版无法核实");
  const { revision, body } = await readVerifiedPackage(projectId, documentId, detail.document.currentRevisionId, signal);
  if (revision.contentHash !== detail.current.contentHash) throw new Error("文档当前版两次读回的 SHA-256 不一致");
  return { version: detail.document.version, revisionId: revision.id, contentHash: revision.contentHash, author: revision.author, body };
}
