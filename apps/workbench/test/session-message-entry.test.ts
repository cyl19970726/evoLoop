import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionCapabilities } from "@evoloop/contracts/session-work";
import { sessionMessageEntry } from "../src/sessions/sessionMessageEntry.ts";

const capability = { available: false, reason: null };
const base: SessionCapabilities = { observe: capability, send: { available: true, reason: "只保存消息", mode: "owned-read-only" },
  open: { ...capability, ref: null }, interrupt: capability, close: capability };
const observedAt = "2026-10-27T00:00:00Z";

test("disabled owned execution stays saveable but says it will not auto-reply", () => {
  const entry = sessionMessageEntry("owned", { ...base, ordinaryExecution: { state: "disabled",
    reasonCode: "SESSION_MESSAGES_DISABLED", reason: "普通自动回复未启用；保存后当前不会启动此会话。", observedAt } });
  assert.equal(entry.actionTitle, "保存待处理");
  assert.equal(entry.canSave, true);
  assert.match(entry.introduction, /待派发.*不表示已送达/);
  assert.equal(entry.executionLabel, "未启用");
  assert.match(entry.executionReason, /不会启动此会话/);
  assert.equal(entry.sendReason, "只保存消息");
});

test("older snapshots and unverified execution never imply automatic readiness", () => {
  const older = sessionMessageEntry("owned", base);
  assert.equal(older.executionLabel, "暂不可核实");
  assert.match(older.executionReason, /不能预期自动回复/);
  const pending = sessionMessageEntry("owned", { ...base, ordinaryExecution: { state: "unverified",
    reasonCode: "NATIVE_CHECK_PENDING", reason: "执行前仍须核验原生只读能力。", observedAt } });
  assert.equal(pending.executionLabel, "执行前待核验");
  assert.match(pending.executionReason, /核验原生只读能力/);
  const blocked = sessionMessageEntry("owned", { ...base, ordinaryExecution: { state: "blocked",
    reasonCode: "EXACT_GRANT_MISSING", reason: "当前没有精确消息授权。", observedAt } });
  assert.equal(blocked.executionLabel, "受限");
  assert.equal(blocked.executionReason, "当前没有精确消息授权。");
  const readOnly = sessionMessageEntry("owned", { ...base, send: { available: false, reason: "当前身份只有读取权限。", mode: "unavailable" } });
  assert.equal(readOnly.canSave, false);
  assert.equal(readOnly.sendReason, "当前身份只有读取权限。");
});

test("external Session keeps manual handoff wording and uses its observed reason", () => {
  const entry = sessionMessageEntry("external", { ...base, send: { available: true, reason: "外部消息可保存", mode: "manual-handoff" },
    ordinaryExecution: { state: "manual", reasonCode: "EXTERNAL_HANDOFF", reason: "需要人工转交给原会话。", observedAt } });
  assert.equal(entry.actionTitle, "保存人工转交");
  assert.match(entry.introduction, /外部会话需人工转交/);
  assert.equal(entry.executionReason, "需要人工转交给原会话。");
  assert.equal(entry.sendReason, "外部消息可保存");
  const revoked = sessionMessageEntry("external", { ...base, send: { available: false, reason: "外部连接已撤销。", mode: "unavailable" },
    ordinaryExecution: { state: "blocked", reasonCode: "EXTERNAL_LINK_REVOKED", reason: "已撤销的连接不可人工转交。", observedAt } });
  assert.equal(revoked.canSave, false);
  assert.match(revoked.introduction, /不能.*保存或转交/);
  assert.doesNotMatch(revoked.introduction, /需人工转交/);
  assert.equal(revoked.executionReason, "已撤销的连接不可人工转交。");
});
