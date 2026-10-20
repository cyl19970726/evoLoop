import type { Principal } from "@evoloop/contracts";
import type { Occurrence, ScheduleDefinition, ScheduleStore } from "@evoloop/contracts/scheduling";
import { SchedulingService } from "@evoloop/core/scheduling";
import type { AuthConfig } from "../auth.js";

export interface ScheduleGrant {
  projectId: string;
  actorId: string;
  scopeId: string;
  roleId: string;
}

export interface SchedulingPumpOptions {
  store: ScheduleStore;
  canWrite(): boolean;
  credentials(): AuthConfig;
  grants(): readonly ScheduleGrant[];
  enabled(): boolean;
  now?(): string;
  intervalMs?: number;
  onError?(error: unknown): void;
}

export type PumpState = "stopped" | "idle" | "running" | "disabled" | "unavailable" | "no-authority" | "error";
export interface PumpStatus {
  state: PumpState;
  lastTickAt: string | null;
  lastError: string | null;
  lastCreated: number;
}
export interface PumpTickResult {
  state: "completed" | "disabled" | "unavailable" | "no-authority" | "busy" | "stopped";
  occurrences: Occurrence[];
}

const sameGrant = (a: ScheduleGrant, b: ScheduleGrant): boolean =>
  a.projectId === b.projectId && a.actorId === b.actorId && a.scopeId === b.scopeId && a.roleId === b.roleId;
const grantKey = (grant: ScheduleGrant): string =>
  `${grant.projectId}\0${grant.actorId}\0${grant.scopeId}\0${grant.roleId}`;

/** A process-local pump. The coordinator lease and scoped PG reservations remain the cross-process gates. */
export class SchedulingPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<PumpTickResult> | null = null;
  private started = false;
  private stopped = false;
  private current: PumpStatus = { state: "idle", lastTickAt: null, lastError: null, lastCreated: 0 };

  constructor(private readonly options: SchedulingPumpOptions) {
    if (options.intervalMs !== undefined && (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1000)) {
      throw new RangeError("schedule interval must be at least one second");
    }
  }

  status(): PumpStatus {
    if (this.stopped) return { ...this.current, state: "stopped" };
    if (!this.options.enabled()) return { ...this.current, state: "disabled" };
    if (!this.options.canWrite()) return { ...this.current, state: "unavailable" };
    return { ...this.current };
  }

  async start(): Promise<PumpTickResult> {
    if (this.stopped) throw new Error("stopped scheduling pump cannot restart");
    if (this.started) throw new Error("scheduling pump already started");
    this.started = true;
    let result: PumpTickResult;
    try { result = await this.tickOnce(); }
    catch (error) { this.started = false; throw error; }
    if (this.stopped) return { state: "stopped", occurrences: [] };
    this.timer = setInterval(() => {
      void this.tickOnce().catch(error => {
        if (this.options.onError) this.options.onError(error);
        else console.error("Scheduling tick failed:", error);
      });
    }, this.options.intervalMs ?? 30_000);
    this.timer.unref();
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    this.current = { ...this.current, state: "stopped" };
  }

  tickOnce(): Promise<PumpTickResult> {
    if (this.stopped) return Promise.resolve({ state: "stopped", occurrences: [] });
    if (this.inFlight) return Promise.resolve({ state: "busy", occurrences: [] });
    const pending = this.runTick();
    this.inFlight = pending;
    void pending.finally(() => { if (this.inFlight === pending) this.inFlight = null; }).catch(() => undefined);
    return pending;
  }

  private principal(grant: ScheduleGrant): Principal | null {
    const credential = this.options.credentials().find(item => item.actorId === grant.actorId &&
      item.projectIds.includes(grant.projectId) && item.permissions.includes("write") && item.permissions.includes("review"));
    return credential ? { actorId: credential.actorId, projectIds: [...credential.projectIds], permissions: [...credential.permissions] } : null;
  }

  private permitted(grant: ScheduleGrant, definition?: ScheduleDefinition): boolean {
    if (this.stopped || !this.options.enabled() || !this.options.canWrite() || !this.principal(grant)) return false;
    if (!this.options.grants().some(item => sameGrant(item, grant))) return false;
    if (!definition) return true;
    const authority = definition.revision.authorization;
    return definition.projectId === grant.projectId && definition.state === "active" &&
      authority.authorizedBy === grant.actorId && authority.scopeId === grant.scopeId &&
      authority.roleId === grant.roleId &&
      (!authority.expiresAtUtc || Date.parse(this.options.now?.() ?? new Date().toISOString()) < Date.parse(authority.expiresAtUtc));
  }

  private guardedStore(grant: ScheduleGrant): ScheduleStore {
    const store = this.options.store;
    const demand = async (projectId: string, scheduleId: string): Promise<void> => {
      const current = await store.get(projectId, scheduleId);
      if (!current || !this.permitted(grant, current)) throw new Error("schedule authority or coordinator lease was withdrawn");
    };
    return {
      create: definition => store.create(definition),
      get: (projectId, scheduleId) => store.get(projectId, scheduleId),
      listActive: async projectId => (await store.listActive(projectId)).filter(item => this.permitted(grant, item)),
      revise: (definition, expectedVersion) => store.revise(definition, expectedVersion),
      materialize: async (definition, plannedAtUtc, observedAtUtc, state, reason) => {
        await demand(definition.projectId, definition.id);
        return store.materialize(definition, plannedAtUtc, observedAtUtc, state, reason);
      },
      getOccurrence: (projectId, scheduleId, plannedAtUtc) => store.getOccurrence(projectId, scheduleId, plannedAtUtc),
      hasOpenOccurrence: (projectId, scheduleId) => store.hasOpenOccurrence(projectId, scheduleId),
      listQueued: (projectId, scheduleId) => store.listQueued(projectId, scheduleId),
      advanceWatermark: async (projectId, scheduleId, expectedVersion, throughUtc, reason) => {
        await demand(projectId, scheduleId);
        return store.advanceWatermark(projectId, scheduleId, expectedVersion, throughUtc, reason);
      },
    };
  }

  private async runTick(): Promise<PumpTickResult> {
    const empty = (state: PumpTickResult["state"]): PumpTickResult => ({ state, occurrences: [] });
    if (!this.options.enabled()) { this.current = { ...this.current, state: "disabled" }; return empty("disabled"); }
    if (!this.options.canWrite()) { this.current = { ...this.current, state: "unavailable" }; return empty("unavailable"); }
    this.current = { ...this.current, state: "running", lastError: null };
    const now = this.options.now?.() ?? new Date().toISOString();
    try {
      if (!Number.isFinite(Date.parse(now))) throw new Error("invalid schedule clock");
      const grants = [...new Map(this.options.grants().map(grant => [grantKey(grant), grant])).values()];
      const valid = grants.filter(grant => this.permitted(grant));
      if (!valid.length) {
        this.current = { ...this.current, state: "no-authority", lastTickAt: now, lastCreated: 0 };
        return empty("no-authority");
      }
      const occurrences: Occurrence[] = [];
      for (const grant of valid) {
        if (!this.permitted(grant)) continue;
        const principal = this.principal(grant);
        if (!principal) continue;
        const service = new SchedulingService(this.guardedStore(grant));
        occurrences.push(...await service.tick(principal, grant.projectId, now, [grant.scopeId]));
      }
      this.current = { state: "idle", lastTickAt: now, lastError: null,
        lastCreated: occurrences.filter(item => item.state === "created").length };
      return { state: "completed", occurrences };
    } catch (error) {
      this.current = { ...this.current, state: "error", lastTickAt: now,
        lastError: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}
