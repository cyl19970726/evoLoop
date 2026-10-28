import assert from "node:assert/strict";
import test from "node:test";
import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { OrdinaryRunSealPump } from "../src/ordinary-run-submission/pump.js";

test("restart scan reaches later work after one page of persistent blockers", async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({
    runId: String(i).padStart(3, "0"), createdAtUtc: "2026-10-29T00:00:00.000Z",
  })) as OrdinaryRunSubmissionRecord[];
  const seen: string[] = [];
  const pump = new OrdinaryRunSealPump({
    listProjects: async () => ["project"],
    listUnsettled: async (_project, limit, after) =>
      items.filter(x => !after || x.runId > after.runId).slice(0, limit),
    seal: async (_project, runId) => { seen.push(runId); return {status: "pending", reason: "BLOCKED"}; },
  });
  await pump.cycle();
  assert.equal(seen.length, 101);
  assert.equal(seen.at(-1), "100");
});
