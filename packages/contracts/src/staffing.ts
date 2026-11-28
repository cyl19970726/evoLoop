// 分工检查 (staffing check): what the project's own records say about its team right now, in one read. It answers the three things the team rules
// ask before a business Session is added (DEC-038, DEC-055): is a trial past its review date with no review, has the last addition produced an accepted
// delivery, and which ready Sessions have had no work for days. Read-only; derived from the Role, Session, Run, Delivery and observation records, never stored.
import { z } from "zod";
import type { RoleState } from "./roles.js";
import type { RuntimeSessionState } from "./runtime.js";

/** A ready business Session with no Run for this many days is listed as idle. An initial value, not a calibrated one. */
export const staffingIdleDays = 3;
/** The written reason that lets a business Session be added while the check has blockers; kept with the reservation. */
export const staffingExceptionSchema = z.string().trim().min(1).max(4000);

/** The system layer exists with the project and does not grow with the workload; the business layer grows one change at a time (DEC-055). */
export type StaffingLayer = "system" | "business";
export type StaffingBlockerCode = "TRIAL_REVIEW_OVERDUE" | "LAST_ADDITION_UNPROVEN";

export interface StaffingRoleFact {
  roleId: string; title: string; roleClass: StaffingLayer | null; state: RoleState; reviewAtUtc: string; trialStartedAtUtc: string | null;
}
export interface StaffingSessionFact {
  sessionId: string;
  /** The Role the Session was reserved for; an older Session may name one that is not a Role record. */
  roleId: string;
  displayName: string | null; tenure: "resident" | "temporary" | "unknown" | null;
  state: RuntimeSessionState; createdAt: string;
  runs: number;
  /** Runs that are requested, dispatching, running or of unknown outcome. */
  openRuns: number;
  /** When the latest Run last changed; null when the Session never ran one. */
  lastRunAt: string | null;
  deliveries: number;
  /** Deliveries of this Session's Runs that have a `used` observation. */
  acceptedDeliveries: number;
}
export interface StaffingFacts { roles: StaffingRoleFact[]; sessions: StaffingSessionFact[] }
export interface StaffingFactsReader { staffingFacts(): Promise<StaffingFacts> }

export interface StaffingTeamRow {
  roleId: string; title: string; layer: StaffingLayer; state: RoleState | "unrecorded";
  /** Sessions of this Role that are not closed or closing. */
  openSessions: number;
}
export interface StaffingTrialDue {
  roleId: string; title: string; layer: StaffingLayer; reviewAtUtc: string;
  /** Whole days since the review date. */
  daysOverdue: number; openSessions: number;
}
export interface StaffingSessionRef { sessionId: string; displayName: string | null; roleId: string; roleTitle: string; createdAt: string }
export interface StaffingLastAddition extends StaffingSessionRef {
  runs: number; deliveries: number; acceptedDeliveries: number;
  /** True once one of its deliveries was used by its consumer. */
  proven: boolean;
}
export interface StaffingIdleSession extends StaffingSessionRef {
  lastRunAt: string | null;
  /** Whole days since the last Run, or since the Session was created when it never ran. */
  idleDays: number; neverRan: boolean;
}
export interface StaffingBlocker { code: StaffingBlockerCode; message: string }

export interface StaffingCheck {
  projectId: string; observedAt: string;
  thresholds: { idleDays: number };
  /** Every Role with an open Session or still in use (candidate, trial, active, retirement-pending), system layer first. */
  team: StaffingTeamRow[];
  /** Trial Roles whose review date has passed with the Role still in trial, oldest first. */
  trialsDue: StaffingTrialDue[];
  /** The most recently created open business Session; null when the project has none. */
  lastAddition: StaffingLastAddition | null;
  /** Ready business Sessions with no Run for `thresholds.idleDays` days or more and nothing in flight, longest first: suggested for withdrawal. */
  idle: StaffingIdleSession[];
  /** Why a new business Session would be refused now; empty when one may be added. */
  blockers: StaffingBlocker[];
}
