import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DiscussionEvent, DiscussionRecord } from "@evoloop/contracts";
import { commandSchema } from "@evoloop/contracts";
import { discussionCopyEnvelope, discussionDecisionPayload } from "../src/discussions/DiscussionPanel.tsx";

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

test("ordinary decision retains the registered head without silently adding recovery", () => {
  const record = { id: "discussion", version: 5, currentDocumentRevisionId: "registered" } as DiscussionRecord;
  const head = { version: 4, revisionId: "registered", contentHash: "a".repeat(64), author: "owner", body: "# head" };
  const values = { choice: "维持", unresolved: "仍需观察", relookCondition: "出现反例", evidence: "核对记录", reason: "已审阅" };
  const command = discussionDecisionPayload(record, undefined, head, values);
  assert.equal(command.documentRevisionId, "registered");
  assert.equal(command.documentRecovery, undefined);
  assert.equal(command.expectedVersion, 5);
});

test("mismatched head requires deliberate confirmation and uses observed Document CAS while preserving old decision", () => {
  const record = { id: "discussion", version: 5, currentDocumentRevisionId: "old", latestDecisionEventId: "prior" } as DiscussionRecord;
  const decision = { id: "prior" } as DiscussionEvent;
  const head = { version: 6, revisionId: "actual-head", contentHash: "b".repeat(64), author: "editor", body: "# changed" };
  const values = { choice: "继续", unresolved: "未决", relookCondition: "下次", evidence: "两版已核", reason: "本次决定" };
  assert.throws(() => discussionDecisionPayload(record, decision, head, values));
  assert.throws(() => discussionDecisionPayload(record, decision, head, { ...values, confirmRecovery: "confirmed", documentRecoveryReason: " " }));
  const command = discussionDecisionPayload(record, decision, head, { ...values, confirmRecovery: "confirmed", documentRecoveryReason: " 当前文档由负责人修订，确认从此版续记 " });
  assert.equal(command.documentRevisionId, "actual-head");
  assert.deepEqual(command.documentRecovery, { expectedDocumentVersion: 6, reason: "当前文档由负责人修订，确认从此版续记" });
  assert.equal(command.supersedesDecisionEventId, "prior");
  assert.equal(record.currentDocumentRevisionId, "old");
  assert.equal(command.confirmRecovery, undefined);
});

test("confirmed recovery payload passes the shared command schema with the actual Document head", () => {
  const discussionId = "11111111-1111-4111-8111-111111111111";
  const oldRevision = "22222222-2222-4222-8222-222222222222";
  const actualHead = "33333333-3333-4333-8333-333333333333";
  const record = { id: discussionId, version: 5, currentDocumentRevisionId: oldRevision } as DiscussionRecord;
  const values = { choice: "维持现状", unresolved: "待观察", relookCondition: "来源变化", evidence: "两版已核对", reason: "完成审阅",
    confirmRecovery: "confirmed", documentRecoveryReason: "从文档实际当前版续记" };
  const payload = discussionDecisionPayload(record, undefined,
    { version: 6, revisionId: actualHead, contentHash: "a".repeat(64), author: "owner", body: "# current" }, values);
  const parsed = commandSchema.parse({ ...payload, projectId: discussionId, operationId: oldRevision });
  assert.equal(parsed.type, "discussion.decision.record");
  if (parsed.type === "discussion.decision.record") {
    assert.equal(parsed.documentRevisionId, actualHead);
    assert.deepEqual(parsed.documentRecovery, { expectedDocumentVersion: 6, reason: "从文档实际当前版续记" });
  }
});
