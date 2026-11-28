// 分工检查 rules (packages/core/src/staffing/index.ts): trials past their review date, whether the last business addition is proven, which ready
// Sessions are idle, what blocks a new business Session, and who is never blocked.
import assert from "node:assert/strict";
import test from "node:test";
import type { StaffingFacts, StaffingRoleFact, StaffingSessionFact } from "@evoloop/contracts/staffing";
import { buildStaffingCheck, staffingRefusal } from "../src/staffing/index.js";

const now = "2026-11-27T08:00:00.000Z";
const projectId = "00000000-0000-4000-8000-000000000001";
const days = (n: number) => new Date(Date.parse(now) - n * 86_400_000).toISOString();
const role = (roleId: string, extra: Partial<StaffingRoleFact> = {}): StaffingRoleFact =>
  ({ roleId, title: roleId, roleClass: "business", state: "active", reviewAtUtc: days(-30), trialStartedAtUtc: days(20), ...extra });
const session = (sessionId: string, roleId: string, extra: Partial<StaffingSessionFact> = {}): StaffingSessionFact =>
  ({ sessionId, roleId, displayName: sessionId, tenure: "resident", state: "ready", createdAt: days(10), runs: 5, openRuns: 0,
    lastRunAt: days(0), deliveries: 3, acceptedDeliveries: 2, ...extra });
const check = (facts: StaffingFacts, extra: { idleDays?: number; excludeSessionIds?: string[] } = {}) => buildStaffingCheck({ projectId, facts, now, ...extra });

test("a team whose trials are reviewed and whose last addition delivered has no blocker", () => {
  const result = check({ roles: [role("leader", { roleClass: "system" }), role("dev")],
    sessions: [session("leader-1", "leader"), session("dev-1", "dev"), session("dev-2", "dev", { createdAt: days(2) })] });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.trialsDue, []);
  assert.deepEqual(result.idle, []);
  assert.equal(result.lastAddition?.sessionId, "dev-2");
  assert.equal(result.lastAddition?.proven, true);
  assert.deepEqual(result.team.map(row => [row.title, row.layer, row.openSessions]), [["leader", "system", 1], ["dev", "business", 2]]);
});

test("a trial Role past its review date is due, oldest first, and blocks a new business Session", () => {
  const result = check({ roles: [role("dev", { state: "trial", reviewAtUtc: days(4) }), role("ops", { state: "trial", reviewAtUtc: days(2.5) }),
    role("later", { state: "trial", reviewAtUtc: days(-1) }), role("done", { state: "active", reviewAtUtc: days(9) })], sessions: [session("dev-1", "dev")] });
  assert.deepEqual(result.trialsDue.map(item => [item.roleId, item.daysOverdue, item.openSessions]), [["dev", 4, 1], ["ops", 2, 0]]);
  assert.deepEqual(result.blockers.map(item => item.code), ["TRIAL_REVIEW_OVERDUE"]);
  assert.match(result.blockers[0]!.message, /2 个试行职责/);
  assert.match(result.blockers[0]!.message, /role\.review/);
});

test("the last business addition without an accepted delivery blocks the next one; closing it or one used delivery lifts the block", () => {
  const roles = [role("dev")];
  const unproven = session("dev-2", "dev", { createdAt: days(1), runs: 2, deliveries: 1, acceptedDeliveries: 0 });
  const blocked = check({ roles, sessions: [session("dev-1", "dev"), unproven] });
  assert.equal(blocked.lastAddition?.sessionId, "dev-2");
  assert.equal(blocked.lastAddition?.proven, false);
  assert.deepEqual(blocked.blockers.map(item => item.code), ["LAST_ADDITION_UNPROVEN"]);
  assert.match(blocked.blockers[0]!.message, /dev-2/);
  // Withdrawn: the one before it is the last addition again.
  for (const state of ["closed", "closing"] as const) {
    const withdrawn = check({ roles, sessions: [session("dev-1", "dev"), { ...unproven, state }] });
    assert.equal(withdrawn.lastAddition?.sessionId, "dev-1");
    assert.deepEqual(withdrawn.blockers, []);
  }
  assert.deepEqual(check({ roles, sessions: [session("dev-1", "dev"), { ...unproven, acceptedDeliveries: 1 }] }).blockers, []);
});

