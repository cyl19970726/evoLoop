import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { ScheduleCommand, ScheduleDefinition, SchedulingTransaction } from "@evoloop/contracts/scheduling";
import { applySchedule } from "../src/scheduling/commands.js";

const projectId = randomUUID();
const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const now = "2026-10-20T12:00:00.000Z";
const create = (): Extract<ScheduleCommand, { type: "schedule.create" }> => ({
  type: "schedule.create", projectId, scheduleId: randomUUID(), revisionId: randomUUID(), operationId: randomUUID(),
  timezone: "UTC", rule: { kind: "daily", localTime: "09:00" }, misfire: { kind: "skip" }, overlap: "skip",
  template: { title: "Daily", content: "Review", acceptance: "Evidence", owner: "temporary-role" },
  authorization: { scopeId: "scope:daily", roleId: "temporary-role", authorizedBy: principal.actorId,
    expiresAtUtc: "2026-10-19T12:00:00.000Z" },
  watermarkUtc: now, state: "active", reason: "initial review",
});

test("expired authority may pause or stop but cannot activate or alter a definition", async () => {
  const initial = create();
  let current: ScheduleDefinition = { projectId, id: initial.scheduleId, version: 1,
    currentRevisionId: initial.revisionId, state: "active", watermarkUtc: now,
    revision: { ...initial, id: initial.revisionId, version: 1, actorId: principal.actorId, createdAtUtc: now } };
  const tx = { getSchedule: async () => current,
    updateSchedule: async (definition: ScheduleDefinition) => { current = definition; } } as unknown as SchedulingTransaction;
  const revise = (state: "active" | "paused" | "stopped"): Extract<ScheduleCommand, { type: "schedule.revise" }> => ({
    ...initial, type: "schedule.revise", state, expectedVersion: current.version,
    revisionId: randomUUID(), operationId: randomUUID(), reason: state,
  });
  await assert.rejects(() => applySchedule(tx, principal, revise("active"), now), /expired/);
  const paused = revise("paused");
  await applySchedule(tx, principal, paused, now);
  assert.equal(current.state, "paused");
  await assert.rejects(() => applySchedule(tx, principal,
    { ...revise("stopped"), template: { ...current.revision.template, title: "Changed" } }, now), /cannot change a schedule definition/);
  await assert.rejects(() => applySchedule(tx, principal,
    { ...revise("stopped"), authorization: { ...current.revision.authorization, scopeId: "scope:new" } }, now), /cannot change a schedule definition/);
  await applySchedule(tx, principal, revise("stopped"), now);
  assert.equal(current.state, "stopped");
});

test("managed Schedule target is exact and cannot be changed while pausing", async () => {
  const stageId = randomUUID(), loopId = randomUUID(), goalId = randomUUID();
  const command = create();
  command.authorization.expiresAtUtc = null;
  command.authorization.roleId = "business-role";
  command.template.owner = "business-role";
  command.template.managedTarget = { loopId, stageId };
  let current: ScheduleDefinition | null = null;
  let stageState = "active", loopState = "paused";
  const tx = {
    getSchedule: async () => current,
    getStage: async () => ({ projectId, id: stageId, goalId, state: stageState }),
    getManagedScheduleLoop: async () => ({ projectId, id: loopId, goalId, stageId, state: loopState,
      allowedBusinessRoleIds: ["business-role"] }),
    insertSchedule: async (value: ScheduleDefinition) => { current = value; },
    updateSchedule: async (value: ScheduleDefinition) => { current = value; },
  } as unknown as SchedulingTransaction;
  await applySchedule(tx, principal, command, now);
  assert.equal(current!.revision.template.managedTarget?.loopId, loopId);
  const revise = (state: "active" | "paused" | "stopped", template = command.template): Extract<ScheduleCommand, { type: "schedule.revise" }> =>
    ({ ...command, type: "schedule.revise", state, expectedVersion: current!.version,
      revisionId: randomUUID(), operationId: randomUUID(), template });
  await assert.rejects(() => applySchedule(tx, principal, revise("paused",
    { ...command.template, managedTarget: { loopId: randomUUID(), stageId } }), now), /cannot change a schedule definition/);
  stageState = "reviewed"; loopState = "stopped";
  await assert.rejects(() => applySchedule(tx, principal, revise("active"), now), /active Stage/);
  await applySchedule(tx, principal, revise("stopped"), now);
  assert.equal(current!.state, "stopped");
});

