// Who acts next on a piece of work, and what they do, in the page's own words. The work index also carries
// `nextAction` and `responsible.label`, but those are written for agents working through the CLI: they name
// internal records and print raw identifiers. People read a next step per phase and a responsibility per kind,
// with the name read back separately; the identifier stays in the full-identifier layer.
import type { LeaderWorkPhase, LeaderWorkTask } from "@evoloop/contracts/work-index";

// Used by 统筹安排 and the overview (moved here from 统筹安排's arrangementPresentation, #259).
const nextSteps: Record<LeaderWorkPhase, string> = {
  unassigned: "等统筹指定承接的智能体",
  awaiting_assignment: "等承接的智能体确认接手",
  ready: "可以开始，等统筹安排执行",
  running: "等这次执行结束；执行结束不等于验收通过",
  awaiting_delivery: "等执行的智能体提交结果；没有交付前不推定结果",
  awaiting_acceptance: "等验收者核对交付与实际使用",
  rework: "先核对失败的结果，再安排返工",
  blocked: "先解决依赖、待复核或暂停，再安排承接",
  unknown: "上次执行结果未知，先核对，不要重复派发",
  closed: "已关闭，可查看交付与关闭依据",
  cancelled: "已取消；要继续，先核对取消原因",
};

/** The next step for work in this phase. */
export function workNextStep(phase: LeaderWorkPhase): string {
  return nextSteps[phase] ?? "下一步待核对";
}

export type Responsible = LeaderWorkTask["responsible"];
type Assignment = Pick<NonNullable<LeaderWorkTask["assignment"]>, "targetKind" | "targetId"> | null;

/** What kind of party is responsible next. Actors have no name directory, so their kind is all the page can say. */
export function responsibleKind(responsible: Pick<Responsible, "kind" | "id">, assignment: Assignment): string {
  switch (responsible.kind) {
    case "role": return "职责";
    case "session": return assignment?.targetId === responsible.id && assignment.targetKind === "external" ? "外部智能体" : "智能体";
    case "consumer": return "指定验收者";
    case "leader": return "项目统筹";
    case "publisher": return "发布维护者";
    case "user": return "指定的人";
    case "task": return "前置任务";
    default: return "下一责任";
  }
}

/** The name of a role, agent or task is read separately; until it is, the text says so and never shows the ID. */
export type NameRead = { state: "named"; name: string } | { state: "reading" } | { state: "unnamed" } | { state: "failed" };

/** Kinds whose name can be read back: a role's title, an agent's registered name, a task's title. */
export function responsibleHasName(kind: Responsible["kind"]): boolean {
  return kind === "role" || kind === "session" || kind === "task";
}

/** The next responsibility as one line. */
export function responsibleText(responsible: Pick<Responsible, "kind" | "id">, assignment: Assignment, name: NameRead): string {
  if (!responsible.id || responsible.kind === "unknown") return "下一责任未登记";
  const kind = responsibleKind(responsible, assignment);
  if (!responsibleHasName(responsible.kind)) return kind;
  return nameText(kind, name);
}

/** "职责 · 开发职责", or "职责（名称待读取）" until the name is back. */
export function nameText(kind: string, name: NameRead): string {
  switch (name.state) {
    case "named": return `${kind} · ${name.name}`;
    case "reading": return `${kind}（名称待读取）`;
    case "unnamed": return `${kind}（未登记名称）`;
    default: return `${kind}（名称暂不可读）`;
  }
}

/** Just the name where it stands alone ("责任 开发职责"); otherwise the same placeholder as `nameText`. */
export function nameOnly(kind: string, name: NameRead): string {
  return name.state === "named" ? name.name : nameText(kind, name);
}

/** The session key the session workspace reads; owned unless the assignment names the same agent as external. */
export function responsibleSessionKey(responsible: Pick<Responsible, "kind" | "id">, assignment: Assignment): string | null {
  if (responsible.kind !== "session" || !responsible.id) return null;
  return `${assignment?.targetId === responsible.id ? assignment.targetKind : "owned"}:${responsible.id}`;
}
