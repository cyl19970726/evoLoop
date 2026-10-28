import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { OrdinaryRunSubmissionCommand, OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { submitOrdinaryRun, type OrdinaryRunSubmissionStore } from "../src/ordinary-run-submission.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const revisionId = "55555555-5555-4555-8555-555555555555";
const actor = (actorId: string): Principal => ({ actorId, projectIds: [projectId], permissions: ["read", "write"] });
const command = (): OrdinaryRunSubmissionCommand => ({
  projectId, operationId: "66666666-6666-4666-8666-666666666666",
  submissionId: "77777777-7777-4777-8777-777777777777",
  runId, taskId, sessionId, taskRevisionId: revisionId, runInputHash: "a".repeat(64),
  deliveryOperationId: "88888888-8888-4888-8888-888888888888",
  deliveryIntent: { artifactRef: "doc/revision", artifactRevision: "r1", contentHash: "b".repeat(64),
    technicalResult: "passed", technicalEvidence: "checks passed", reason: "result" },
});
function fixture(state = "running") {
  const records = new Map<string, OrdinaryRunSubmissionRecord>();
  let recipient = "worker";
  let managed = false;
  const run = { id: runId, projectId, taskId, sessionId, taskRevisionId: revisionId,
    inputHash: "a".repeat(64), state } as RuntimeRunRecord;
  const store: OrdinaryRunSubmissionStore = {
    get: async id => records.get(id) ?? null,
    getByOperationId: async id => [...records.values()].find(item => item.operationId === id) ?? null,
    getRun: async () => run,
    getFixedRecipient: async () => recipient,
    hasManagedDispatch: async () => managed,
    insert: async item => { records.set(item.runId, item); },
  };
  return { store, records, run, setRecipient: (value: string) => { recipient = value; },
    setManaged: (value: boolean) => { managed = value; } };
}
const now = "2026-10-29T00:00:00.000Z";
const hasher = { hash: (value: string) => createHash("sha256").update(value).digest("hex") };
const submit = (store: OrdinaryRunSubmissionStore, principal: Principal, input: OrdinaryRunSubmissionCommand) =>
  submitOrdinaryRun(store, principal, input, now, hasher);

test("only the fixed recipient can sign, even when a project writer knows the Run", async () => {
  const f = fixture();
  await assert.rejects(submit(f.store, actor("lead"), command()), { code: "FORBIDDEN" });
  assert.equal(f.records.size, 0);
  const signed = await submit(f.store, actor("worker"), command());
  assert.equal(signed.submittedBy, "worker");
});

test("original operation replays after terminal, but changed text or a new ID cannot replace it", async () => {
  const f = fixture();
  const first = await submit(f.store, actor("worker"), command());
  f.run.state = "completed";
  assert.deepEqual(await submit(f.store, actor("worker"), command()), first);
  const changed = command(); changed.deliveryIntent.reason = "changed";
  await assert.rejects(submit(f.store, actor("worker"), changed), { code: "OPERATION_REUSED" });
  const replaced = command(); replaced.operationId = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(submit(f.store, actor("worker"), replaced), { code: "SUBMISSION_EXISTS" });
});

test("first intent needs exact active ordinary Run binding", async () => {
  const f = fixture("unknown");
  await assert.rejects(submit(f.store, actor("worker"), command()), { code: "RUN_NOT_ACTIVE" });
  f.run.state = "running";
  f.setManaged(true);
  await assert.rejects(submit(f.store, actor("worker"), command()), { code: "MANAGED_RUN" });
  f.setManaged(false);
  const wrong = command(); wrong.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await assert.rejects(submit(f.store, actor("worker"), wrong), { code: "RUN_MISMATCH" });
  f.setRecipient("someone-else");
  await assert.rejects(submit(f.store, actor("worker"), command()), { code: "FORBIDDEN" });
});
