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
