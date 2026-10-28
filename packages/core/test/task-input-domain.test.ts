import test from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskRevision } from "@evoloop/contracts";
import type { Reader } from "@evoloop/contracts/ports";
import { evaluationCommands } from "../../contracts/src/evaluation.js";
import { canonicalTaskInputJson, taskInputSignature } from "../src/task-input.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "10000000-0000-4000-8000-000000000002";
const revisionId = "10000000-0000-4000-8000-000000000003";
const contentDocumentId = "10000000-0000-4000-8000-000000000004";
const contentRevisionId = "10000000-0000-4000-8000-000000000005";
const basisSetId = "10000000-0000-4000-8000-000000000006";
const domainA = "10000000-0000-4000-8000-000000000007";
const domainB = "10000000-0000-4000-8000-000000000008";
const hash = "a".repeat(64);

const task = { projectId, id: taskId, currentRevisionId: revisionId } as Task;
function readerFor(domainId: string | null | undefined): Reader {
  const revision = { projectId, taskId, id: revisionId, title: "Same work", content: "Same body",
    contentDocumentId, contentRevisionId, acceptance: "Same acceptance", owner: "same owner",
    kind: null, domainId, basisSetId } as TaskRevision;
  return {
    getTaskRevision: async () => revision,
    getBasisSet: async () => ({ projectId, taskId, taskRevisionId: revisionId, id: basisSetId,
      sealed: true, members: [{ documentId: contentDocumentId, revisionId: contentRevisionId }] }),
    getDocumentRevision: async () => ({ projectId, documentId: contentDocumentId, id: contentRevisionId,
      contentHash: hash }),
    listTaskExternalSnapshot: async () => [],
    getTaskProposal: async () => null,
  } as unknown as Reader;
}

test("changing only the selected business domain changes the canonical Task input", async () => {
  const a = await taskInputSignature(readerFor(domainA), task);
  const b = await taskInputSignature(readerFor(domainB), task);
  assert.equal(a.domainId, domainA);
  assert.equal(b.domainId, domainB);
  assert.notEqual(canonicalTaskInputJson(a), canonicalTaskInputJson(b));
  assert.deepEqual({ ...a, domainId: undefined }, { ...b, domainId: undefined });
});

test("legacy Task input omits domainId for both null and undefined", async () => {
  const expected = { title: "Same work", content: "Same body", contentDocumentId, contentRevisionId,
    acceptance: "Same acceptance", owner: "same owner", kind: "unclassified",
    basis: [{ documentId: contentDocumentId, revisionId: contentRevisionId, contentHash: hash }],
    retentions: [], external: [] };
  const legacyJson = canonicalTaskInputJson(expected);
  for (const domainId of [null, undefined]) {
    const actual = await taskInputSignature(readerFor(domainId), task);
    assert.equal(Object.hasOwn(actual, "domainId"), false);
    assert.equal(canonicalTaskInputJson(actual), legacyJson);
  }
});

test("evaluation source signature accepts both new domain and persisted legacy shapes", async () => {
  const schema = evaluationCommands[0].shape.definition.shape.case.shape.sourceSignature;
  for (const domainId of [domainA, null]) {
    const { content: _content, ...signature } = await taskInputSignature(readerFor(domainId), task);
    assert.equal(schema.safeParse(signature).success, true);
  }
});
