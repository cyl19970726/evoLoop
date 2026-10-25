import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";
import { selectSummary, taskMatchesQueue } from "../src/overview/summary";

const queueId = "q", projectId = "p", sessionId = "s", roleId = "r";
function entry(id: string, position: number, state: ResidentQueueEntry["state"], holdCode: ResidentQueueEntry["holdCode"] = null): ResidentQueueEntry {
  return { projectId, queueId, id, taskId: id, taskRevisionId: id, sourceInputJson: "{}", sessionId, roleId, position,
    dependsOn: [], consumerId: "consumer", useRequired: true, releaseRule: "accepted", state, holdCode, holdReason: null, claimId: null, version: 1 };
}
function queue(entries: ResidentQueueEntry[], adoptedVersion: number | null = 2): ResidentQueue {
  return { projectId, id: queueId, version: 2, adoptedVersion, maxRuns: 6, reason: "reason", actorId: "lead", entries };
}

test("summary distinguishes claimed, next, held and excludes unadopted candidates", () => {
  const rows = [entry("a", 0, "claimed"), entry("b", 1, "held", "awaiting_acceptance"), entry("c", 2, "queued")];
  const selected = selectSummary([queue(rows)]);
  assert.deepEqual(selected.current.map(item => item.entry.id), ["a"]);
  assert.deepEqual(selected.held.map(item => item.entry.id), ["b"]);
  assert.deepEqual(selected.next.map(item => item.entry.id), []);
  assert.deepEqual(selectSummary([queue([entry("c", 0, "queued")], null)]).next, []);
  assert.deepEqual(selectSummary([queue([entry("c", 0, "queued")])]).next.map(item => item.entry.id), ["c"]);
});

test("summary name-read scope remains bounded", () => {
  const rows = Array.from({ length: 20 }, (_, n) => entry(String(n), n, "held", "manual_review"));
  const result = selectSummary([queue(rows)]);
  assert.equal(result.held.length, 12);
  assert.equal(result.omitted, 8);
});

test("claimed queue entry is not accepted as a current Task when owner or revision changed", () => {
  const claimed = entry("a", 0, "claimed");
  const task = { id:"a", projectId, currentRevisionId:"a", state:"in_progress", owner:roleId } as Parameters<typeof taskMatchesQueue>[0];
  assert.equal(taskMatchesQueue(task, claimed), true);
  assert.equal(taskMatchesQueue({ ...task, owner:"other" }, claimed), false);
  assert.equal(taskMatchesQueue({ ...task, currentRevisionId:"new" }, claimed), false);
});