test("scheduled human acceptance must name its consumer before the definition is saved", async () => {
  const command=create();
  command.authorization.expiresAtUtc=null;
  command.template.acceptanceMode="human_required";
  let saved:ScheduleDefinition|null=null;
  const tx={getSchedule:async()=>null,insertSchedule:async(value:ScheduleDefinition)=>{saved=value;}} as unknown as SchedulingTransaction;
  await assert.rejects(()=>applySchedule(tx,principal,command,now),/human-required/);
  assert.equal(saved,null);
  command.template.consumer="actual-user";
  await applySchedule(tx,principal,command,now);
  assert.equal(saved?.revision.template.consumer,"actual-user");
});

test("only the named human can change a human-required Schedule acceptance contract across pause and resume", async () => {
  const namedHuman: Principal = { actorId: "actual-user", projectIds: [projectId],
    permissions: ["read", "write", "review"], identityKind: "human" };
  const initial = create();
  initial.authorization.expiresAtUtc = null;
  initial.template.consumer = namedHuman.actorId;
  initial.template.acceptanceMode = "human_required";
  let current: ScheduleDefinition = { projectId, id: initial.scheduleId, version: 1,
    currentRevisionId: initial.revisionId, state: "active", watermarkUtc: now,
    revision: { ...initial, id: initial.revisionId, version: 1, actorId: principal.actorId, createdAtUtc: now } };
  const revisions: ScheduleDefinition[] = [current];
  const tx = { getSchedule: async () => current,
    updateSchedule: async (definition: ScheduleDefinition) => { current = definition; revisions.push(definition); } } as unknown as SchedulingTransaction;
  const revise = (template: ScheduleCommand["template"], state: ScheduleDefinition["state"] = "active"): Extract<ScheduleCommand, { type: "schedule.revise" }> => ({
    ...initial, type: "schedule.revise", state, expectedVersion: current.version,
    revisionId: randomUUID(), operationId: randomUUID(), template, reason: "revise acceptance",
  });

  await assert.rejects(() => applySchedule(tx, principal, revise({ ...initial.template, acceptanceMode: "independent_agent" }), now),
    error => (error as { code?: string }).code === "TRUSTED_HUMAN_REQUIRED");
  await assert.rejects(() => applySchedule(tx, principal, revise({ ...initial.template, consumer: "another-user" }), now),
    error => (error as { code?: string }).code === "TRUSTED_HUMAN_REQUIRED");
  assert.equal(current.version, 1);
  assert.equal(revisions.length, 1);

  const paused = await applySchedule(tx, principal, revise(initial.template, "paused"), now);
  assert.equal(paused.result.status, "applied");
  assert.equal(current.state, "paused");
  for (const state of ["active", "paused", "stopped"] as const) {
    await assert.rejects(() => applySchedule(tx, principal,
      revise({ ...initial.template, acceptanceMode: "independent_agent", consumer: undefined }, state), now),
      error => (error as { code?: string }).code === "TRUSTED_HUMAN_REQUIRED");
  }
  await assert.rejects(() => applySchedule(tx, principal,
    revise({ ...initial.template, consumer: "another-user" }), now),
    error => (error as { code?: string }).code === "TRUSTED_HUMAN_REQUIRED");
  assert.equal(current.version, 2);
  await applySchedule(tx, principal, revise(initial.template, "paused"), now);
  assert.equal(current.revision.template.acceptanceMode, "human_required");
  let stoppedCurrent = current;
  const stopTx = { getSchedule: async () => stoppedCurrent,
    updateSchedule: async (definition: ScheduleDefinition) => { stoppedCurrent = definition; } } as unknown as SchedulingTransaction;
  await applySchedule(stopTx, principal, revise(initial.template, "stopped"), now);
  assert.equal(stoppedCurrent.state, "stopped");
  assert.equal(stoppedCurrent.revision.template.consumer, namedHuman.actorId);

  const authorized = revise({ ...initial.template, acceptanceMode: "independent_agent" });
  authorized.authorization = { ...authorized.authorization, authorizedBy: namedHuman.actorId };
  const applied = await applySchedule(tx, namedHuman, authorized, now);
  assert.equal(applied.result.status, "applied");
  assert.equal(current.version, 4);
  assert.equal(current.revision.template.acceptanceMode, "independent_agent");
  assert.equal(current.revision.template.consumer, namedHuman.actorId);
  assert.equal(revisions.length, 4);
  assert.equal(revisions[0]?.revision.template.acceptanceMode, "human_required");
  assert.equal(revisions[0]?.revision.template.consumer, namedHuman.actorId);
});
