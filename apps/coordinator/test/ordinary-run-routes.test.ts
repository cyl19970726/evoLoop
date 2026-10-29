import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { registerOrdinaryRunSubmissionRoutes } from "../src/ordinary-run-submission/routes.js";

const projectId = randomUUID(), runId = randomUUID();
const principal: Principal = { actorId: "signer", projectIds: [projectId], permissions: ["read", "write"] };
const record = { projectId, runId, submittedBy: principal.actorId, state: "sealed",
  terminalRunVersion: 4, deliveryIntent: { technicalResult: "passed" } } as OrdinaryRunSubmissionRecord;

async function readStatus(runVersion: number, runState: RuntimeRunRecord["state"]) {
  const app = Fastify();
  app.addHook("onRequest", async request => { request.principal = principal; });
  registerOrdinaryRunSubmissionRoutes(app, {
    submit: async () => { throw new Error("not used"); },
    getByOperation: async () => { throw new Error("not used"); },
    getByRun: async () => record,
    readRun: async () => ({ version: runVersion, state: runState } as RuntimeRunRecord),
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/ordinary-runs/${runId}/submission` });
    assert.equal(response.statusCode, 200);
    return response.json();
  } finally { await app.close(); }
}

test("submission read marks historical seal stale after terminal correction", async () => {
  const current = await readStatus(4, "completed");
  assert.equal(current.status, "sealed");
  const revised = await readStatus(5, "failed");
  assert.equal(revised.status, "blocked");
  assert.equal(revised.reason, "TERMINAL_RUN_VERSION_CHANGED");
  assert.equal(revised.submission.state, "sealed", "historical settlement remains visible");
});
