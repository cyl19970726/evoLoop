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

/** From a row of the task table: back to the table as it is on screen; the selected row names it. */
export function tableOrigin(projectId: string, actorId: string, path = currentPath()): ReturnFrom {
  return { href: path.split("?")[0] === href(projectId, "work") ? path : href(projectId, "work"), actorId };
}
