import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePosition, queueStateLabel } from "../src/sessions/queuePresentation.ts";

test("Session queue shows human sequence and readable states", () => {
  assert.equal(queuePosition(0), 1);
  assert.equal(queuePosition(1), 2);
  assert.equal(queueStateLabel("queued"), "待处理");
  assert.equal(queueStateLabel("held"), "已暂停");
  assert.equal(queueStateLabel("claimed"), "已领取（占用中）");
  assert.equal(queueStateLabel("released"), "已放行");
  assert.equal(queueStateLabel("future-state"), "状态待核对（future-state）");
});
