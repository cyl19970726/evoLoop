// Reads behind 目标与阶段 and 新建任务, as project queries under one key prefix so a reread (or any write in the project)
// refreshes them together and every page instance shares the answers. Paged reads stop at a bound and say so; a
// partial read is never presented as the whole project.
import type { Document, Goal, Stage } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api, errorText } from "../../shared/api";
import { appendLeaderWorkPage } from "../../shared/leaderWorkLoad";
import { useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";

const maxPages = 20;
export const journeyKey = "journey";

/** `problem` says why a list stopped after some pages; the pages already read are kept and the list is incomplete. */
export interface GoalsRead { items: Goal[]; complete: boolean; problem?: string }
export interface StageWorkRead { items: LeaderWorkTask[]; complete: boolean; observedAt: string; problem?: string }

/**
 * Pages of a cursor list, up to the bound. A failed first page fails the read; a page after it that fails (or a
 * repeated cursor) keeps what was read and reports the list as incomplete, as the task list does.
 */
async function readPages<T>(label: string, read: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<{ items: T[]; complete: boolean; problem?: string }> {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let result: { items: T[]; nextCursor: string | null };
    try { result = await read(cursor); }
    catch (cause) { if (!page) throw cause; return { items, complete: false, problem: errorText(cause) }; }
    items.push(...result.items);
    if (!result.nextCursor) return { items, complete: true };
    if (seen.has(result.nextCursor)) return { items, complete: false, problem: `${label}分页游标重复，无法确认列表完整` };
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  return { items, complete: false };
}

export async function readGoals(projectId: string): Promise<GoalsRead> {
  const read = await readPages("目标", cursor => api().goals(projectId, cursor));
  if (read.items.some(goal => goal.projectId !== projectId)) throw new Error("目标响应不属于当前项目");
  return { items: [...new Map(read.items.map(goal => [goal.id, goal])).values()], complete: read.complete, ...(read.problem ? { problem: read.problem } : {}) };
}

export async function readStages(projectId: string): Promise<Stage[]> {
  const stages = await api().stages(projectId);
  if (stages.some(stage => stage.projectId !== projectId)) throw new Error("阶段响应不属于当前项目");
  return stages;
}

/** Every task with its stage, phase and next responsibility, closed ones included. */
export async function readStageWork(projectId: string, signal?: AbortSignal): Promise<StageWorkRead> {
  const client = api();
  let page = await client.leaderWork(projectId, "tasks", undefined, true, signal) as LeaderWorkPage<LeaderWorkTask>;
  const seen = new Set<string>();
  let problem = "";
  for (let pages = 1; page.nextCursor && pages < maxPages; pages++) {
    // A later page that cannot be read (or moved on meanwhile) keeps the pages read so far; the read stays incomplete.
    try {
      if (seen.has(page.nextCursor)) throw new Error("任务分页游标重复，无法确认列表完整");
      seen.add(page.nextCursor);
      const next = await client.leaderWork(projectId, "tasks", page.nextCursor, true, signal) as LeaderWorkPage<LeaderWorkTask>;
      if (next.changeSequence !== page.changeSequence) throw new Error("任务在分页读取期间有变化，请重新读取");
      page = appendLeaderWorkPage(page, next);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      problem = errorText(cause);
      break;
    }
  }
  return { items: page.items.filter(item => item.kind === "task"), complete: !problem && !page.nextCursor && !page.partial, observedAt: page.observedAt,
    ...(problem ? { problem } : {}) };
}

/** Roles a task can be given to: the ones in use or on trial. */
export async function readOwnerRoles(projectId: string): Promise<RoleRecord[]> {
  const read = await readPages("职责", cursor => roleClient("", projectId).list(cursor));
  if (read.items.some(role => role.projectId !== projectId)) throw new Error("职责响应与当前项目不符");
  if (!read.complete) throw new Error(read.problem ? `职责没有读全：${read.problem}` : "职责超过读取上限，无法完整选择；请先缩小项目范围");
  return [...new Map(read.items.map(role => [role.id, role])).values()].filter(role => role.state === "active" || role.state === "trial");
}

/** Published process documents a new task may link. */
export async function readPublishedDocuments(projectId: string): Promise<{ items: Document[]; complete: boolean }> {
  const read = await readPages("过程文档", cursor => api().documents(projectId, cursor));
  return { items: read.items.filter(document => document.status === "published"), complete: read.complete };
}

export function useGoals(projectId: string) {
  return useProjectQuery(projectId, [journeyKey, "goals"], () => readGoals(projectId));
}
export function useStages(projectId: string) {
  return useProjectQuery(projectId, [journeyKey, "stages"], () => readStages(projectId));
}
export function useStageWork(projectId: string) {
  return useProjectQuery(projectId, [journeyKey, "work"], signal => readStageWork(projectId, signal));
}
