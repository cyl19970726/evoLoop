// Links from a document (or the document list) into a task carry the way back (shared/returnLink.ts): the task page
// then offers “返回文档：<名称>” or “返回文档列表”.
import { currentPath } from "../../shared/navigation";
import { withReturn, type ReturnFrom } from "../../shared/returnLink";
import { href } from "../../shared/routes";

/** The document page as it is on screen (its revision included), or the document itself when another page is. */
export function documentOrigin(projectId: string, document: { id: string; title: string }, actorId: string, path = currentPath()): ReturnFrom {
  const own = href(projectId, "document", document.id);
  return { href: path.split("?")[0] === own ? path : own, title: document.title, actorId };
}

/** The document list as it is on screen. */
export function documentListOrigin(projectId: string, actorId: string, path = currentPath()): ReturnFrom {
  const list = href(projectId, "documents");
  return { href: path.split("?")[0] === list ? path : list, actorId };
}

/** A task link that comes back to `from`; plain while the reader is not known. */
export function taskLinkFrom(projectId: string, taskId: string, from: ReturnFrom | null | undefined, revisionId?: string): string {
  return withReturn(href(projectId, "task", taskId, revisionId), from);
}
