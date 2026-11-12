import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "@evoloop/contracts/ports";
import { ResidentQueuePump } from "../src/resident-queue/pump.js";

const projectId = randomUUID(), queueId = randomUUID(), entryId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID();
const lead = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
const queue = { projectId, id: queueId, version: 3, adoptedVersion: 3, actorId: "lead", entries: [{
  id: entryId, state: "queued", position: 0, sessionId, taskId, dependsOn: [], version: 5, claimId: null, holdCode: null, useRequired: false }] };

test("an entry claimed while the provider is held stays queued with no saved result, and the same claim goes through after the release", async () => {
  const claims: Array<{ operationId: string; claimId: string; runId: string }> = [];
  let held = true;
  const workflow = {
    listResidentQueues: async () => [queue],
    execute: async (_principal: unknown, command: { type: string; operationId: string; claimId: string; runOperationId: string }) => {
      claims.push({ operationId: command.operationId, claimId: command.claimId, runId: command.runOperationId });
      // The service throws the hold; it journals nothing, exactly as WorkflowService.execute does.
      if (held) throw new DomainError("PROVIDER_HELD", "provider paused");
      return { status: "applied", operationId: command.operationId, entityId: entryId, version: 4 };
    },
  };
  const errors: unknown[] = [];
  const pump = new ResidentQueuePump({ workflow: workflow as never, credentials: async () => [lead], enabled: async () => true, canWrite: () => true,
    pollIntervalMs: 1000, onError: error => errors.push(error) });
  await pump.tick(); await pump.tick(); await pump.tick();
  assert.equal(claims.length, 3, "it keeps looking while the provider is held");
  assert.deepEqual(errors, [], "a hold is not an error: nothing is logged every tick");
  held = false;
  await pump.tick();
  assert.equal(claims.length, 4);
  assert.equal(new Set(claims.map(claim => claim.operationId)).size, 1, "the one intent is used again: nothing was saved against it, so it now applies");
  assert.deepEqual(errors, []);
});

test("other claim failures are still reported", async () => {
  const workflow = { listResidentQueues: async () => [queue], execute: async () => { throw new Error("DATABASE_DOWN"); } };
  const errors: unknown[] = [];
  const pump = new ResidentQueuePump({ workflow: workflow as never, credentials: async () => [lead], enabled: async () => true, canWrite: () => true,
    pollIntervalMs: 1000, onError: error => errors.push(error) });
  await pump.tick();
  assert.equal(errors.length, 1);
});
