// Where a link out of a task comes back to (scenarios.md 跳转规则): the address on screen when it shows this task (any
// tab) or the task table, else the task itself. The agent page it opens then offers “返回任务：<名称>”.
import { currentPath } from "../../shared/navigation";
import type { ReturnFrom } from "../../shared/returnLink";
import { href } from "../../shared/ui/shared";

export function taskOrigin(projectId: string, task: { id: string; title?: string | null }, actorId: string, path = currentPath()): ReturnFrom {
  const pathname = path.split("?")[0];
  const here = pathname === href(projectId, "task", task.id) || pathname === href(projectId, "work");
  return { href: here ? path : href(projectId, "task", task.id), title: task.title ?? null, actorId };
}

/**
 * From the task table: back to the table as it is on screen. A link in a task's row comes back with that row selected
 * and is named after it (“返回任务：<那一行>”); a link that belongs to no row names the list only, never the row that
 * happens to be selected.
 */
export function tableOrigin(projectId: string, actorId: string, path = currentPath(), row?: { id: string; title: string } | null): ReturnFrom {
  const table = href(projectId, "work");
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(pathname === table ? query : "");
  if (row) params.set("selected", row.id);
  return { href: params.size ? `${table}?${params}` : table, title: row?.title ?? null, actorId };
}
