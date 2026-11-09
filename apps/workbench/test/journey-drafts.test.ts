// 目标与阶段 drafts are kept with the baseline they were written against (review of #268, item 1). A form mounted again
// after someone else saved a newer version restores the draft but refuses to send it until the person has looked;
// a correction draft written for one review is never sent against a later one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Goal, Stage, StageReview } from "@evoloop/contracts";
import type { MutationContext } from "../src/shared/ActionForm.tsx";
import { DraftsContext, GoalReviseForm, StageCorrectForm, draftKeys, type Drafts } from "../src/features/workflow/JourneyForms.tsx";
import { openingBaseline, submissionRefusal, useCommand } from "../src/shared/command/index.ts";

const projectId = "43000001-0000-4000-8000-000000000001";
const goalId = "43000002-0000-4000-8000-000000000002";
const stageId = "43000003-0000-4000-8000-000000000003";
const [reviewOne, reviewTwo] = ["43000004", "43000005"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const stamp = "2026-11-10T00:00:00.000Z";
const context: MutationContext = {
  token: "", projectId, blocked: false, principal: { actorId: "writer", projectIds: [projectId], permissions: ["read", "write", "review"] } as MutationContext["principal"],
  onAttempt: async () => true, onKnown: () => undefined, onChanged: () => undefined,
};
const goal = (version: number, outcome: string): Goal => ({ projectId, id: goalId, version, outcome, constraints: "约束", consumer: "试用团队",
  authority: "授权", scope: "范围", owner: "负责人", actorId: "writer", createdAt: stamp });
const stage = (version: number): Stage => ({ projectId, id: stageId, goalId, version, deliverable: "交付", learningQuestion: "问题", state: "reviewed", actorId: "writer", createdAt: stamp });
const review = (id: string, adopted: string, supersedes: string | null = null): StageReview => ({ projectId, id, stageId, stageVersion: 3, supersedesReviewId: supersedes,
  adopted, rejected: "无", gap: "无", nextChoice: "continue", evidence: "记录", reason: "回看", actorId: "writer", createdAt: stamp });
function render<P extends object>(store: Drafts, form: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(DraftsContext.Provider, { value: store }, createElement(form, props)));
}
// The class list mentions `disabled:` variants; the attribute itself renders as disabled="".
const submitDisabled = (html: string) => /<button[^>]*type="submit"[^>]*\sdisabled=""/.test(html);

test("scenario a: a goal draft written on version 1 is restored on version 2 but cannot be sent until looked at", () => {
  const store: Drafts = new Map();
  // A types a revision reason on version 1 (RecordForm keeps it with the baseline it saw), then switches away.
  store.set(draftKeys.goal(goalId), { values: { outcome: goal(1, "让试用团队用上工作台").outcome, constraints: "约束", consumer: "试用团队", authority: "授权", scope: "范围", owner: "负责人", reason: "A 的修订理由" }, baseline: "1" });
  // B saves version 2; A comes back and the form mounts again on version 2.
  const html = render(store, GoalReviseForm, { context, goal: goal(2, "B 改过的结果"), paused: null });
  assert.match(html, /A 的修订理由/, "the draft is restored");
  assert.match(html, /这份草稿写于较早的版本/);
  assert.equal(submitDisabled(html), true, "it cannot be sent with version 2's baseline");
  assert.equal(submissionRefusal({ busy: false, blocked: false, stale: false, recorded: openingBaseline(store.get(draftKeys.goal(goalId)), "2"), current: "2" }), "baseline");
  // Without a kept draft the same form opens on version 2 and may be sent.
  const fresh = render(new Map(), GoalReviseForm, { context, goal: goal(2, "B 改过的结果"), paused: null });
  assert.doesNotMatch(fresh, /这份草稿写于较早的版本|A 的修订理由/);
  assert.equal(submitDisabled(fresh), false);
});

test("scenario b: a correction draft for review R1 is never sent against R2", () => {
  const store: Drafts = new Map();
  store.set(draftKeys.correct(stageId, reviewOne), { values: { adopted: "按 R1 写的纠正", rejected: "", gap: "", nextChoice: "stop", evidence: "", reason: "R1 的理由" }, baseline: `3:${reviewOne}` });
  // Someone appends R2 (stage version 4); the reread mounts the correction form for R2.
  const html = render(store, StageCorrectForm, { context, stage: stage(4), latest: review(reviewTwo, "R2 的认识", reviewOne), paused: null });
  assert.doesNotMatch(html, /按 R1 写的纠正|R1 的理由/, "the R1 draft is not filled into the R2 form");
  assert.match(html, /R2 的认识/, "the form starts from R2");
  assert.match(html, /还有一份针对较早回看写的草稿/, "the R1 draft is offered, not lost");
  assert.equal(submitDisabled(html), false);
  // Even if a draft with R1's baseline were kept under R2's key, it is refused rather than sent with R2's baseline.
  const mixed: Drafts = new Map([[draftKeys.correct(stageId, reviewTwo), { values: { adopted: "按 R1 写的纠正", rejected: "", gap: "", nextChoice: "stop", evidence: "", reason: "R1 的理由" }, baseline: `3:${reviewOne}` }]]);
  const refused = render(mixed, StageCorrectForm, { context, stage: stage(4), latest: review(reviewTwo, "R2 的认识", reviewOne), paused: null });
  assert.match(refused, /这份草稿写于较早的版本/);
  assert.equal(submitDisabled(refused), true);
});

test("useCommand keeps its old call shape: no draft option means the opening baseline is what is on screen", () => {
  let seen: ReturnType<typeof useCommand> | null = null;
  const Probe = () => { seen = useCommand(context, "7"); return null; };
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen!.recordedBaseline, "7");
  assert.equal(seen!.baselineChanged, false);
  assert.equal(seen!.restoredDraft, undefined);
  assert.equal(openingBaseline(undefined, "7"), "7");
  assert.equal(openingBaseline({ values: {}, baseline: "6" }, "7"), "6");
});
