import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSchema } from "../src/index.ts";
import { canonicalUtcExample, taskTimingSchema } from "../src/task-timing.ts";

const id = (n: number) => `40000003-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { projectId: id(1), operationId: id(2) };
const create = (executeAtUtc: unknown) => ({ ...base, type: "task.create", taskId: id(3), title: "t", content: "c", acceptance: "a", owner: "o",
  timing: { executeAtUtc, timezone: "Asia/Shanghai", repeat: "none" } });
const setTiming = (executeAtUtc: unknown) => ({ ...base, type: "task.timing.set", taskId: id(3), expectedTaskVersion: 1, expectedTimingVersion: 0,
  executeAtUtc, timezone: "Asia/Shanghai", repeat: "none", scope: "this", reason: "r" });

test("a UTC time without milliseconds is accepted and stored in canonical form by task.create and task.timing.set", () => {
  for (const given of ["2026-11-12T04:00:00Z", "2026-11-12T04:00:00.0Z", "2026-11-12T04:00:00.000Z"]) {
    const created = commandSchema.parse(create(given)) as { timing: { executeAtUtc: string } };
    assert.equal(created.timing.executeAtUtc, canonicalUtcExample, given);
    assert.equal((commandSchema.parse(setTiming(given)) as { executeAtUtc: string }).executeAtUtc, canonicalUtcExample, given);
    assert.equal(taskTimingSchema.parse({ executeAtUtc: given, timezone: "UTC", repeat: "none" }).executeAtUtc, canonicalUtcExample);
  }
});

test("a malformed time is rejected with the accepted form and an example, identically on every command", () => {
  for (const bad of ["2026-11-12 04:00", "2026-11-12T04:00:00+08:00", "tomorrow", "2026-13-40T04:00:00Z", 5]) {
    for (const command of [create(bad), setTiming(bad)]) {
      const result = commandSchema.safeParse(command);
      assert.equal(result.success, false, String(bad));
      assert.match(JSON.stringify(result.error!.issues), /2026-11-12T04:00:00\.000Z/, "the rejection shows a correct example");
    }
  }
});
