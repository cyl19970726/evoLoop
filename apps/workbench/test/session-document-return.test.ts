import assert from "node:assert/strict";
import { test } from "node:test";
import { isProjectRoute } from "../src/ui/returnRoute.ts";
import { deliveryTarget } from "../src/workflow/deliveryPresentation.ts";

const projectId = "96000001-0000-4000-8000-000000000001";
const documentId = "96000002-0000-4000-8000-000000000002";
const revisionId = "96000003-0000-4000-8000-000000000003";
const sessionKey = "owned:96000004-0000-4000-8000-000000000004";
const source = `#/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey, tab: "results", filter: "all", open: "run:fixed", panel: "conversation" })}`;
const fixedDocument = `#/p/${projectId}/documents/${documentId}?revision=${revisionId}`;
const delivery = { artifactRef: fixedDocument, artifactRevision: revisionId, contentHash: "a".repeat(64) };

test("Document source validation accepts the same project's exact Session view", () => {
  assert.equal(isProjectRoute(source, projectId), true);
  assert.equal(isProjectRoute(source.replace(projectId, documentId), projectId), false);
  assert.equal(isProjectRoute(`https://example.test/${source}`, projectId), false);
  assert.equal(isProjectRoute(`#/p/${projectId}/not-a-page?session=${sessionKey}`, projectId), false);
});

test("Session delivery source context preserves the declared fixed Document and revision", () => {
  const target = deliveryTarget(delivery, projectId, source);
  assert.equal(target.kind, "document");
  if (target.kind !== "document") throw new Error("Expected a verified fixed Document");
  assert.equal(target.documentId, documentId);
  assert.equal(target.revisionId, revisionId);
  const [path, query] = target.href.split("?");
  const params = new URLSearchParams(query);
  assert.equal(path, fixedDocument.split("?")[0]);
  assert.equal(params.get("revision"), revisionId);
  assert.equal(params.get("return"), source);
  assert.equal(params.getAll("revision").length, 1);
  assert.equal(params.getAll("return").length, 1);
  assert.equal(deliveryTarget(delivery, projectId, source.replace(projectId, documentId)).href, fixedDocument);
  assert.equal(deliveryTarget({ ...delivery, artifactRevision: documentId }, projectId, source).href, null);
});
