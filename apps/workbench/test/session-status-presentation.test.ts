import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLifecycleLabel, sessionStatusLabel } from "../src/sessions/sessionStatusPresentation.ts";

test("owned lifecycle takes priority over activity and only ready can be idle", () => {
  for (const [runtimeState, expected] of [["reserved", "已预留"], ["creating", "创建中"], ["closing", "关闭中"], ["unknown", "生命周期待核对"], ["closed", "已关闭"]] as const) {
    assert.equal(sessionStatusLabel({ kind: "owned", runtimeState, busy: false }), expected);
    assert.equal(sessionStatusLabel({ kind: "owned", runtimeState, busy: true }), expected);
  }
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: false }), "空闲");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: true }), "有在途或未知结果");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: null, busy: false }), "生命周期未知");
  assert.equal(sessionLifecycleLabel({ kind: "owned", runtimeState: "closed", busy: false }), "已关闭");
});

test("external sessions keep unverified activity separate from owned lifecycle", () => {
  assert.equal(sessionStatusLabel({ kind: "external", runtimeState: null, busy: null }), "状态未知");
  assert.match(sessionLifecycleLabel({ kind: "external", runtimeState: null, busy: null }), /需核对/);
});
