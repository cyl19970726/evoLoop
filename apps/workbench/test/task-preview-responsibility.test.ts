import assert from "node:assert/strict";
import { test } from "node:test";
import { taskPreviewResponsibility } from "../src/features/workflow/taskPreviewResponsibility.ts";

test("current QA responsibility wins over the historical developer assignment", () => {
  assert.equal(taskPreviewResponsibility({
    responsible: { kind: "session", id: "qa-session", label: "Session qa-session" },
    assignment: { targetKind: "owned", targetId: "developer-session" },
  }, "开发 Session", null, "developer-role"), "Session qa-session");
});

test("a running assignment may use its verified Session name", () => {
  assert.equal(taskPreviewResponsibility({
    responsible: { kind: "session", id: "developer-session", label: "Session developer-session" },
    assignment: { targetKind: "owned", targetId: "developer-session" },
  }, "功能开发", null, "developer-role"), "受管 Session · 功能开发");
});

test("role name is used only for the matching owner and unknown stays unknown", () => {
  assert.equal(taskPreviewResponsibility({ responsible: { kind: "role", id: "developer-role", label: "负责职责" }, assignment: null }, null, "功能开发", "developer-role"), "负责职责 · 功能开发");
  assert.equal(taskPreviewResponsibility({ responsible: { kind: "role", id: "other-role", label: "负责职责 other-role" }, assignment: null }, null, "功能开发", "developer-role"), "负责职责 other-role");
  assert.equal(taskPreviewResponsibility({ responsible: { kind: "role", id: "developer-role", label: "负责职责 developer-role" }, assignment: null }, null, "旧负责人名称", "old-role"), "负责职责 developer-role");
  assert.equal(taskPreviewResponsibility({ responsible: { kind: "unknown", id: null, label: "责任尚未确定" }, assignment: null }, null, "功能开发", "developer-role"), "责任尚未确定");
});
