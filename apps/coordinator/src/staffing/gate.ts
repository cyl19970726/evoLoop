// The team growth rules at the door (DEC-038, DEC-055). A request to reserve a business Session is refused while a trial Role is past its review date
// or the last addition has no accepted delivery, unless the request states its exception. The judgment is the staffing check's own (core), read from
// the same records the 分工检查 page and CLI show, so what a person reads and what the door does cannot differ. Nothing is written here.
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { StaffingCheck } from "@evoloop/contracts/staffing";
import { staffingRefusal } from "@evoloop/core/staffing";

export interface StaffingConfiguration { enabled: boolean; projectIds: string[]; idleDays: number }
export interface StaffingGateDeps {
  /** Read on each use: a changed configuration file takes effect without a restart. Absent: no staffing section. */
  configuration(): Promise<StaffingConfiguration | undefined>;
  check(principal: Principal, projectId: string, options: { idleDays?: number; excludeSessionIds?: string[] }): Promise<StaffingCheck>;
  /** The Sessions a managed loop created for itself; the rules do not cover them. */
  dynamicSessionIds(projectId: string): Promise<string[]>;
}

/** What every staffing read passes to the check: the configured idle threshold and the Sessions left out. */
export const staffingReadOptions = (deps: Pick<StaffingGateDeps, "configuration" | "dynamicSessionIds">) => async (projectId: string) => {
  const configuration = await deps.configuration();
  return { ...(configuration ? { idleDays: configuration.idleDays } : {}), excludeSessionIds: await deps.dynamicSessionIds(projectId) };
};

/** Throws the refusal for this reservation, or returns when it may go on. Off unless the project is listed in an enabled staffing section. */
export async function assertStaffingAllows(deps: StaffingGateDeps, principal: Principal,
  command: { projectId: string; roleId: string; staffingException?: string | undefined }): Promise<void> {
  const configuration = await deps.configuration();
  if (!configuration?.enabled || !configuration.projectIds.includes(command.projectId)) return;
  const check = await deps.check(principal, command.projectId, await staffingReadOptions(deps)(command.projectId));
  const refusal = staffingRefusal(check, command.roleId, command.staffingException);
  if (refusal) throw new DomainError(refusal.code, refusal.message);
}
