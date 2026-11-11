import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceConventionFacts } from "../src/features/workflow/acceptanceConventionPresentation.ts";

test("the declared convention is shown as labelled facts", () => {
  assert.deepEqual(acceptanceConventionFacts({ acceptanceTarget: "named_agent", deliveryForm: "code", acceptancePrecondition: "release" }), [
    { label: "验收者", value: "声明的业务身份直接验收（不经验收接力）" },
    { label: "交付形态", value: "代码" },
    { label: "验收前置", value: "发布后才可验收" },
  ]);
});

test("what the Task did not declare is left out, not shown as a default", () => {
  assert.deepEqual(acceptanceConventionFacts({ acceptanceTarget: null, deliveryForm: null, acceptancePrecondition: null }), []);
  assert.deepEqual(acceptanceConventionFacts({ deliveryForm: "document" }), [{ label: "交付形态", value: "文档" }]);
  assert.deepEqual(acceptanceConventionFacts(null), []);
  assert.equal(acceptanceConventionFacts({ acceptancePrecondition: "none" })[0]?.value, "无，交付即可验收");
});
