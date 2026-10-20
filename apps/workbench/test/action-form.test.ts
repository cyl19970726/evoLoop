import assert from "node:assert/strict";
import { test } from "node:test";
import { readableDraft } from "../src/workflow/ActionForm.tsx";

test("the recovery draft includes every current field and preserves user text", () => {
  const fields = [
    { name: "stage", label: "阶段" },
    { name: "task", label: "任务" },
    { name: "options", label: "备选做法", kind: "textarea" as const },
  ];
  const draft = readableDraft("生成讨论包", fields, { stage: "阶段A", task: "任务B", options: "方案一\n方案二" });
  assert.match(draft, /^生成讨论包/);
  assert.match(draft, /阶段 \(stage\)\n阶段A/);
  assert.match(draft, /任务 \(task\)\n任务B/);
  assert.match(draft, /备选做法 \(options\)\n方案一\n方案二/);
  assert.doesNotMatch(draft, /token|operationId/);
});
