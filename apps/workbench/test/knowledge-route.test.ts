import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesKnowledgeRevision, transitionKnowledgeRoute } from "../src/knowledge/knowledgeRoute.ts";

const projectId = "044d070e-0000-4000-8000-000000000001";
const knowledgeId = "2b026d3e-0000-4000-8000-000000000001";
const oldRevision = "5d370000-0000-4000-8000-000000000001";
const requestedRevision = "7326818d-0000-4000-8000-000000000001";
const path = `#/p/${projectId}/knowledge`;

test("switching an already loaded page to a canonical fixed revision detaches the old body", () => {
  const oldPage = { knowledgeId, revision: oldRevision, body: "旧正文", contentHash: "旧 hash" };
  const previous = {
    route: { view: "read" as const, id: knowledgeId, revision: oldRevision },
    page: oldPage,
    history: [{ revision: oldRevision }],
    graph: { watermark: "old" },
  };

  const next = transitionKnowledgeRoute(previous, `${path}?knowledgeId=${knowledgeId}&knowledgeRevision=${requestedRevision}`, projectId);
  assert.deepEqual(next.route, { view: "read", id: knowledgeId, revision: requestedRevision });
  assert.equal(next.page, null);
  assert.deepEqual(next.history, []);
  assert.equal(next.graph, null);
  assert.equal(matchesKnowledgeRevision(oldPage, next.route.id, next.route.revision), false);
  assert.equal(matchesKnowledgeRevision(next.page, next.route.id), false);

  const failedRead = null;
  assert.equal(matchesKnowledgeRevision(failedRead, next.route.id, next.route.revision), false);
});

test("an unversioned page response remains readable when the separately fetched listing is stale", () => {
  const staleListing = { knowledgeId, revision: oldRevision };
  const currentResponse = { knowledgeId, revision: requestedRevision };
  assert.notEqual(staleListing.revision, currentResponse.revision);
  assert.equal(matchesKnowledgeRevision(currentResponse, knowledgeId), true);
  assert.equal(matchesKnowledgeRevision(currentResponse, "another-page"), false);
  assert.equal(matchesKnowledgeRevision(currentResponse, knowledgeId, oldRevision), false);
});

test("unsupported legacy child path visibly invalidates the prior knowledge selection", () => {
  const oldPage = { knowledgeId, revision: oldRevision, body: "不能冒充的旧正文" };
  const previous = {
    route: { view: "read" as const, id: knowledgeId, revision: oldRevision },
    page: oldPage,
    history: [{ revision: oldRevision }],
    graph: { watermark: "old" },
  };

  const next = transitionKnowledgeRoute(previous, `#/p/${projectId}/knowledge/${knowledgeId}?revision=${requestedRevision}`, projectId);
  assert.equal(next.route.view, "invalid");
  assert.equal(next.page, null);
  assert.deepEqual(next.history, []);
  assert.equal(next.graph, null);
  assert.equal(matchesKnowledgeRevision(oldPage, null), false);
});

test("canonical reader query rejects legacy revision and mixed selection parameters", () => {
  const oldQuery = transitionKnowledgeRoute({ route: { view: "list" as const }, page: null, history: [], graph: null },
    `${path}?knowledgeId=${knowledgeId}&revision=${requestedRevision}`, projectId);
  assert.equal(oldQuery.route.view, "invalid");

  const mixed = transitionKnowledgeRoute({ route: { view: "list" as const }, page: null, history: [], graph: null },
    `${path}?knowledgeId=${knowledgeId}&knowledgeRevision=${requestedRevision}&candidateId=other`, projectId);
  assert.equal(mixed.route.view, "invalid");
});
