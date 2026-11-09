// What the task's right column may conclude from its reads (tasks.md 内容与状态). Assigned, accepted and running are
// three separate facts; a read that is still running says so, a failed read says it cannot tell, and neither ever
// becomes "not assigned", "no run" or "not registered".
import type { Task } from "@evoloop/contracts";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { LeaderWorkRunFact, LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { StatusTone } from "@evoloop/ui";
import { phaseStatus } from "../../shared/taskStatus";
import { workNextStep } from "../../shared/workPresentation";

/** loading: no answer yet; checking: an answer is being confirmed again; failed: no usable answer; ready: answered. */
export type ReadState = "loading" | "checking" | "failed" | "ready";
export interface Read<T> { state: ReadState; value: T }
export interface AgentFact { label: string; value: string; tone: StatusTone }

const pending = (label: string, state: ReadState): AgentFact | null =>
  state === "loading" ? { label, value: "正在读取", tone: "unknown" }
    : state === "checking" ? { label, value: "正在核对", tone: "unknown" }
      : state === "failed" ? { label, value: "无法判断", tone: "unknown" } : null;

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
export function agentFacts(task: Pick<Task, "state" | "currentRevisionId">, assignmentRead: Read<TaskSessionAssignment | null>,
  runRead: Read<LeaderWorkRunFact | null>): AgentFact[] {
  const closed = task.state === "done" || task.state === "cancelled";
  const assignment = assignmentRead.value;
  const live = assignment && assignment.state !== "released" ? assignment : null;
  const current = !!live && live.taskRevisionId === task.currentRevisionId;
  const assigned: AgentFact = pending("已分派", assignmentRead.state)
    ?? (!assignment ? { label: "已分派", value: "未分派", tone: "idle" }
      : assignment.state === "released" ? { label: "已分派", value: "分派已释放", tone: "history" }
        : closed ? { label: "已分派", value: "历史分派", tone: "history" }
          : current ? { label: "已分派", value: "已分派", tone: "done" }
            : { label: "已分派", value: "分派属于旧修订", tone: "waiting" });
  const accepted: AgentFact = pending("已接受", assignmentRead.state)
    ?? (!live ? { label: "已接受", value: "未接受", tone: "idle" }
      : live.state === "accepted"
        ? closed ? { label: "已接受", value: "当时已接受", tone: "history" }
          : current ? { label: "已接受", value: live.ack?.method === "direct" ? "已接受 · 本人确认" : "已接受 · 负责人观察到", tone: "done" }
            : { label: "已接受", value: "接受属于旧修订", tone: "waiting" }
        : closed ? { label: "已接受", value: "当时未接受", tone: "history" } : { label: "已接受", value: "待接受", tone: "waiting" });
  const run = runRead.value;
  const running: AgentFact = closed
    ? { label: "正在运行", value: run ? `任务已关闭 · ${runText[run.state].value.replace(/^没有运行 · /, "")}` : "任务已关闭", tone: "history" }
    : pending("正在运行", runRead.state)
      ?? (run ? { label: "正在运行", ...runText[run.state] }
        : assignmentRead.state === "ready" && live?.target.kind === "external" ? { label: "正在运行", value: "外部运行状态未知", tone: "unknown" }
          : { label: "正在运行", value: "没有运行", tone: "idle" });
  return [assigned, accepted, running];
}

/** The reconciliation phase tag and the next step. Only an answered read may say "not registered". */
export function phaseFact(read: Read<LeaderWorkTask | null>): { tone: StatusTone; label: string; next: string } {
  switch (read.state) {
    case "loading": return { tone: "unknown", label: "正在读取", next: "正在读取当前工作安排…" };
    case "checking": return { tone: "unknown", label: "正在核对", next: "当前工作安排正在重新核对…" };
    case "failed": return { tone: "unknown", label: "无法判断", next: "当前工作安排暂不可读取，无法判断下一步；可重新读取。" };
    case "ready": return read.value
      ? { ...phaseStatus[read.value.phase], next: workNextStep(read.value.phase) }
      : { tone: "idle", label: "未登记", next: "当前工作安排未登记；与统筹沟通后回读。" };
  }
}

/** The agent's address in the directory: owned agents by Session id, external ones by HostLink id. */
export function assignmentKey(assignment: Pick<TaskSessionAssignment, "target">): string {
  return assignment.target.kind === "owned" ? `owned:${assignment.target.sessionId}` : `external:${assignment.target.linkId}`;
}
