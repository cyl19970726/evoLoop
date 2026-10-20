import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { discussionCopyEnvelope } from "../src/discussions/DiscussionPanel.tsx";

test("copied discussion locator is separate from the hash-verified original", () => {
  const body = "# 固定讨论包\n\n相对材料见原固定修订。\n";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const documentId = "22222222-2222-4222-8222-222222222222";
  const revisionId = "33333333-3333-4333-8333-333333333333";
  const copied = discussionCopyEnvelope("http://127.0.0.1:4318", projectId, documentId, revisionId, body);
  assert.match(copied, /工作台入口：http:\/\/127\.0\.0\.1:4318\//);
  assert.match(copied, new RegExp(`/#/p/${projectId}/documents/${documentId}\\?revision=${revisionId}`));
  assert.ok(copied.endsWith(body));
  assert.notEqual(createHash("sha256").update(copied).digest("hex"), createHash("sha256").update(body).digest("hex"));
});
