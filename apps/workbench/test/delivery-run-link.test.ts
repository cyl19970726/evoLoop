import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeRunRecord } from "@evoloop/contracts";
import { deliveryRunHref, recentDeliveryRunIds, verifiedDeliveryRun } from "../src/workflow/deliveryRun.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const run = { id: runId, projectId, taskId, sessionId: "44444444-4444-4444-8444-444444444444" } as RuntimeRunRecord;

test("an old Delivery opens its verified Run inside the source Task, rather than the Team landing page", () => {
  assert.equal(verifiedDeliveryRun(projectId, taskId, runId, run), run);
  assert.equal(deliveryRunHref(projectId, taskId, runId),
    `#/p/${projectId}/tasks/${taskId}?tab=runtime&run=${runId}`);
});

test("a foreign, unrelated or different Run does not earn a source link", () => {
  assert.equal(verifiedDeliveryRun(projectId, taskId, runId, { ...run, projectId: "other" }), null);
  assert.equal(verifiedDeliveryRun(projectId, taskId, runId, { ...run, taskId: "other" }), null);
  assert.equal(verifiedDeliveryRun(projectId, taskId, runId, { ...run, id: "other" }), null);
});

test("only five recent same-task Delivery sources are prefetched, even with a large history", () => {
  const deliveries = Array.from({ length: 10_000 }, (_, index) => ({ projectId, taskId, runId: `run-${index}` }));
  assert.deepEqual(recentDeliveryRunIds(deliveries, projectId, taskId),
    ["run-9995", "run-9996", "run-9997", "run-9998", "run-9999"]);
  assert.deepEqual(recentDeliveryRunIds([{ projectId: "other", taskId, runId }, { projectId, taskId: "other", runId }], projectId, taskId), []);
});
