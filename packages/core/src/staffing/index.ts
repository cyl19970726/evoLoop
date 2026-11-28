// 分工检查: the team's records judged against the growth rules. DEC-038 lets the Leader add one same-Role instance at a time, the next only after the
// last one has an accepted delivery; DEC-055 applies the same to every business addition and keeps the system layer out of it. A trial Role past its
// review date is the third thing that must be settled first. Pure: the store supplies the facts, the caller the clock.
import { staffingIdleDays, type StaffingBlocker, type StaffingCheck, type StaffingFacts, type StaffingLayer, type StaffingSessionFact,
  type StaffingTeamRow } from "@evoloop/contracts/staffing";

const dayMs = 86_400_000;
const inUse = new Set(["candidate", "trial", "active", "retirement-pending"]);
const isOpen = (session: StaffingSessionFact) => session.state !== "closed" && session.state !== "closing";
const day = (value: string) => value.slice(0, 10);
const wholeDays = (from: string, now: number) => Math.max(0, Math.floor((now - Date.parse(from)) / dayMs));
const name = (session: { displayName: string | null; sessionId: string }) => session.displayName ?? session.sessionId.slice(0, 8);

export interface StaffingCheckInput {
  projectId: string; facts: StaffingFacts; now: string;
  /** Days without a Run before a ready business Session is listed as idle; defaults to `staffingIdleDays`. */
  idleDays?: number;
  /** Sessions the rules do not cover: the ones a managed loop created for itself and will close itself. */
  excludeSessionIds?: Iterable<string>;
}

export function buildStaffingCheck(input: StaffingCheckInput): StaffingCheck {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error("staffing check needs a valid instant");
  const idleDays = input.idleDays ?? staffingIdleDays;
  const excluded = new Set(input.excludeSessionIds ?? []);
  const roles = new Map(input.facts.roles.map(role => [role.roleId, role]));
  // A Role without a recorded class, and a Session whose Role is not a Role record, count as business: the rules then apply to them.
  const layerOf = (roleId: string): StaffingLayer => roles.get(roleId)?.roleClass === "system" ? "system" : "business";
  const titleOf = (roleId: string) => roles.get(roleId)?.title || roleId;
  const sessions = input.facts.sessions.filter(session => !excluded.has(session.sessionId));
  const open = sessions.filter(isOpen);
  const openByRole = new Map<string, number>();
  for (const session of open) openByRole.set(session.roleId, (openByRole.get(session.roleId) ?? 0) + 1);

  const team: StaffingTeamRow[] = input.facts.roles.filter(role => inUse.has(role.state) || openByRole.has(role.roleId))
    .map(role => ({ roleId: role.roleId, title: role.title || role.roleId, layer: layerOf(role.roleId), state: role.state, openSessions: openByRole.get(role.roleId) ?? 0 }));
  for (const [roleId, count] of openByRole)
    if (!roles.has(roleId)) team.push({ roleId, title: roleId, layer: "business", state: "unrecorded", openSessions: count });
  team.sort((a, b) => (a.layer === b.layer ? 0 : a.layer === "system" ? -1 : 1) || a.title.localeCompare(b.title) || a.roleId.localeCompare(b.roleId));

  const trialsDue = input.facts.roles.filter(role => role.state === "trial" && Date.parse(role.reviewAtUtc) <= now)
    .sort((a, b) => Date.parse(a.reviewAtUtc) - Date.parse(b.reviewAtUtc) || a.roleId.localeCompare(b.roleId))
    .map(role => ({ roleId: role.roleId, title: role.title || role.roleId, layer: layerOf(role.roleId), reviewAtUtc: role.reviewAtUtc,
      daysOverdue: wholeDays(role.reviewAtUtc, now), openSessions: openByRole.get(role.roleId) ?? 0 }));

  const ref = (session: StaffingSessionFact) => ({ sessionId: session.sessionId, displayName: session.displayName, roleId: session.roleId,
    roleTitle: titleOf(session.roleId), createdAt: session.createdAt });
  const business = open.filter(session => layerOf(session.roleId) === "business");
  const latest = business.reduce<StaffingSessionFact | null>((found, session) => !found ||
    Date.parse(session.createdAt) > Date.parse(found.createdAt) ||
    (Date.parse(session.createdAt) === Date.parse(found.createdAt) && session.sessionId > found.sessionId) ? session : found, null);
  const lastAddition = latest ? { ...ref(latest), runs: latest.runs, deliveries: latest.deliveries,
    acceptedDeliveries: latest.acceptedDeliveries, proven: latest.acceptedDeliveries > 0 } : null;

  const idle = business.filter(session => session.state === "ready" && session.openRuns === 0)
    .map(session => ({ ...ref(session), lastRunAt: session.lastRunAt, idleDays: wholeDays(session.lastRunAt ?? session.createdAt, now), neverRan: session.lastRunAt === null }))
    .filter(session => session.idleDays >= idleDays)
    .sort((a, b) => b.idleDays - a.idleDays || a.sessionId.localeCompare(b.sessionId));

  const blockers: StaffingBlocker[] = [];
  if (trialsDue.length) blockers.push({ code: "TRIAL_REVIEW_OVERDUE",
    message: `有 ${trialsDue.length} 个试行职责已过回看日还没有回看：${trialsDue.map(item => `${item.title}（${day(item.reviewAtUtc)} 到期）`).join("、")}。` +
      "先用 role.review 记下继续试行、转正、合并或收回，再加业务 Session。" });
  if (lastAddition && !lastAddition.proven) blockers.push({ code: "LAST_ADDITION_UNPROVEN",
    message: `上一次加入的业务 Session「${name(lastAddition)}」（${lastAddition.roleTitle}，${day(lastAddition.createdAt)} 加入）还没有被接受的交付。` +
      "等它有一份被使用的交付，或先收回它，再加下一个。" });

  return { projectId: input.projectId, observedAt: input.now, thresholds: { idleDays }, team, trialsDue, lastAddition, idle, blockers };
}

/**
 * Why a new Session for `roleId` is refused now, or null when it may be added. A system-layer Role is never refused: its Sessions exist with the
 * project and are not a staffing decision. A written exception lets a business Session through; the caller keeps it with the reservation.
 */
export function staffingRefusal(check: StaffingCheck, roleId: string, exception?: string | null): StaffingBlocker | null {
  if (exception?.trim() || !check.blockers.length) return null;
  if (check.team.find(row => row.roleId === roleId)?.layer === "system") return null;
  return { code: check.blockers[0]!.code,
    message: `${check.blockers.map(blocker => blocker.message).join(" ")} 确有必要现在就加时，在创建时写明例外原因（staffingException），它会随这次创建一起留档。` };
}
