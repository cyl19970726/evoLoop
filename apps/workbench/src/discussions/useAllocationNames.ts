import { useEffect, useRef, useState } from "react";
import type { Document, Task, TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import { request } from "../api";
import { sessionClient } from "../sessions/client";
import type { AllocationTrace } from "./allocationClient";

export type AllocationKnownNames = { tasks: Task[]; roles: RoleRecord[]; documents: Document[] };
export const allocationSessionKey = (target: SessionTarget): string =>
  target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
const maxLookups = 80;

function neededKeys(items: AllocationTrace[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    const relation = item.relation;
    if (relation.kind === "task-recipient") {
      keys.add(`task:${relation.task.id}`);
      keys.add(`session:${allocationSessionKey(relation.assignment.target)}`);
    } else if (relation.target.kind !== "stage") keys.add(`${relation.target.kind}:${relation.target.id}`);
  }
  return [...keys];
}

/** Names are current display hints. Fixed revisions and acceptance still come only from the trace. */
export function useAllocationNames(token: string, projectId: string, items: AllocationTrace[],
  known: AllocationKnownNames, ready: boolean, retry: number): Record<string, string> {
  const scope = `${token}\0${projectId}`;
  const [read, setRead] = useState<{ scope: string; values: Record<string, string> }>({ scope: "", values: {} });
  const cache = useRef<{ scope: string; retry: number; values: Record<string, string>; attempted: Set<string> }>({ scope: "", retry, values: {}, attempted: new Set() });
  const seeded: Record<string, string> = {};
  for (const task of known.tasks) if (task.projectId === projectId && task.title.trim()) seeded[`task:${task.id}`] = task.title.trim();
  for (const role of known.roles) if (role.projectId === projectId && role.proposal.title.trim()) seeded[`role:${role.id}`] = role.proposal.title.trim();
  for (const document of known.documents) if (document.projectId === projectId && document.title.trim()) seeded[`document:${document.id}`] = document.title.trim();

  useEffect(() => {
    if (!ready) return;
    if (cache.current.scope !== scope) {
      cache.current = { scope, retry, values: {}, attempted: new Set() };
      setRead({ scope, values: {} });
    } else if (cache.current.retry !== retry) {
      cache.current.retry = retry;
      cache.current.attempted.clear();
    }
    const state = cache.current;
    const queue = neededKeys(items).filter(key => !seeded[key] && !state.values[key] && !state.attempted.has(key))
      .slice(0, Math.max(0, maxLookups - state.attempted.size));
    if (!queue.length) return;
    queue.forEach(key => state.attempted.add(key));
    const controller = new AbortController(), completed = new Set<string>();
    const base = `/api/projects/${encodeURIComponent(projectId)}`;
    let index = 0, active = true;
    async function lookup(key: string): Promise<string> {
      const divider = key.indexOf(":");
      const kind = key.slice(0, divider), id = key.slice(divider + 1);
      if (kind === "task") {
        const detail = await request<TaskDetail>(token, `${base}/tasks/${encodeURIComponent(id)}`, 15000, { signal: controller.signal });
        if (detail.task.projectId !== projectId || detail.task.id !== id) throw new Error("Task 名称来源不匹配");
        return detail.task.title.trim();
      }
      if (kind === "role") {
        const role = await request<RoleRecord>(token, `${base}/roles/${encodeURIComponent(id)}`, 15000, { signal: controller.signal });
        if (role.projectId !== projectId || role.id !== id) throw new Error("职责名称来源不匹配");
        return role.proposal.title.trim();
      }
      if (kind === "document") {
        const detail = await request<{ document: Document }>(token, `${base}/documents/${encodeURIComponent(id)}`, 15000, { signal: controller.signal });
        if (detail.document.projectId !== projectId || detail.document.id !== id) throw new Error("文档名称来源不匹配");
        return detail.document.title.trim();
      }
      const snapshot = await sessionClient(token, projectId).snapshot(id, controller.signal);
      if (snapshot.session.key !== id && !snapshot.session.aliases.some(alias => allocationSessionKey(alias) === id))
        throw new Error("Session 名称来源不匹配");
      return snapshot.session.profile?.displayName.trim() || snapshot.session.title.trim();
    }
    async function worker() {
      while (active && index < queue.length) {
        const key = queue[index++]!;
        try {
          const name = await lookup(key);
          if (active && name) {
            state.values[key] = name;
            setRead({ scope, values: { ...state.values } });
          }
        } catch { /* The card keeps its fixed link and says the name is unreadable. */ }
        finally { if (active) completed.add(key); }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    return () => {
      active = false; controller.abort();
      for (const key of queue) if (!completed.has(key)) state.attempted.delete(key);
    };
  }, [token, projectId, scope, items, ready, retry, known.tasks, known.roles, known.documents]);
  return { ...(read.scope === scope ? read.values : {}), ...seeded };
}
