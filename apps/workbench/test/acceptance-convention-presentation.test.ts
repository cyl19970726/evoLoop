import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceConventionFacts } from "../src/features/workflow/acceptanceConventionPresentation.ts";

test("the declared convention is shown as labelled facts", () => {
  assert.deepEqual(acceptanceConventionFacts({ acceptanceTarget: "named_agent", acceptancePrecondition: "release" }), [
    { label: "验收者", value: "声明的业务身份直接验收（不经验收接力）" },
    { label: "验收前置", value: "发布后才可验收" },
  ]);
});

test("what the Task did not declare is left out, not shown as a default", () => {
  assert.deepEqual(acceptanceConventionFacts({ acceptanceTarget: null, acceptancePrecondition: null }), []);
  assert.deepEqual(acceptanceConventionFacts(null), []);
  assert.equal(acceptanceConventionFacts({ acceptancePrecondition: "none" })[0]?.value, "无，交付即可验收");
});

import { taskKinds } from "../src/features/workflow/taskCreate.ts";
import { kindFilterLabels, matchesFilters } from "../src/features/workflow/taskListModel.ts";
import { taskType, taskTypeLabel } from "../src/features/workflow/taskWorkspacePresentation.ts";
import { taskKindSchema } from "@evoloop/contracts";

test("all six work types have one label everywhere: create form, type filter, detail and the update options", () => {
  const kinds = taskKindSchema.options;
  assert.deepEqual([...kinds].sort(), ["defect", "documentation", "implementation", "operation", "research", "validation"]);
  for (const kind of kinds) {
    assert.ok(taskTypeLabel[kind], `${kind} has a label`);
    assert.equal(taskKinds[kind], taskTypeLabel[kind], "the create form uses the same label");
    assert.equal(kindFilterLabels[kind], taskTypeLabel[kind], "the type filter uses the same label");
    assert.equal(taskType(kind), taskTypeLabel[kind], "the detail uses the same label");
  }
  assert.equal(taskTypeLabel.defect, "缺陷");
  assert.equal(taskType(null), "未分类", "an older Task without a type stays unclassified");
});

test("the type filter selects defects and leaves the other types out", () => {
  const view = (kind: string) => ({ query: "", filter: "all", kind }) as never;
  const task = (kind: string | null) => ({ id: "t", title: "x", state: "todo", kind, version: 1, currentRevisionId: "r", owner: "o", acceptance: "a", content: "" }) as never;
  assert.equal(matchesFilters(task("defect"), view("defect")), true);
  assert.equal(matchesFilters(task("implementation"), view("defect")), false);
  assert.equal(matchesFilters(task(null), view("defect")), false);
  assert.equal(matchesFilters(task("defect"), view("all")), true);
});

import { preconditionStatus } from "../src/features/workflow/acceptanceConventionPresentation.ts";

test("the precondition line reads 未满足 until a mark exists, then 已满足 with who and when, and says nothing when there is nothing to wait for", () => {
  const fmt = (value: string) => `<${value.slice(0, 10)}>`;
  const waiting = preconditionStatus({ acceptancePrecondition: "release", readiness: "waiting_precondition", preconditionMark: null }, fmt);
  assert.deepEqual(waiting, { waiting: true, text: "前置：未满足（等待发布，尚未标记已满足）", evidence: null });
  const met = preconditionStatus({ acceptancePrecondition: "migration", readiness: "ready",
    preconditionMark: { actorId: "release-owner", evidence: "ran 096", markedAt: "2026-11-12T03:00:00.000Z" } }, fmt, id => `「${id}」`);
  assert.deepEqual(met, { waiting: false, text: "前置：已满足（「release-owner」，<2026-11-12>）", evidence: "ran 096" });
  assert.equal(preconditionStatus({ acceptancePrecondition: "release", readiness: null }, fmt), null, "no delivery yet");
  assert.equal(preconditionStatus({ acceptancePrecondition: "none", readiness: "ready" }, fmt), null);
  assert.equal(preconditionStatus({ acceptancePrecondition: null, readiness: "ready" }, fmt), null);
  assert.equal(preconditionStatus(null, fmt), null);
});
