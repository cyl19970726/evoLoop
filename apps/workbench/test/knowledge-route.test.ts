import assert from "node:assert/strict";
import { test } from "node:test";
import { findFixedKnowledgeTitle, knowledgeHref, matchesKnowledgeRevision, readKnowledgeRoute, readingOnScreen,
  unresolvedFixedKnowledgeTitle } from "../src/features/knowledge/knowledgeRoute.ts";

const projectId = "044d070e-0000-4000-8000-000000000001";
const knowledgeId = "2b026d3e-0000-4000-8000-000000000001";
const oldRevision = "5d370000-0000-4000-8000-000000000001";
const requestedRevision = "7326818d-0000-4000-8000-000000000001";
const path = `/p/${projectId}/knowledge`;

test("switching pages keeps the previous page on screen only as the previous page", () => {
  const projectPage = (revision: string) => ({ projectId, knowledgeId, revision, body: "旧正文" });
  const oldPage = projectPage(oldRevision);
  // The next fixed revision is loading: the old body stays, marked previous, never as the revision asked for.
  assert.deepEqual(readingOnScreen(oldPage, true, projectId, knowledgeId, requestedRevision), { page: oldPage, previous: true });
  // Even a cached answer that no longer matches the address is previous.
  assert.equal(readingOnScreen(oldPage, false, projectId, knowledgeId, requestedRevision).previous, true);
  assert.equal(readingOnScreen(oldPage, false, projectId, "another-page").previous, true);
  // From a fixed link back to the current version: the fixed body is a placeholder until the current one arrives.
  assert.equal(readingOnScreen(oldPage, true, projectId, knowledgeId).previous, true);
  assert.equal(readingOnScreen(projectPage(requestedRevision), false, projectId, knowledgeId, requestedRevision).previous, false);
  // Another project's answer is never shown.
  assert.deepEqual(readingOnScreen({ ...oldPage, projectId: "other" }, false, projectId, knowledgeId), { page: null, previous: false });
  assert.deepEqual(readingOnScreen(undefined, false, projectId, knowledgeId), { page: null, previous: false });
});

test("an unversioned page response remains readable when the separately fetched listing is stale", () => {
  const staleListing = { knowledgeId, revision: oldRevision };
  const currentResponse = { knowledgeId, revision: requestedRevision };
  assert.notEqual(staleListing.revision, currentResponse.revision);
  assert.equal(matchesKnowledgeRevision(currentResponse, knowledgeId), true);
  assert.equal(matchesKnowledgeRevision(currentResponse, "another-page"), false);
  assert.equal(matchesKnowledgeRevision(currentResponse, knowledgeId, oldRevision), false);
  assert.equal(matchesKnowledgeRevision(null, knowledgeId), false);
});

test("unsupported legacy child path and mixed parameters are invalid, not a silent list", () => {
  assert.equal(readKnowledgeRoute(`/p/${projectId}/knowledge/${knowledgeId}?revision=${requestedRevision}`, projectId).view, "invalid");
  assert.equal(readKnowledgeRoute(`${path}?knowledgeId=${knowledgeId}&revision=${requestedRevision}`, projectId).view, "invalid");
  assert.equal(readKnowledgeRoute(`${path}?knowledgeId=${knowledgeId}&knowledgeRevision=${requestedRevision}&candidateId=other`, projectId).view, "invalid");
  assert.equal(readKnowledgeRoute(`${path}?knowledgeRevision=${requestedRevision}`, projectId).view, "invalid");
  assert.equal(readKnowledgeRoute(`/p/${projectId}/documents`, projectId).view, "outside");
  assert.deepEqual(readKnowledgeRoute(`${path}?review=1`, projectId), { view: "review" });
  assert.deepEqual(readKnowledgeRoute(`${path}?candidateId=c1`, projectId), { view: "review", id: "c1" });
});

test("knowledge links round-trip and keep the fixed-link parameter order", () => {
  const fixed = knowledgeHref(projectId, { knowledgeId, revision: requestedRevision });
  assert.equal(fixed, `${path}?knowledgeId=${knowledgeId}&knowledgeRevision=${requestedRevision}`);
  assert.deepEqual(readKnowledgeRoute(fixed, projectId), { view: "read", id: knowledgeId, revision: requestedRevision });
  assert.deepEqual(readKnowledgeRoute(knowledgeHref(projectId, { knowledgeId }), projectId), { view: "read", id: knowledgeId, revision: undefined });
  assert.deepEqual(readKnowledgeRoute(knowledgeHref(projectId, "review"), projectId), { view: "review" });
  assert.deepEqual(readKnowledgeRoute(knowledgeHref(projectId, { candidateId: "c1" }), projectId), { view: "review", id: "c1" });
  assert.deepEqual(readKnowledgeRoute(knowledgeHref(projectId), projectId), { view: "list" });
});

test("relation titles resolve by both fixed knowledge ID and revision, never by current title alone", () => {
  const historicalTitle = "固定材料可读与实际使用证据要分别核对";
  const currentTitle = "固定证据、实际使用与完整旅程须分别验收";
  const sameIdDifferentRevision = [
    { knowledgeId, revision: oldRevision, title: historicalTitle },
    { knowledgeId, revision: requestedRevision, title: currentTitle },
  ];
  assert.equal(findFixedKnowledgeTitle(knowledgeId, oldRevision, sameIdDifferentRevision), historicalTitle);
  assert.equal(findFixedKnowledgeTitle(knowledgeId, requestedRevision, sameIdDifferentRevision), currentTitle);
  assert.equal(findFixedKnowledgeTitle(knowledgeId, "another-revision", sameIdDifferentRevision), null);
  assert.equal(unresolvedFixedKnowledgeTitle, "固定目标（标题未读取）");
});
