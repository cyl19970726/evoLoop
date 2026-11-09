// 承接智能体 in the task's right column: assigned, accepted and running are three separate facts (tasks.md 内容与状态).
import type { Task } from "@evoloop/contracts";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { LeaderWorkRunFact } from "@evoloop/contracts/work-index";
import type { StatusTone } from "@evoloop/ui";

export interface AgentFact { label: string; value: string; tone: StatusTone }

const runText: Record<LeaderWorkRunFact["state"], { value: string; tone: StatusTone }> = {
  requested: { value: "等待启动", tone: "waiting" }, dispatching: { value: "正在派发", tone: "progress" },
  running: { value: "正在运行", tone: "progress" }, unknown: { value: "结果未知", tone: "unknown" },
  completed: { value: "没有运行 · 最近一轮已结束", tone: "idle" }, failed: { value: "没有运行 · 最近一轮失败", tone: "blocked" },
  interrupted: { value: "没有运行 · 最近一轮已中断", tone: "idle" },
};

/**
 * The three facts for the current task revision. A closed task's assignment is history; an assignment fixed to an
 * older revision is not acceptance of the current one; a finished Run is not acceptance of the work either.
 */
export function agentFacts(task: Pick<Task, "state" | "currentRevisionId">, assignment: TaskSessionAssignment | null,
  run: LeaderWorkRunFact | null | undefined, runKnown: boolean): AgentFact[] {
  const closed = task.state === "done" || task.state === "cancelled";
  const live = assignment && assignment.state !== "released" ? assignment : null;
  const current = !!live && live.taskRevisionId === task.currentRevisionId;
  const assigned: AgentFact = !assignment ? { label: "已分派", value: "未分派", tone: "idle" }
    : assignment.state === "released" ? { label: "已分派", value: "分派已释放", tone: "history" }
      : closed ? { label: "已分派", value: "历史分派", tone: "history" }
        : current ? { label: "已分派", value: "已分派", tone: "done" }
          : { label: "已分派", value: "分派属于旧修订", tone: "waiting" };
  const accepted: AgentFact = !live ? { label: "已接受", value: "未接受", tone: "idle" }
    : live.state === "accepted"
      ? closed ? { label: "已接受", value: "当时已接受", tone: "history" }
        : current ? { label: "已接受", value: live.ack?.method === "direct" ? "已接受 · 本人确认" : "已接受 · 负责人观察到", tone: "done" }
          : { label: "已接受", value: "接受属于旧修订", tone: "waiting" }
      : closed ? { label: "已接受", value: "当时未接受", tone: "history" } : { label: "已接受", value: "待接受", tone: "waiting" };
  const running: AgentFact = closed
    ? { label: "正在运行", value: run ? `任务已关闭 · ${runText[run.state].value.replace(/^没有运行 · /, "")}` : "任务已关闭", tone: "history" }
    : !runKnown ? { label: "正在运行", value: "运行状态未读回", tone: "unknown" }
      : run ? { label: "正在运行", ...runText[run.state] }
        : live?.target.kind === "external" ? { label: "正在运行", value: "外部运行状态未知", tone: "unknown" }
          : { label: "正在运行", value: "没有运行", tone: "idle" };
  return [assigned, accepted, running];
}

/** The agent's address in the directory: owned agents by Session id, external ones by HostLink id. */
export function assignmentKey(assignment: Pick<TaskSessionAssignment, "target">): string {
  return assignment.target.kind === "owned" ? `owned:${assignment.target.sessionId}` : `external:${assignment.target.linkId}`;
}
