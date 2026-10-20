import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Occurrence, ScheduleDefinition, ScheduleStore } from "@evoloop/contracts/scheduling";
import type { AuthConfig } from "../src/auth.js";
import { SchedulingPump, type ScheduleGrant } from "../src/scheduling/pump.js";

const projectId = randomUUID(), scheduleId = randomUUID(), revisionId = randomUUID();
const at = "2026-10-20T10:00:00.000Z";
const grant: ScheduleGrant = { projectId, actorId: "scheduler-owner", scopeId: "scope:daily", roleId: "temporary-role" };
const credentials: AuthConfig = [{ token: "t".repeat(32), actorId: grant.actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }];
const definition: ScheduleDefinition = {
  projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state: "active",
  watermarkUtc: "2026-10-20T09:00:00.000Z",
  revision: { projectId, scheduleId, id: revisionId, version: 1, timezone: "UTC",
    rule: { kind: "once", atUtc: "2026-10-20T09:30:00.000Z" }, misfire: { kind: "latest" },
    overlap: "skip", template: { title: "Inspect", content: "# Check", acceptance: "Record", owner: "temporary-role" },
    authorization: { scopeId: grant.scopeId, roleId: grant.roleId, authorizedBy: grant.actorId, expiresAtUtc: null },
    actorId: grant.actorId, reason: "explicit scope", createdAtUtc: "2026-10-20T09:00:00.000Z" },
};

function fixture() {
  let currentGrants: ScheduleGrant[] = [grant];
  let currentCredentials: AuthConfig = credentials;
  let enabled = true, writable = true, created = 0;
  let onList: (() => Promise<void>) | null = null;
  let onOverlap: (() => void) | null = null;
  const store: ScheduleStore = {
    create: async value => value,
    get: async () => definition,
    listActive: async () => { if (onList) await onList(); return [definition]; },
    revise: async value => value,
    materialize: async (_value, plannedAtUtc, observedAtUtc, state, reason): Promise<Occurrence> => {
      created++;
      return { projectId, scheduleId, revisionId, plannedAtUtc, observedAtUtc, state, taskId: state === "created" ? randomUUID() : null,
        operationId: randomUUID(), reason };
    },
    getOccurrence: async () => null,
    hasOpenOccurrence: async () => { onOverlap?.(); return false; },
    listQueued: async () => [],
    advanceWatermark: async () => undefined,
  };
  const pump = new SchedulingPump({ store, canWrite: () => writable, credentials: () => currentCredentials,
    grants: () => currentGrants, enabled: () => enabled, now: () => at, intervalMs: 60_000 });
  return { pump, get created() { return created; }, setGrants: (value: ScheduleGrant[]) => { currentGrants = value; },
    setCredentials: (value: AuthConfig) => { currentCredentials = value; }, setEnabled: (value: boolean) => { enabled = value; },
    setWritable: (value: boolean) => { writable = value; }, setOnList: (value: (() => Promise<void>) | null) => { onList = value; },
    setOnOverlap: (value: (() => void) | null) => { onOverlap = value; } };
}

test("pump reports disabled, lease loss and revoked authority without producing tasks", async () => {
  const f = fixture();
  f.setEnabled(false);
  assert.equal((await f.pump.tickOnce()).state, "disabled");
  f.setEnabled(true); f.setWritable(false);
  assert.equal((await f.pump.tickOnce()).state, "unavailable");
  f.setWritable(true); f.setGrants([]);
  assert.equal((await f.pump.tickOnce()).state, "no-authority");
  f.setGrants([grant]); f.setCredentials([{ ...credentials[0]!, permissions: ["read"] }]);
  assert.equal((await f.pump.tickOnce()).state, "no-authority");
  assert.equal(f.created, 0);
});

test("pump prevents reentry and rechecks grants after asynchronous schedule reads", async () => {
  const f = fixture();
  let release!: () => void;
  f.setOnList(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.pump.tickOnce();
  assert.equal((await f.pump.tickOnce()).state, "busy");
  f.setGrants([]);
  release();
  assert.equal((await first).state, "completed");
  assert.equal(f.created, 0);
  assert.equal(f.pump.status().state, "idle");
});

test("revocation during due calculation fails visibly before reservation", async () => {
  const f = fixture();
  f.setOnOverlap(() => f.setGrants([]));
  await assert.rejects(f.pump.tickOnce(), /authority or coordinator lease was withdrawn/);
  assert.equal(f.created, 0);
  assert.equal(f.pump.status().state, "error");
  assert.match(f.pump.status().lastError ?? "", /withdrawn/);
});

test("start ticks immediately and stop prevents later work", async () => {
  const f = fixture();
  assert.equal((await f.pump.start()).state, "completed");
  assert.equal(f.created, 1);
  await f.pump.stop();
  assert.equal((await f.pump.tickOnce()).state, "stopped");
  assert.equal(f.created, 1);
});
