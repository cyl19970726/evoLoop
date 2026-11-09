import type { Stage } from "@evoloop/contracts";
import type { OrchestrationLoop } from "@evoloop/contracts/orchestration";
import type { ScheduleDefinition, ScheduledTaskTemplate } from "@evoloop/contracts/scheduling";

export function scheduleTemplate(values: Record<string, string>, definition?: ScheduleDefinition): ScheduledTaskTemplate {
  return {
    title: values.title, content: values.content, acceptance: values.acceptance, owner: values.owner,
    ...(!definition?.revision.template.managedTarget ? {
      acceptanceMode: (values.acceptanceMode || "independent_agent") as "independent_agent" | "human_required",
      ...(values.consumer?.trim() ? { consumer: values.consumer.trim() } : {}),
    } : {}),
    ...(definition?.revision.template.managedTarget ? { managedTarget: definition.revision.template.managedTarget } : {}),
  };
}

/** The display readback is scoped and exact; the command handler repeats these checks at write time. */
export function managedTargetProblem(projectId: string, definition: ScheduleDefinition,
  loop: OrchestrationLoop | null, stage: Stage | null): string | null {
  const target = definition.revision.template.managedTarget;
  if (!target) return "此日程没有登记受管目标。";
  if (definition.projectId !== projectId || !loop || !stage || loop.projectId !== projectId || stage.projectId !== projectId)
    return "目标 Loop 或 Stage 不在当前项目，无法核对原绑定。";
  if (loop.id !== target.loopId || stage.id !== target.stageId || loop.stageId !== stage.id || loop.goalId !== stage.goalId)
    return "目标 Loop、Stage 或所属目标与日程登记不一致，无法核对原绑定。";
  if (loop.state === "stopped" || stage.state !== "active")
    return "目标 Loop 已停止或 Stage 不再活动，不能保存运行中的日程。";
  if (definition.revision.template.owner !== definition.revision.authorization.roleId ||
    !loop.allowedBusinessRoleIds.includes(definition.revision.template.owner))
    return "任务责任者不在此 Loop 允许的业务职责中，不能恢复运行。";
  return null;
}

/** Stopping or pausing keeps every definition field, including its fixed managed target. */
export function suspendSchedule(definition: ScheduleDefinition, state: "paused" | "stopped", reason: string, actorId: string) {
  const revision = definition.revision;
  return {
    type: "schedule.revise" as const, scheduleId: definition.id, expectedVersion: definition.version,
    revisionId: crypto.randomUUID(), state, timezone: revision.timezone, rule: revision.rule,
    misfire: revision.misfire, overlap: revision.overlap, template: revision.template,
    authorization: { ...revision.authorization, authorizedBy: actorId }, reason,
  };
}
