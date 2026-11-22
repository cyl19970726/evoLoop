import assert from "node:assert/strict";
import test from "node:test";
import { capabilityGapText } from "../src/shared/capabilityPresentation.js";
import { isSampleTitle } from "../src/shared/sampleObjects.js";

test("engineering gap codes read as words, unknown ones keep their code", () => {
  for (const code of ["MESSAGE_GRANT_MISSING", "SESSION_NOT_READY", "SESSION_READBACK_FAILED"]) {
    assert.doesNotMatch(capabilityGapText(code), /[A-Z]{3,}_/, code);
  }
  assert.match(capabilityGapText("SOMETHING_NEW"), /SOMETHING_NEW/);
});

test("sample and do-not-handle objects are recognised, ordinary titles are not", () => {
  assert.ok(isSampleTitle("请勿处理：测试日程"));
  assert.ok(isSampleTitle("验收样本 3"));
  assert.ok(!isSampleTitle("每日评估"));
});
