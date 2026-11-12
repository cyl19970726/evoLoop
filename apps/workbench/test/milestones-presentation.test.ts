import assert from "node:assert/strict";
import { test } from "node:test";
import { milestoneRows, versionView, VERSION_UNREAD } from "../src/features/overview/milestonesPresentation.ts";

test("a missing commit reads 版本未读到, never an old value; links stay public", () => {
  const view = versionView({ commit: null, builtAt: null, startedAt: "2026-11-12T08:00:00.000Z" });
  assert.equal(view.readable, false); assert.equal(view.commit, VERSION_UNREAD); assert.equal(view.builtAt, VERSION_UNREAD);
  assert.ok(view.links.every(link => link.href.startsWith("https://github.com/")));
  assert.equal(versionView(null).startedAt, VERSION_UNREAD);
});
test("a read commit shows 7 chars and a commit link", () => {
  const view = versionView({ commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", builtAt: "2026-11-12T03:10:00.000Z", startedAt: "2026-11-12T08:00:00.000Z" });
  assert.equal(view.commit, "9a4020a"); assert.equal(view.builtAt, "2026-11-12 03:10 UTC");
  assert.ok(view.links[0]!.href.endsWith("/commit/9a4020a5886be01b2d74fe850687ca7355b2d226"));
});
test("unlinked phases say 未登记 and none is current", () => {
  const rows = milestoneRows({ source: { commit: null, roadmap: "read" }, currentPhaseId: null, currentNote: "当前阶段未登记",
    phases: [{ id: "M0", title: "t", deliver: "d", exit: "e", status: null, statusLabel: null, stage: null, linkedStages: 0, reviewedAt: null }] });
  assert.equal(rows[0]!.status, "未登记"); assert.equal(rows[0]!.date, "未登记"); assert.equal(rows[0]!.current, false);
});

test("the date column says three different things: no link, linked but never reviewed, linked and reviewed", () => {
  const phase = (id: string, stage: { id: string; goalId: string } | null, reviewedAt: string | null) =>
    ({ id, title: "t", deliver: "d", exit: "e", status: stage ? "in_progress" as const : null, statusLabel: stage ? "进行中" : null, stage, linkedStages: stage ? 1 : 0, reviewedAt });
  const rows = milestoneRows({ source: { commit: null, roadmap: "read" }, currentPhaseId: null, currentNote: null, phases: [
    phase("M0", null, null), phase("M1", { id: "s1", goalId: "g" }, null), phase("M2", { id: "s2", goalId: "g" }, "2026-11-10T09:00:00.000Z"),
  ] });
  assert.deepEqual(rows.map(row => row.date), ["未登记", "暂无回看", "回看于 2026-11-10"]);
  // An unlinked phase says 未登记 even if a date somehow came with it: nothing is read off a stage that is not linked.
  assert.equal(milestoneRows({ source: { commit: null, roadmap: "read" }, currentPhaseId: null, currentNote: null, phases: [phase("M0", null, "2026-11-10T09:00:00.000Z")] })[0]!.date, "未登记");
});
