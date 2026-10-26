import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "@evoloop/contracts";
import type { Reader } from "@evoloop/contracts/ports";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { requireAssignedSession } from "../src/session-assignments/dispatch.ts";
const task = { id: "task", currentRevisionId: "fixed" } as Task;
const reader = (value: Partial<TaskSessionAssignment> | null) => ({ sessionAssignments: { getTaskSessionAssignment: async () => value } }) as unknown as Reader;

test("concrete external or different owned assignment cannot be bypassed by same-Role execution", async () => {
  await assert.rejects(requireAssignedSession(reader({ target: { kind: "external", linkId: "chat" }, state: "accepted", taskRevisionId: "fixed" }), task, "owned"), { code: "TASK_ASSIGNED_ELSEWHERE" });
  await assert.rejects(requireAssignedSession(reader({ target: { kind: "owned", sessionId: "other" }, state: "assigned", taskRevisionId: "fixed" }), task, "owned"), { code: "TASK_ASSIGNED_ELSEWHERE" });
});
test("new execution requires current explicit assignment; existing claim keeps its own independent fixed authority", async () => {
  const r = reader({ target: { kind: "owned", sessionId: "owned" }, state: "accepted", taskRevisionId: "old" });
  await assert.rejects(requireAssignedSession(r, task, "owned"), { code: "ASSIGNMENT_STALE" });
  await requireAssignedSession(r, task, "owned", true);
  await assert.rejects(requireAssignedSession(r, task, "other", true), { code: "TASK_ASSIGNED_ELSEWHERE" });
});
test("legacy and explicitly released assignments preserve existing authorized dispatch behavior", async () => {
  await requireAssignedSession(reader(null), task, "owned");
  await requireAssignedSession(reader({ state: "released" }), task, "owned");
});