test("system-layer Sessions are neither the last addition nor idle, and a system Role is never refused", () => {
  const result = check({ roles: [role("leader", { roleClass: "system" }), role("dev", { state: "trial", reviewAtUtc: days(3) })],
    sessions: [session("dev-1", "dev"), session("leader-2", "leader", { createdAt: days(0), runs: 0, lastRunAt: null, deliveries: 0, acceptedDeliveries: 0 }),
      session("leader-1", "leader", { lastRunAt: days(20) })] });
  assert.equal(result.lastAddition?.sessionId, "dev-1");
  assert.deepEqual(result.idle, []);
  assert.equal(result.blockers.length, 1);
  assert.equal(staffingRefusal(result, "leader"), null);
  assert.equal(staffingRefusal(result, "dev")?.code, "TRIAL_REVIEW_OVERDUE");
  // A Role the check does not list, or one with no recorded class, is judged as business.
  assert.equal(staffingRefusal(result, "unknown-role")?.code, "TRIAL_REVIEW_OVERDUE");
});

test("a written exception lets a business Session through; a blank one does not", () => {
  const result = check({ roles: [role("dev")], sessions: [session("dev-1", "dev", { acceptedDeliveries: 0 })] });
  const refusal = staffingRefusal(result, "dev");
  assert.equal(refusal?.code, "LAST_ADDITION_UNPROVEN");
  assert.match(refusal!.message, /staffingException/);
  assert.deepEqual(staffingRefusal(result, "dev", "   "), refusal);
  assert.deepEqual(staffingRefusal(result, "dev", null), refusal);
  assert.equal(staffingRefusal(result, "dev", "起步配置：产品、架构、开发三个职责各一个 Session"), null);
});

test("both blockers are said together and the trial review comes first", () => {
  const result = check({ roles: [role("dev", { state: "trial", reviewAtUtc: days(1) })], sessions: [session("dev-1", "dev", { acceptedDeliveries: 0 })] });
  assert.deepEqual(result.blockers.map(item => item.code), ["TRIAL_REVIEW_OVERDUE", "LAST_ADDITION_UNPROVEN"]);
  const refusal = staffingRefusal(result, "dev")!;
  assert.equal(refusal.code, "TRIAL_REVIEW_OVERDUE");
  assert.match(refusal.message, /回看/);
  assert.match(refusal.message, /被接受的交付/);
});

test("ready business Sessions with no Run for the threshold are idle, longest first; work in flight or another state is not idle", () => {
  const result = check({ roles: [role("dev"), role("qa")], sessions: [
    session("dev-1", "dev", { lastRunAt: days(3.2) }),
    session("dev-2", "dev", { lastRunAt: days(2.9) }),
    session("dev-3", "dev", { lastRunAt: days(8), openRuns: 1 }),
    session("qa-1", "qa", { createdAt: days(6), runs: 0, lastRunAt: null, deliveries: 0, acceptedDeliveries: 0 }),
    session("qa-2", "qa", { lastRunAt: days(9), state: "unknown" }),
    // Newest, proven, so the list below is not about the last addition.
    session("dev-4", "dev", { createdAt: days(0.5) }),
  ] });
  assert.deepEqual(result.idle.map(item => [item.sessionId, item.idleDays, item.neverRan]), [["qa-1", 6, true], ["dev-1", 3, false]]);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(check({ roles: [role("dev")], sessions: [session("dev-1", "dev", { lastRunAt: days(3.2) })] }, { idleDays: 5 }).idle, []);
});

test("Sessions a managed loop created for itself are left out; a Session of an unrecorded Role counts as business", () => {
  const facts: StaffingFacts = { roles: [role("dev")], sessions: [session("dev-1", "dev"),
    session("loop-1", "dev", { createdAt: days(0), runs: 0, lastRunAt: null, deliveries: 0, acceptedDeliveries: 0 }),
    session("old-1", "temporary-role", { createdAt: days(40), lastRunAt: days(30) })] };
  assert.equal(check(facts).lastAddition?.sessionId, "loop-1");
  const result = check(facts, { excludeSessionIds: ["loop-1"] });
  assert.equal(result.lastAddition?.sessionId, "dev-1");
  assert.deepEqual(result.idle.map(item => item.sessionId), ["old-1"]);
  assert.deepEqual(result.team.find(row => row.roleId === "temporary-role"), { roleId: "temporary-role", title: "temporary-role", layer: "business", state: "unrecorded", openSessions: 1 });
});

test("a project with no business Session may add its first one; an invalid clock is refused", () => {
  const result = check({ roles: [role("leader", { roleClass: "system" }), role("dev", { state: "candidate" })], sessions: [session("leader-1", "leader")] });
  assert.equal(result.lastAddition, null);
  assert.deepEqual(result.blockers, []);
  assert.equal(staffingRefusal(result, "dev"), null);
  assert.throws(() => buildStaffingCheck({ projectId, facts: { roles: [], sessions: [] }, now: "not a time" }), /valid instant/);
});
