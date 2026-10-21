import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
const projectId = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003", attemptId = "00000000-0000-4000-8000-000000000004";
const runId = "00000000-0000-4000-8000-000000000005", actualTaskRevisionId = "00000000-0000-4000-8000-000000000006";
const token = "a".repeat(40), auth = { authorization: `Bearer ${token}` };
const credentials = [{ token, actorId: "reader", projectIds: [projectId], permissions: ["read" as const] }];
const workQueries = { listRoleRevisions: async () => [], listRoleReviews: async () => [],
  listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [] };

test("evaluation fixed detail never mixes attempts from another definition revision", async () => {
  const seen: unknown[][] = [];
  const collect = async (...args: unknown[]) => { seen.push(args); return []; };
  const app = await buildServer({ credentials, service: { ...workQueries,
    getEvaluation: async (...args: unknown[]) => { seen.push(args); return { id: revisionId }; },
    listEvaluationRevisions: collect, listEvaluationAttempts: collect, listEvaluationAssessments: collect,
    listEvaluationConclusions: collect,
  } as unknown as WorkflowService });
  try {
    const url = `/api/projects/${projectId}/evaluations/${id}?revision=${revisionId}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const result = await app.inject({ url, headers: auth });
    assert.equal(result.statusCode, 200); assert.equal(result.json().revision.id, revisionId);
    assert.equal(seen.length, 5);
    for (const args of seen) { assert.equal((args[0] as { actorId: string }).actorId, "reader"); assert.equal(args[1], projectId); assert.equal(args[2], id); }
    for (const args of [seen[0]!, ...seen.slice(2)]) assert.equal(args[3], revisionId);
    assert.equal((await app.inject({ url: `${url}&revision=bad`, headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});

test("evaluation source/list readers retain authenticated project scope", async () => {
  const seen: unknown[][] = [];
  const query = async (...args: unknown[]) => {
    seen.push(args); const principal = args[0] as { projectIds: string[] };
    if (!principal.projectIds.includes(args[1] as string)) throw new DomainError("FORBIDDEN", "foreign");
    return { sourceTaskRevisionId: actualTaskRevisionId, sourceSignature: {} };
  };
  const app = await buildServer({ credentials, service: { ...workQueries, getEvaluationSourceTask: query, listEvaluations: query } as unknown as WorkflowService });
  try {
    const result = await app.inject({ url: `/api/projects/${projectId}/evaluations/source-task/${id}`, headers: auth });
    assert.equal(result.statusCode, 200); assert.equal(result.json().sourceTaskRevisionId, actualTaskRevisionId);
    assert.equal((await app.inject({ url: `/api/projects/${runId}/evaluations?taskId=${id}`, headers: auth })).statusCode, 403);
    assert.equal(seen.length, 2);
    assert.equal((await app.inject({ url: `/api/projects/${projectId}/evaluations?taskId=bad`, headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});

test("packet content is returned only for the exact recorded attempt and execution revision", async () => {
  let wrongRevision = true, reads = 0;
  const app = await buildServer({ credentials, service: { ...workQueries,
    getEvaluation: async () => ({ id: revisionId }),
    listEvaluationAttempts: async () => [{ id: attemptId, runId, actualTaskRevisionId }],
    getRuntimeRun: async () => ({ id: runId, taskRevisionId: wrongRevision ? id : actualTaskRevisionId,
      evaluationBinding: { evaluationId: id, revisionId, attemptId }, evaluationPacket: { contentHash: "a".repeat(64) } }),
  } as unknown as WorkflowService,
  readEvaluationPacket: async (_p, project, run) => { reads++; assert.equal(project, projectId); assert.equal(run, runId);
    return { content: "actual sent bytes", contentHash: "a".repeat(64), manifestHash: "b".repeat(64), builderVersion: "test", sources: [] }; },
  });
  try {
    const url = `/api/projects/${projectId}/evaluations/${id}/attempts/${attemptId}/packet?revision=${revisionId}`;
    assert.equal((await app.inject({ url, headers: auth })).statusCode, 409); assert.equal(reads, 0);
    wrongRevision = false;
    const valid = await app.inject({ url, headers: auth }); assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().content, "actual sent bytes"); assert.equal(reads, 1);
    assert.equal((await app.inject({ url: url.replace(attemptId, id), headers: auth })).statusCode, 404); assert.equal(reads, 1);
    assert.equal((await app.inject({ url: url.split("?")[0], headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});
