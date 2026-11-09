import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

/** The current projection owns next responsibility; an assignment may only name the same agent (Session). */
export function taskPreviewResponsibility(
  projection: Pick<LeaderWorkTask, "responsible"> & {
    assignment: Pick<NonNullable<LeaderWorkTask["assignment"]>, "targetKind" | "targetId"> | null;
  },
  sessionName: string | null | undefined,
  roleName: string | null | undefined,
  resolvedRoleId: string | null,
): string {
  const { responsible, assignment } = projection;
  if (responsible.kind === "session" && responsible.id === assignment?.targetId && sessionName?.trim())
    return `${assignment.targetKind === "owned" ? "智能体" : "外部智能体"} · ${sessionName.trim()}`;
  if (responsible.kind === "role" && responsible.id === resolvedRoleId && roleName?.trim())
    return `负责职责 · ${roleName.trim()}`;
  return responsible.label;
}
