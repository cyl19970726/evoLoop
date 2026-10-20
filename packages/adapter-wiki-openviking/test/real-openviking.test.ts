import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { OpenVikingKnowledgeRepository } from "../src/index.ts";

const baseUrl = process.env.OPENVIKING_TEST_URL;
const manifestRoot = process.env.OPENVIKING_TEST_MANIFEST_ROOT;

test("real OpenViking read/write/restart/withdrawal without model calls", { skip: !baseUrl || !manifestRoot }, async () => {
  const options = {
    baseUrl: baseUrl!, manifestRoot: manifestRoot!, maintainerId: "pilot",
    mayRead: async () => true, mayPropose: async () => true, mayReview: async () => true, mayPublish: async () => true, mayReconcile: async () => true,
  };
  const repository = new OpenVikingKnowledgeRepository(options);
  assert.equal((await repository.capabilities()).backendVersion, process.env.OPENVIKING_TEST_VERSION ?? "0.5.0");
  const id = randomUUID().replaceAll("-", "");
  const body = `# Pilot ${id}\n\nFixed external revision.`;
  const candidate = {
    projectId: "pilot", knowledgeId: `k_${id}`, candidateId: `c_${id}`, candidateRevision: `r_${id}`,
    expectedRevision: null, contentHash: createHash("sha256").update(body).digest("hex"), title: "Pilot",
    body, pageType: "concept" as const, epistemicStatus: "observation" as const,
    sources: [{ sourceKey: `git:pilot:${id}`, originRevision: id, contentHash: "a".repeat(64), fragment: null, state: "reachable" as const }],
    relations: [], operationId: `propose_${id}`, actorId: "pilot",
  };
  await repository.propose(candidate);
  await repository.review("pilot", { candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision,
    contentHash: candidate.contentHash, expectedRevision: null, decision: "accept", reviewerId: "pilot", reason: "pilot check" });
  const published = await repository.publish("pilot", candidate.candidateId, `publish_${id}`, "pilot");
  assert.equal(published.status, "published");
  const restarted = new OpenVikingKnowledgeRepository(options);
  assert.equal((await restarted.get("pilot", candidate.knowledgeId, candidate.candidateRevision))?.body, body);
  assert.deepEqual(await restarted.retractSource("pilot", candidate.sources[0]!.sourceKey, `withdraw_${id}`, "pilot"), [candidate.knowledgeId]);
  assert.equal((await restarted.get("pilot", candidate.knowledgeId))?.observedValidity, "needs_review");
});
