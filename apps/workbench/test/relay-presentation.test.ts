import assert from "node:assert/strict";
import { test } from "node:test";
import { relayProgress, relayRecipient, relayStageLabel, relayStateLabel, waitingText } from "../src/shared/workPresentation.ts";

test("acceptance relay steps read in plain words and never print raw values", () => {
  assert.equal(relayProgress({ messageState: "queued", processingState: "running", readActorId: null, humanReadAt: null, observationResult: null }),
    "消息已排队 · 处理正在处理 · 本人读取未记录 · 使用尚未关联");
  assert.equal(relayProgress({ messageState: "manual_pending", processingState: null, readActorId: "a", humanReadAt: null, observationResult: "notUsed" }),
    "消息等人工转交 · 处理尚未开始 · 本人读取已记录 · 使用未使用");
  const unknown = relayProgress({ messageState: "future_state", processingState: "other", readActorId: null, humanReadAt: null, observationResult: "x" as never });
  assert.match(unknown, /状态未识别/);
  assert.doesNotMatch(unknown, /future_state|other/);
});

test("the relay names who it hands acceptance to by kind; the recipient's identity stays in the full-identifier layer", () => {
  assert.equal(relayRecipient({ mode: "human" }), "交给指定的人");
  assert.equal(relayRecipient({ mode: "session" }), "交给业务智能体");
  assert.equal(relayRecipient({ mode: "leader" }), "交给统筹");
  for (const label of [...Object.values(relayStageLabel), ...Object.values(relayStateLabel)]) assert.doesNotMatch(label, /[A-Za-z]/);
});

test("a stage waits on a kind of party in words, the same kinds the next responsibility uses", () => {
  assert.equal(waitingText({ kind: "consumer", id: "c" }, null), "等待指定验收者");
  assert.equal(waitingText({ kind: "session", id: "s" }, { targetKind: "external", targetId: "s" }), "等待外部智能体");
  assert.equal(waitingText({ kind: "unknown", id: null }, null), "等待对象未登记");
});
