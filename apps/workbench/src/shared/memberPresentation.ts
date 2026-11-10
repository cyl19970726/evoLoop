// Choosing a member of the project by name (GET /members) where a form used to take a typed sign-in identity: the 验收
// identity of a task or a schedule. A place that needs write lists only members who can write now (canWrite true); one
// that needs review only those who can review; one that needs neither every member; a kind (人 / 智能体) narrows it
// further. A member whose write cannot be judged (the identity file is unreadable) is shown as 无法判断 and never
// offered. An edited identity file is said with what each member could do after a restart (or that nothing changes
// for this project's members). When the service has no member list, the form falls back to typing. A member who could
// write only after a restart is not offered: the service checks the write as it is in effect.
// Pure, so the chooser and its tests agree.
import type { ProjectMember, ProjectMembersView } from "@evoloop/contracts/project-configuration";

/** `any`: every member may be chosen (a place whose identity needs no permission of its own here). */
export type MemberNeed = "write" | "review" | "any";
export type MemberKind = "human" | "agent" | null;

export interface MemberOption { value: string; label: string; disabled: boolean }
export interface MemberChoices {
  /** `typed`: no member list (unavailable): the identity is typed. */
  mode: "listed" | "typed";
  options: MemberOption[];
  /** How many members can be chosen. */
  eligible: number;
  /** How many members of the right kind cannot be judged (shown, not offered). */
  undecided: number;
  /** Members not offered, counted by why, in one sentence; null when every member is offered. */
  leftOut: string | null;
  /** What the identity file means for the list, or why there is no list. */
  notice: { tone: "waiting" | "error" | "info"; title: string; text: string } | null;
  /** One line per member whose abilities change after a restart. */
  pending: string[];
  /** A code the page has no words for, for 完整标识. */
  code: string | null;
}

export const memberKindLabel: Record<string, string> = { human: "人", agent: "智能体" };
const kindText = (kind: string) => memberKindLabel[kind] ?? "身份类型未识别";
const needText: Record<MemberNeed, string> = { write: "写入", review: "复核", any: "选" };

/** Whether a member can do what the place needs now: true, false, or null (cannot be judged). */
export function memberCan(member: Pick<ProjectMember, "canWrite" | "canReview">, need: MemberNeed): boolean | null {
  return need === "any" ? true : need === "write" ? member.canWrite : member.canReview;
}

/** What a restart would change for one member, in words; null when nothing. */
export function memberPendingText(member: ProjectMember): string | null {
  const after = member.pending;
  if (!after) return null;
  const changes: string[] = [];
  const change = (now: boolean | null, then: boolean, what: string) => {
    if (now === then) return;
    changes.push(then ? `才能${what}` : now === null ? `不能${what}` : `不能再${what}`);
  };
  if (after.identityKind !== member.identityKind) changes.push(`身份类型变为${kindText(after.identityKind)}`);
  change(member.canRead, after.canRead, "登录读取");
  change(member.canWrite, after.canWrite, "写入");
  change(member.canReview, after.canReview, "复核");
  return changes.length ? `${member.actorId}：重启后${changes.join("，")}` : null;
}

/**
 * The members a place may choose, for its need and kind. `current` is the value the form already holds (a task's
 * registered identity, or what was typed): it stays offered once, as it is, said for what it is, so keeping it never
 * changes what is sent.
 */
export function memberChoices(view: ProjectMembersView, need: MemberNeed, kind: MemberKind, current = ""): MemberChoices {
  const value = current.trim();
  if (view.status !== "available") {
    const text = view.reason === "not_provided" ? "服务端没有提供本项目的成员清单，请按完整标识填写登录身份。"
      : view.reason === "read_failed" ? "服务端读取成员清单失败，请按完整标识填写登录身份，或稍后重新读取。"
        : "服务端说成员清单暂不可用，原因用了界面不认识的代码；请按完整标识填写登录身份。";
    return { mode: "typed", options: [], eligible: 0, undecided: 0, leftOut: null, pending: [], notice: { tone: "waiting", title: "列不出成员", text },
      code: view.reason === "not_provided" || view.reason === "read_failed" ? null : String(view.reason) };
  }
  const offered: MemberOption[] = [], undecided: MemberOption[] = [];
  const left = { cannot: 0, kind: 0 };
  for (const member of view.items) {
    const can = memberCan(member, need);
    if (kind && member.identityKind !== kind) { left.kind++; continue; }
    if (can === true) offered.push({ value: member.actorId, label: `${member.actorId} · ${kindText(member.identityKind)}`, disabled: false });
    else if (can === null) undecided.push({ value: member.actorId, label: `${member.actorId} · 能否${needText[need]}无法判断（身份文件读不了）`, disabled: true });
    else left.cannot++;
  }
  // The value held stays as it is (never two options with one value): an undecided member it names is shown as held.
  const held = value && !offered.some(option => option.value === value) ? (() => {
    const member = view.items.find(item => item.actorId === value);
    const why = !member ? "不在本项目的成员清单里" : kind && member.identityKind !== kind ? `是${kindText(member.identityKind)}，这里要${kindText(kind)}`
      : memberCan(member, need) === null ? `能否${needText[need]}无法判断` : `不能${needText[need]}`;
    return { value, label: `${value}（当前所填；${why}）`, disabled: false };
  })() : null;
  const options = [...held ? [held] : [], ...offered, ...undecided.filter(option => option.value !== held?.value)];
  const reasons = [left.cannot ? `${left.cannot} 位不能${needText[need]}` : "", left.kind ? `${left.kind} 位不是${kindText(kind ?? "")}` : ""].filter(Boolean);
  const pending = view.items.map(memberPendingText).filter((line): line is string => !!line);
  const notice: MemberChoices["notice"] = view.identityFile === "changed"
    ? pending.length ? { tone: "waiting", title: "身份文件已改动，部分成员的权限要重启后才生效", text: "下面按现在生效的权限列出；重启后会变的成员另行写明。" }
      : { tone: "info", title: "身份文件已改动，本项目成员的权限没有变化", text: "下面按现在生效的权限列出。" }
    : view.identityFile === "unreadable" && need !== "any"
      ? { tone: "waiting", title: "身份文件现在读不了", text: `能否${needText[need]}要等身份文件读回后才能判断，标为“无法判断”的成员暂不可选。` } : null;
  return { mode: "listed", options, eligible: offered.length, undecided: undecided.length,
    leftOut: reasons.length ? `另有 ${reasons.join("、")}，没有列出。` : null, notice, pending, code: null };
}

/** The empty choice of a member chooser: nobody chosen yet, or why there is nobody to choose. Never “none” when unsure. */
export function memberPlaceholder(choices: Pick<MemberChoices, "eligible" | "undecided">, optional: boolean, noneLabel = "不指定"): string {
  if (choices.eligible) return optional ? noneLabel : "选择成员";
  return choices.undecided ? "暂时无法判断谁可选" : "本项目没有可选的成员";
}

/** What a member chooser should hold for an acceptance mode: a person for 必须本人验收, an agent for independent use. */
export function acceptanceMemberKind(mode: string | undefined): MemberKind {
  return mode === "human_required" ? "human" : mode === "independent_agent" ? "agent" : null;
}

/**
 * What the acceptance identity must be able to do. Under 必须本人验收 and independent agent use the chosen identity
 * records its own use, which is a write. Under a task's old agreement a reviewer records a person's use for them, so
 * the person may be any member, or not a member at all (typed in full).
 */
export function acceptanceMemberNeed(mode: string | undefined): MemberNeed {
  return mode === "human_required" || mode === "independent_agent" ? "write" : "any";
}
