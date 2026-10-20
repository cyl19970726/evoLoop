import type { AppliedResult, Principal } from "@evoloop/contracts";
import type { ScheduleCommand, ScheduleDefinition, ScheduleRevision, SchedulingTransaction } from "@evoloop/contracts/scheduling";
import { DomainError } from "@evoloop/contracts/ports";
import { validateScheduleRevision } from "./due.js";

function sameRule(a: ScheduleRevision["rule"], b: ScheduleRevision["rule"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "once") return b.kind === "once" && a.atUtc === b.atUtc;
  if (a.kind === "interval") return b.kind === "interval" && a.anchorUtc === b.anchorUtc && a.everyMinutes === b.everyMinutes;
  return b.kind === "daily" && a.localTime === b.localTime;
}
function sameMisfire(a: ScheduleRevision["misfire"], b: ScheduleRevision["misfire"]): boolean {
  return a.kind === b.kind && (a.kind !== "bounded" || (b.kind === "bounded" && a.maxCatchUp === b.maxCatchUp));
}
const sameTemplate = (a: ScheduleRevision["template"], b: ScheduleRevision["template"]): boolean =>
  a.title === b.title && a.goal === b.goal && a.acceptance === b.acceptance && a.owner === b.owner;

/** Called by the shared command journal inside the project transaction. */
export async function applySchedule(tx: SchedulingTransaction, principal: Principal, command: ScheduleCommand, now: string) {
  if (!principal.projectIds.includes(command.projectId) || !principal.permissions.includes("review")) throw new DomainError("FORBIDDEN", "Schedule authorization requires project review permission");
  if (command.authorization.authorizedBy !== principal.actorId) throw new DomainError("FORBIDDEN", "Schedule authorization must identify the authenticated reviewer");
  const current = await tx.getSchedule(command.scheduleId);
  if (command.type === "schedule.create" && current) throw new DomainError("ALREADY_EXISTS", "Schedule already exists");
  if (command.type === "schedule.revise" && (!current || current.version !== command.expectedVersion)) throw new DomainError("VERSION_CONFLICT", "Schedule version changed", current?.version);
  if (current?.state === "stopped" && command.state !== "stopped") throw new DomainError("SCHEDULE_STOPPED", "A stopped schedule cannot silently resume; create a separately authorized definition");
  if (current && command.state !== "active") {
    const previous = current.revision;
    if (command.timezone !== previous.timezone || !sameRule(command.rule, previous.rule) ||
      !sameMisfire(command.misfire, previous.misfire) || command.overlap !== previous.overlap ||
      !sameTemplate(command.template, previous.template) ||
      command.authorization.scopeId !== previous.authorization.scopeId ||
      command.authorization.roleId !== previous.authorization.roleId ||
      command.authorization.expiresAtUtc !== previous.authorization.expiresAtUtc) {
      throw new DomainError("SCHEDULE_DEFINITION_IMMUTABLE", "Pausing or stopping cannot change a schedule definition");
    }
  }
  if (command.type === "schedule.create" && (Date.parse(command.watermarkUtc) > Date.parse(now) || Date.parse(command.watermarkUtc) < Date.parse(now) - 370 * 86400000)) throw new DomainError("INVALID_WATERMARK", "Initial watermark must be within the bounded past window");
  const version = current ? current.version + 1 : 1;
  const revision: ScheduleRevision = { projectId: command.projectId, scheduleId: command.scheduleId, id: command.revisionId,
    version, timezone: command.timezone, rule: command.rule, misfire: command.misfire, overlap: command.overlap,
    template: command.template, authorization: command.authorization, actorId: principal.actorId, reason: command.reason, createdAtUtc: now };
  try { validateScheduleRevision(revision); }
  catch (error) { throw new DomainError("INVALID_SCHEDULE", error instanceof Error ? error.message : "Invalid schedule"); }
  if (command.state === "active" && revision.authorization.expiresAtUtc && Date.parse(revision.authorization.expiresAtUtc) <= Date.parse(now)) throw new DomainError("AUTHORIZATION_EXPIRED", "Schedule authority has already expired");
  const definition: ScheduleDefinition = { projectId: command.projectId, id: command.scheduleId, version,
    currentRevisionId: revision.id, state: command.state, watermarkUtc: current?.watermarkUtc ?? (command.type === "schedule.create" ? command.watermarkUtc : now), revision };
  if (current) await tx.updateSchedule(definition, current.version); else await tx.insertSchedule(definition);
  const result: AppliedResult = { status: "applied", operationId: command.operationId, entityId: definition.id, version, revisionId: revision.id };
  return { result, effects: [{ kind: "schedule", entityId: definition.id, version }] };
}
