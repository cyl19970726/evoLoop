// 进展与讨论 › 协作与待处理问题: the task's collaboration channels read whole (bounded), and how their records are said.
// Only what the records prove is said: an approved action without its own execution receipt is "未见执行回执", and a
// read that stopped at its limit never concludes that there is nothing else.
import type { DiscussionEvent, DiscussionRecord, TaskCollaborationPayload } from "@evoloop/contracts/discussions";
import { api } from "../../shared/api";

export type CollaborationThread = { record: DiscussionRecord; events: DiscussionEvent[] };
export interface CollaborationRead { threads: CollaborationThread[]; partial: boolean }

export const messageKindLabel = { question: "提问", answer: "答复", progress: "进展", blocker: "阻塞", handoff: "交接", result: "结果" } as const;
export const receiptStageLabel = { received: "已收到", read: "已阅读", adopted: "已采用", resolved: "已解决" } as const;
export const executionStateLabel = { started: "已开始", succeeded: "已完成", failed: "执行失败", unknown: "结果未知" } as const;
export const actionTypeLabel: Record<Extract<TaskCollaborationPayload, { type: "action_request" }>["actionType"], string> = {
  "worktree.write": "写入工作区", "git.commit": "提交代码", "git.push": "推送分支", "pr.create": "创建合并请求",
  "pr.review": "审阅合并请求", "pr.merge": "合并", deployment: "部署",
};

const pageLimit = 20, threadLimit = 20;

/**
 * Every collaboration channel of one task: pages of the project's discussions (at most 20 pages and 20 matching
 * channels; beyond that the read is marked partial), then each channel and its events read again by id.
 */
export async function readTaskCollaboration(projectId: string, taskId: string): Promise<CollaborationRead> {
  const client = api();
  let cursor: string | undefined;
  const seen = new Set<string>();
  const matches = new Map<string, DiscussionRecord>();
  let pages = 0, partial = false;
  do {
    const page = await client.discussions(projectId, cursor);
    if (page.items.length > 50 || page.items.some(record => record.projectId !== projectId)) throw new Error("协作分页响应与当前项目不符");
    for (const record of page.items) if (record.kind === "task_collaboration" && record.task?.id === taskId) {
      if (!matches.has(record.id) && matches.size >= threadLimit) { partial = true; continue; }
      matches.set(record.id, record);
    }
    pages++;
    if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("协作分页游标重复，读取未完成");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
    if (partial || cursor && (pages >= pageLimit || matches.size >= threadLimit)) { partial = true; break; }
  } while (cursor);
  const threads: CollaborationThread[] = [];
  for (const record of matches.values()) {
    const [current, events] = await Promise.all([client.discussion(projectId, record.id), client.discussionEvents(projectId, record.id)]);
    if (current.projectId !== projectId || current.id !== record.id || current.task?.id !== taskId ||
      events.some(event => event.projectId !== projectId || event.discussionId !== record.id)) throw new Error("任务协作详情响应不匹配");
    threads.push({ record: current, events: [...events].sort((a, b) => a.version - b.version) });
  }
  return { threads, partial };
}

const message = (event: DiscussionEvent) => event.collaborationPayload?.type === "message" ? event.collaborationPayload : null;

/** Whether a question has an answer that replies to it. */
export function isAnswered(question: DiscussionEvent, events: DiscussionEvent[]): boolean {
  return events.some(reply => message(reply)?.kind === "answer" && message(reply)?.replyToEventId === question.id);
}

/** Questions in the channel that no answer replies to. */
export function openQuestions(events: DiscussionEvent[]): DiscussionEvent[] {
  return events.filter(event => message(event)?.kind === "question" && !isAnswered(event, events));
}

/** One line for a channel in its list: its question, how many questions wait, its version. */
export function threadSummary({ record, events }: CollaborationThread): string {
  const open = openQuestions(events).length;
  return `${record.question || "任务协作"} · ${open ? `${open} 个问题待答` : "已读范围内没有待答问题"} · 第 ${record.version} 版`;
}

/** Where an engineering action request stands, from the records that follow it. */
export function actionRequestState(request: DiscussionEvent, events: DiscussionEvent[]): string {
  const execution = events.find(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.requestEventId === request.id);
  if (execution) return "有独立执行回执，结果另核";
  const decision = events.find(item => item.collaborationPayload?.type === "action_decision" && item.collaborationPayload.requestEventId === request.id);
  const state = decision?.collaborationPayload?.type === "action_decision" ? decision.collaborationPayload.decision : null;
  return state === "approved" ? "已批准，未见执行回执" : state === "rejected" ? "已拒绝" : state === "expired" ? "已过期" : "待明确决定";
}
