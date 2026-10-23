import type { Principal } from "@evoloop/contracts";
import type { Occurrence, ScheduleDefinition, ScheduleStore } from "@evoloop/contracts/scheduling";
import { computeDue, validateScheduleRevision } from "./due.js";

export class ScheduleAccessError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleAccessError"; }
}

function authorize(principal: Principal, projectId: string, review = false): void {
  if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("write") || review && !principal.permissions.includes("review")) throw new ScheduleAccessError("schedule project or permission denied");
}

/** Core chooses slots and scope; the store atomically reserves each occurrence and proposed Task. */
export class SchedulingService {
  constructor(private readonly store: ScheduleStore) {}

  async create(principal: Principal, definition: ScheduleDefinition): Promise<ScheduleDefinition> {
    authorize(principal, definition.projectId, true);
    validateScheduleRevision(definition.revision);
    if (definition.version !== 1 || definition.revision.version !== 1 || definition.revision.actorId !== principal.actorId || definition.revision.authorization.authorizedBy !== principal.actorId || definition.revision.projectId !== definition.projectId || definition.revision.scheduleId !== definition.id || definition.revision.id !== definition.currentRevisionId) throw new ScheduleAccessError("invalid new schedule authority or revision");
    return this.store.create(definition);
  }

  async revise(principal: Principal, definition: ScheduleDefinition, expectedVersion: number): Promise<ScheduleDefinition> {
    authorize(principal, definition.projectId, true);
    validateScheduleRevision(definition.revision);
    if (definition.version !== expectedVersion + 1 || definition.revision.version !== definition.version || definition.revision.actorId !== principal.actorId || definition.revision.authorization.authorizedBy !== principal.actorId || definition.revision.projectId !== definition.projectId || definition.revision.scheduleId !== definition.id || definition.revision.id !== definition.currentRevisionId) throw new ScheduleAccessError("invalid schedule revision authority");
    return this.store.revise(definition, expectedVersion);
  }

  async tick(principal: Principal, projectId: string, nowUtc: string, authorizedScopeIds: readonly string[]): Promise<Occurrence[]> {
    authorize(principal, projectId);
    const results: Occurrence[] = [];
    const errors: string[] = [];
    for (const schedule of await this.store.listActive(projectId)) {
      try {
        const scope = schedule.revision.authorization;
        if (!scope.scopeId || !scope.roleId || !scope.authorizedBy || !authorizedScopeIds.includes(scope.scopeId)) continue;
        if (scope.expiresAtUtc && Date.parse(nowUtc) > Date.parse(scope.expiresAtUtc)) continue;
        const queued = await this.store.listQueued(projectId, schedule.id);
        for (const occurrence of queued) {
          if (occurrence.revisionId !== schedule.currentRevisionId) continue; // Revision change requires explicit queued-work review.
          if (await this.store.hasOpenOccurrence(projectId, schedule.id)) break;
          results.push(await this.store.materialize(schedule, occurrence.plannedAtUtc, nowUtc, "created", "queued occurrence admitted"));
        }
        const due = computeDue(schedule.revision, schedule.watermarkUtc, nowUtc);
        for (const plannedAtUtc of due.plannedAtUtc) {
          const overlap = await this.store.hasOpenOccurrence(projectId, schedule.id);
          const state = overlap ? schedule.revision.overlap === "queue" ? "queued" : "skipped" : "created";
          results.push(await this.store.materialize(schedule, plannedAtUtc, nowUtc, state, overlap ? `overlap ${state}` : "scheduled"));
        }
        // A watermark is a decision about examined time, not evidence of task completion.
        await this.store.advanceWatermark(projectId, schedule.id, schedule.version, due.checkedThroughUtc, `checked ${due.totalDue} slots; policy skipped ${due.skippedCount}`);
      } catch (error) {
        errors.push(`${schedule.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length) throw new ScheduleAccessError(`schedule tick failed for ${errors.join("; ")}`);
    return results;
  }
}

export { computeDue, validateScheduleRevision, ScheduleRuleError } from "./due.js";
