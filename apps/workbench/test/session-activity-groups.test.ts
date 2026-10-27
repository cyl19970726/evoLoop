import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionActivity } from "@evoloop/contracts/session-observation";
import { groupActivities } from "../src/sessions/activityGroups.ts";

const event = (id: string, sourceId: string, taskId: string | null): SessionActivity => ({
  id, sequence: id, sessionKey: "owned:session", kind: "run.progress", summary: "相同标题",
  occurredAt: null, recordedAt: "2026-10-27T00:00:00Z", actorId: "actor", taskId,
  importance: "important", source: { kind: "run", id: sourceId, revision: null, evidence: "project-record", href: "" },
});

test("activity grouping joins identical Run sources even when event Task metadata differs", () => {
  const groups = groupActivities([
    event("4", "run-a", "task-a"), event("3", "run-a", "task-a"),
    event("2", "run-b", "task-a"), event("1", "run-a", "task-b"),
  ]);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [["4", "3", "1"], ["2"]]);
});
