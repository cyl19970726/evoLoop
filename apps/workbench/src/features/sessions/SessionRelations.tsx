// The relation bar under an agent's name (docs/frontend/pages/sessions.md 关系条): 职责 · 在做 · 阶段 · 队伍 · 交付, always these five.
// Everything is said from what the workspace already read; "在做" is the same judgment the 正在做 card and the status mark use
// (nowWork), so the bar never says something else than they do.
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { SessionResult } from "@evoloop/contracts/session-observation";
import { RelationBar, cut, link, readFailed, unregistered } from "../../shared/ui/RelationBar";
import { arrangementAgentHref, roleHref, stageHref } from "../../shared/routes";
import type { LineRead } from "./sessionWorkPresentation";

export type StageRead = { status: "none" } | { status: "loading" } | { status: "failed" } | { status: "ready"; leader: Pick<LeaderWorkTask, "stage" | "stageOwnership"> };

/** 待验收 until a use is recorded for the newest delivery, then what the consumer answered. */
export function resultWord(result: Pick<SessionResult, "latestUse">): string {
  const answer = result.latestUse?.result;
  return answer === "used" ? "已使用" : answer === "failed" ? "使用失败" : answer === "notUsed" ? "未使用" : "待验收";
}

export function SessionRelations({ projectId, sessionKey, roles, now, held, taskHref, stage, line, result, resultsRead }: {
  projectId: string; sessionKey: string; roles: Array<{ id: string; title: string }>;
  /** `task` is the Task the agent works on now; `badge` says what it does when there is none (空闲, 回复消息, 不可用 …). */
  now: { task: { id: string; title: string | null } | null; badge: string };
  /** The agent's model service is paused: said as the status mark says it. */
  held: boolean;
  taskHref(taskId: string): string;
  stage: StageRead; line: LineRead; result: SessionResult | null; resultsRead: "ready" | "failed" | "loading";
}) {
  const roleItem = roles.length ? roles.map((role, index) => <span key={role.id}>{index > 0 && "、"}<a className={link} href={roleHref(projectId, role.id)}>{role.title}</a></span>) : "职责待核对";
  const doing = held ? "模型服务暂停"
    : now.task ? <a className={link} href={taskHref(now.task.id)}>{now.task.title ? cut(now.task.title) : "任务标题暂不可读"}</a>
      : now.badge;
  const stageItem = !now.task ? unregistered
    : stage.status === "loading" ? "正在读取…" : stage.status === "failed" ? readFailed
      : stage.status === "none" ? unregistered
        : stage.leader.stageOwnership?.state === "stage" && stage.leader.stage ? <a className={link} href={stageHref(projectId, stage.leader.stage.stageId)}>{stage.leader.stage.shortName}</a>
          : stage.leader.stageOwnership?.state === "none" ? "不属于阶段" : unregistered;
  const lineItem = line.status === "failed" ? readFailed : line.status === "loading" ? "正在读取…" : line.status === "none" ? unregistered
    : line.entries.length ? <a className={link} href={arrangementAgentHref(projectId, sessionKey)}>队伍里 {line.entries.length} 项</a> : "队伍是空的";
  const handed = resultsRead === "failed" ? readFailed : resultsRead === "loading" ? "正在读取…"
    : result ? <><a className={link} href={`${taskHref(result.taskId)}&tab=delivery`}>{cut(result.taskTitle || "任务标题未提供", 16)}</a> · {resultWord(result)}</> : "还没有交付";
  return <RelationBar kind="agent" label="这个智能体连着什么" items={[
    { id: "roles", label: "职责", value: roleItem }, { id: "doing", label: "在做", value: doing }, { id: "stage", label: "阶段", value: stageItem },
    { id: "line", label: "队伍", value: lineItem }, { id: "delivery", label: "交付", value: handed },
  ]} />;
}
