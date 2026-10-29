import { useEffect, useState } from "react";
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api, errorText } from "../api";
import { appendLeaderWorkPage } from "./leaderWorkLoad";

/** The current-work scan is independent of the ordinary list's first page and filters. */
export function useTaskProjections(token: string, projectId: string, tasks: Task[],
  first: LeaderWorkPage<LeaderWorkTask> | null, readKey: string, enabled: boolean) {
  const [value, setValue] = useState<{ items: Record<string, LeaderWorkTask>; complete: boolean; error: string }>({ items: {}, complete: false, error: "" });
  const signature = tasks.map(task => `${task.id}:${task.version}:${task.currentRevisionId}`).join(",");
  useEffect(() => {
    let active = true;
    setValue({ items: {}, complete: false, error: "" });
    if (!enabled || !first) return () => { active = false; };
    const client = api(token);
    void (async () => {
      let page = first;
      const seen = new Set<string>();
      let problem = "";
      try {
        // Explicit bounded scan; a partial scan must never become a global empty claim.
        while (page.nextCursor && page.items.length < 500) {
          if (seen.has(page.nextCursor)) throw new Error("当前工作分页游标重复");
          seen.add(page.nextCursor);
          const next = await client.leaderWork(projectId, "tasks", page.nextCursor) as LeaderWorkPage<LeaderWorkTask>;
          if (!active) return;
          page = appendLeaderWorkPage(page, next);
        }
      } catch (cause) { problem = errorText(cause); }
      if (!active) return;
      const items = Object.fromEntries(page.items.map(item => [item.taskId, item]));
      const complete = !page.nextCursor && !page.partial && !problem;
      setValue({ items: { ...items }, complete, error: problem });
      // Closed tasks are absent from the active index. Fetch only missing rendered rows.
      const queue = tasks.filter(task => !items[task.id]);
      const read = async () => {
        while (active && queue.length) {
          const task = queue.shift()!;
          try { items[task.id] = await client.leaderTask(projectId, task.id); }
          catch { /* A missing row remains explicitly unverified; the Task is still readable. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, read));
      if (active) setValue({ items, complete, error: problem });
    })();
    return () => { active = false; };
  }, [token, projectId, first, signature, readKey, enabled]);
  return value;
}
