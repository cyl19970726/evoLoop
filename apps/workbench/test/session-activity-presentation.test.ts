import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionActivity } from "@evoloop/contracts/session-observation";
import { activityPresentation } from "../src/sessions/activityPresentation.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const discussionId = "22222222-2222-4222-8222-222222222222";
const event = {
  id: "event", sequence: "1", sessionKey: "owned:session", kind: "discussion_event",
  summary: "任务沟通", occurredAt: null, recordedAt: "2026-10-26T00:00:00Z",
  actorId: "integration-owner", taskId: "33333333-3333-4333-8333-333333333333", importance: "important",
  source: { kind: "discussion", id: discussionId, revision: "event", evidence: "session-statement",
    href: `#/p/${projectId}/discussions/${discussionId}` },
} as SessionActivity;

test("related discussion identifies the recorder and opens the original discussion", () => {
  const presented = activityPresentation(event, projectId);
  assert.equal(presented.sourceLabel, "讨论记录 · 登记者 integration-owner");
  assert.equal(presented.discussionHref, `#/p/${projectId}/discussions?discussion=${discussionId}`);
});

test("unverified discussion identity cannot become a navigation target", () => {
  const presented = activityPresentation({ ...event, source: { ...event.source, id: "../other-project" } }, projectId);
  assert.equal(presented.discussionHref, null);
});

test("related task record is labeled as context rather than Session action", () => {
  const presented = activityPresentation({ ...event, source: { ...event.source, kind: "task" } }, projectId);
  assert.equal(presented.sourceLabel, "关联任务记录 · 登记者 integration-owner");
  assert.equal(presented.discussionHref, null);
});
