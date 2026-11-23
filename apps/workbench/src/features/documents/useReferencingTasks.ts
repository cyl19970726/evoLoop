import type { DocumentTaskReference } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";

export const pageLimit = 20, itemLimit = 1000;

/** Every task that references the document, read page by page up to a limit that is said when reached. */
export function useReferencingTasks(projectId: string, documentId: string) {
  return useProjectQuery(projectId, ["document", documentId, "tasks"], async signal => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    const tasks = new Map<string, DocumentTaskReference>();
    let pages = 0;
    do {
      const page = await api().documentTasks(projectId, documentId, cursor, signal);
      if (page.items.length > 50 || page.items.some(item => item.projectId !== projectId)) throw new Error("关联任务分页响应无效");
      for (const task of page.items) tasks.set(task.id, task);
      pages++;
      if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("分页游标重复，关联任务读取未完成");
      if (page.nextCursor) seen.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
      if (cursor && (pages >= pageLimit || tasks.size >= itemLimit)) return { tasks: [...tasks.values()], partial: true };
    } while (cursor);
    return { tasks: [...tasks.values()], partial: false };
  });
}
