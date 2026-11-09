// The evaluation page's reads. Every key sits under the project (shared/query.ts), so leaving the project drops them
// and a write anywhere in the project (context.onChanged) rereads what is on screen. Responses are checked against
// the project and object they were asked for before the page uses them.
import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EvaluationFixedRef, EvaluationRevision } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { readOwnerRole } from "../../shared/ownerRole";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { fixedTitleKey, verifiedFixedDocumentTitle } from "./presentation";

export interface EvaluationFilter { taskId?: string | undefined; knowledgePageId?: string | undefined }

/**
 * One page of 50 at a time; asking for more rereads the pages already shown so the list stays one consistent answer.
 * While more pages load, the pages already read for the same filter stay on screen; another filter never borrows them.
 */
export function useEvaluationList(projectId: string, filter: EvaluationFilter, pages: number) {
  const scope = JSON.stringify([projectId, filter.taskId ?? "", filter.knowledgePageId ?? ""]);
  const query = useEvaluationPages(projectId, filter, pages);
  const shown = useRef<{ scope: string; data: NonNullable<typeof query.data> } | null>(null);
  if (query.data) shown.current = { scope, data: query.data };
  const data = query.data ?? (shown.current?.scope === scope ? shown.current.data : undefined);
  return { ...query, data, checking: query.isFetching && data !== undefined };
}

function useEvaluationPages(projectId: string, filter: EvaluationFilter, pages: number) {
  return useProjectQuery(projectId, ["evaluations", "list", filter.taskId ?? "", filter.knowledgePageId ?? "", pages], async () => {
    const items: EvaluationRevision[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < pages; page++) {
      const result = await api().evaluations(projectId, cursor, filter.taskId, filter.knowledgePageId);
      if (result.items.some(item => item.projectId !== projectId)) throw new Error("评价列表响应与当前项目不符");
      items.push(...result.items);
      cursor = result.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) { cursor = undefined; break; }
      seen.add(cursor);
    }
    return { items, nextCursor: cursor ?? null };
  });
}

export function useEvaluationDetail(projectId: string, evaluationId: string, revisionId?: string) {
  return useProjectQuery(projectId, ["evaluation", evaluationId, "detail", revisionId ?? ""], async () => {
    const value = await api().evaluation(projectId, evaluationId, revisionId);
    const own = (row: { projectId: string; evaluationId: string }) => row.projectId === projectId && row.evaluationId === evaluationId;
    if (!own(value.revision) || (revisionId && value.revision.id !== revisionId) || !value.revisions.every(own) || !value.attempts.every(own)
      || !value.assessments.every(own) || !value.conclusions.every(own)) throw new Error("评价响应与所选的项目或定义不符");
    return value;
  });
}
export type EvaluationRead = NonNullable<ReturnType<typeof useEvaluationDetail>["data"]>;

/** The common task with its deliveries and use records, every run and every agent of the project (to find fresh ones). */
export function useEvaluationEvidence(projectId: string, evaluationId: string, taskId: string, ownerTaskId: string) {
  const task = useProjectQuery(projectId, ["evaluation", evaluationId, "task", taskId], async () => {
    const value = await api().task(projectId, taskId);
    if (value.task.projectId !== projectId || value.task.id !== taskId) throw new Error("共同任务响应与评价不符");
    return value;
  });
  const owner = useProjectQuery(projectId, ["evaluation", evaluationId, "owner-task", ownerTaskId], async () => {
    const value = await api().task(projectId, ownerTaskId);
    if (value.task.projectId !== projectId || value.task.id !== ownerTaskId) throw new Error("负责任务响应与评价不符");
    return value.task;
  }, { enabled: ownerTaskId !== taskId });
  const runs = useProjectQuery(projectId, ["evaluation", evaluationId, "runs"], async () => {
    const rows = await runtimeClient("", projectId).runs();
    if (rows.some(row => row.projectId !== projectId)) throw new Error("运行记录响应与当前项目不符");
    return rows;
  });
  const sessions = useProjectQuery(projectId, ["evaluation", evaluationId, "agents"], async () => {
    const rows = await runtimeClient("", projectId).sessions();
    if (rows.some(row => row.projectId !== projectId)) throw new Error("智能体记录响应与当前项目不符");
    return rows;
  });
  return { task, owner, runs, sessions };
}

/** A current document name is only a reading aid after the exact cited revision and hash are read (per reference). */
export function useFixedTitles(projectId: string, evaluationId: string, revisionId: string, refs: EvaluationFixedRef[]) {
  const documents = refs.filter(ref => ref.kind === "document");
  return useProjectQuery(projectId, ["evaluation", evaluationId, "titles", revisionId], async () => {
    const rows = await Promise.all(documents.map(async (ref): Promise<[string, string | null]> => {
      try {
        const [detail, fixed] = await Promise.all([api().document(projectId, ref.id), api().documentRevision(projectId, ref.id, ref.revision)]);
        return [fixedTitleKey(ref), verifiedFixedDocumentTitle(ref, projectId, detail.document, fixed)];
      } catch { return [fixedTitleKey(ref), null]; }
    }));
    return Object.fromEntries(rows.filter((row): row is [string, string] => !!row[1]));
  }, { enabled: documents.length > 0 });
}

/** Role names for the agents offered in the run form, older non-UUID role keys included; an unreadable name stays unread. */
export function useRoleTitles(projectId: string, roleIds: string[]) {
  const ids = [...new Set(roleIds.filter(id => id.trim()))].sort();
  return useProjectQuery(projectId, ["evaluation", "role-titles", ids.join(",")], async signal => {
    const rows = await Promise.all(ids.map(async (id): Promise<[string, string | null]> => {
      try { return [id, (await readOwnerRole("", projectId, id, signal)).proposal?.title?.trim() || null]; }
      catch { return [id, null]; }
    }));
    return Object.fromEntries(rows.filter((row): row is [string, string] => !!row[1]));
  }, { enabled: ids.length > 0 });
}

/** The sealed input actually sent for one attempt; read when asked. */
export function usePacket(projectId: string, revision: EvaluationRevision, attemptId: string, requested: boolean) {
  return useProjectQuery(projectId, ["evaluation", revision.evaluationId, "packet", revision.id, attemptId], () =>
    api().evaluationPacket(projectId, revision.evaluationId, revision.id, attemptId), { enabled: requested });
}

/** The agent's own final output for one run; read when asked. */
export function useNativeOutput(projectId: string, evaluationId: string, runId: string, requested: boolean) {
  return useProjectQuery(projectId, ["evaluation", evaluationId, "native", runId], () => runtimeClient("", projectId).result(runId), { enabled: requested });
}

/** 回读当前记录: the evaluation, its evidence and the list, without rereading the rest of the project. */
export function useEvaluationReread(projectId: string) {
  const client = useQueryClient();
  return (evaluationId?: string) => Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.project(projectId, "evaluations") }),
    evaluationId ? client.invalidateQueries({ queryKey: queryKeys.project(projectId, "evaluation", evaluationId) }) : Promise.resolve(),
  ]);
}
