import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parseArtifactReference } from "@evoloop/contracts/artifact-reference";
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
  deliveryIntent: { artifactRef: "https://example.test/report", artifactRevision: "r1", contentHash: "b".repeat(64),
    technicalResult: "passed", technicalEvidence: "checks passed", reason: "result" },
});
function fixture(state = "running") {
  const records = new Map<string, OrdinaryRunSubmissionRecord>();
  let recipient = "worker";
  let managed = false;
  const documents = new Map<string,string>();
  const workflowOperations = new Set<string>();
  const run = { id: runId, projectId, taskId, sessionId, taskRevisionId: revisionId,
    inputHash: "a".repeat(64), state } as RuntimeRunRecord;
  const store: OrdinaryRunSubmissionStore = {
    get: async id => records.get(id) ?? null,
    getByOperationId: async id => [...records.values()].find(item => item.operationId === id) ?? null,
    hasWorkflowOperation: async id => workflowOperations.has(id),
    getRun: async () => run,
    getFixedRecipient: async () => recipient,
    getDocumentRevisionHash: async (documentId, revisionId) => documents.get(`${documentId}@${revisionId}`) ?? null,
    hasManagedDispatch: async () => managed,
    insert: async item => { records.set(item.runId, item); },
  };
  return { store, records, run, documents, workflowOperations, setRecipient: (value: string) => { recipient = value; },
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

test("a prior workflow operation cannot be frozen as the future Delivery operation", async () => {
  const f = fixture();
  f.workflowOperations.add(command().deliveryOperationId);
  await assert.rejects(submit(f.store, actor("worker"), command()), { code: "OPERATION_REUSED" });
  assert.equal(f.records.size, 0);
});

test("fixed Document shorthand normalizes only after project revision and hash readback", async () => {
  const f=fixture(), docId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", docRevision="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const input=command();input.deliveryIntent.artifactRef=`document:${docId}@${docRevision}`;
  input.deliveryIntent.artifactRevision=docRevision;
  await assert.rejects(submit(f.store,actor("worker"),input),{code:"ARTIFACT_DOCUMENT_NOT_FOUND"});
  f.documents.set(`${docId}@${docRevision}`,"c".repeat(64));
  await assert.rejects(submit(f.store,actor("worker"),input),{code:"ARTIFACT_HASH_MISMATCH"});
  f.documents.set(`${docId}@${docRevision}`,"b".repeat(64));
  const saved=await submit(f.store,actor("worker"),input);
  assert.equal(saved.deliveryIntent.artifactRef,`#/p/${projectId}/documents/${docId}?revision=${docRevision}`);
  assert.equal(saved.deliveryIntent.artifactRevision,docRevision);
  assert.equal(f.records.size,1);
});

test("ambiguous Document refs and fixed version conflicts fail before saving an intent", async () => {
  const docId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", docRevision="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for(const [ref,revision,code] of [
    [`document:${docId}`,docRevision,"ARTIFACT_DOCUMENT_REVISION_REQUIRED"],
    [`document:${docId}@${docRevision}; PR https://example.test/pull/1`,docRevision,"ARTIFACT_REF_AMBIGUOUS"],
    [`#/p/99999999-9999-4999-8999-999999999999/documents/${docId}?revision=${docRevision}`,docRevision,"ARTIFACT_PROJECT_MISMATCH"],
    [`#/p/${projectId}/documents/${docId}?revision=${docRevision}`,revisionId,"ARTIFACT_REVISION_MISMATCH"],
    ["https://example.test/report", "git abc; other", "ARTIFACT_REVISION_INVALID"],
    ["repo://one&git://two", "commit1", "ARTIFACT_REF_AMBIGUOUS"],
    ["https://example.test/report,https://other.test/pull/1", "v1", "ARTIFACT_REF_AMBIGUOUS"],
  ]) {
    const f=fixture(),input=command();input.deliveryIntent.artifactRef=ref;input.deliveryIntent.artifactRevision=revision;
    await assert.rejects(submit(f.store,actor("worker"),input),{code});
    assert.equal(f.records.size,0);
  }
});

test("one external URL may contain ordinary URL punctuation",async()=>{
  for(const ref of ["https://example.test/report;a=b","https://example.test/report,part2",
    "https://web.archive.org/web/20261030/https://example.com/report",
    "https://example.test/redirect?url=https://other.test/report"]){
    const f=fixture(),input=command();input.deliveryIntent.artifactRef=ref;
    assert.equal((await submit(f.store,actor("worker"),input)).deliveryIntent.artifactRef,ref);
  }
});

test("worker compatibility references still reject compound locations", () => {
  for (const ref of ["artifact:one&two", "one&two", "fixture:one?other=two"])
    assert.throws(() => parseArtifactReference(ref,"v1",projectId,false),
      { code: "ARTIFACT_REF_INVALID" });
});
