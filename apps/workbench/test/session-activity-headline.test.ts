import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionActivity } from "@evoloop/contracts/session-observation";
import { activityHeadline } from "../src/sessions/activityPresentation.ts";

function item(kind: string, summary: string): SessionActivity {
  return { id: kind, sequence: "1", sessionKey: "owned:session", kind, summary,
    occurredAt: null, recordedAt: "2026-10-27T00:00:00Z", actorId: "lead", taskId: "task",
    importance: "important", source: { kind: "message", id: "source", revision: null, evidence: "project-record", href: "" } };
}

test("recorded message and assignment states become short labels without showing raw evidence", () => {
  assert.equal(activityHeadline([item("session_message", "会话消息 · replied"), item("session_message_processing", "消息处理 · completed")], null), "普通消息 · 已回复");
  assert.equal(activityHeadline([item("task_session_assignment", "具体分派 · accepted · Lead观察到接手，附原始证据和ID")], "改进返回接续"), "改进返回接续 · 分派已接手");
  assert.equal(activityHeadline([item("session_native_input_request", "原生提问 · resolved · native_resolved")], null), "原生提问 · 已结束");
});
