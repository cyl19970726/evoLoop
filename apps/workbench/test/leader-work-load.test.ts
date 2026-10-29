import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderWorkDocument, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  appendLeaderWorkPage, leaderProjectionMatchesTask, leaderSessionDisplayName, leaderWorkItemPresentation,
  loadLeaderDocumentsForIds, loadLeaderWorkStatuses, visibleLeaderDocuments,
} from "../src/workflow/leaderWorkLoad.ts";
import type { WorkTaskStatus } from "../src/workflow/workStatusPresentation.ts";

const document = (id: string): LeaderWorkDocument => ({
  kind: "document", documentId: id, version: 1, title: id, documentKind: "report", status: "published",
  currentRevisionId: `${id}-current`, adoptedRevisionId: `${id}-adopted`,
  nextAction: "Review", dates: { createdAt: "2026-10-29T00:00:00Z", currentRevisionAt: "2026-10-29T00:00:00Z",
    adoptedAt: "2026-10-29T00:00:00Z", changedAt: null, observedAt: "2026-10-29T00:00:00Z" },
  references: [], actionKey: `document:${id}`,
});

test("Document lifecycle enrichment continues until every rendered row is covered", async () => {
  const ids = Array.from({ length: 137 }, (_, index) => `document-${index}`);
  const calls: Array<string | undefined> = [];
  const result = await loadLeaderDocumentsForIds(async cursor => {
    calls.push(cursor);
    const page = Number(cursor ?? 0), start = page * 50;
    return {
      items: ids.slice(start, start + 50).map(document),
      nextCursor: start + 50 < ids.length ? String(page + 1) : null,
      total: ids.length, counts: { published: ids.length }, changeSequence: 1,
      observedAt: "2026-10-29T00:00:00Z", partial: false,
    } as LeaderWorkPage<LeaderWorkTask | LeaderWorkDocument>;
  }, ids);
  assert.equal(result.complete, true);
  assert.equal(result.items.size, 137);
  assert.deepEqual(calls, [undefined, "1", "2"]);
});

test("Document lifecycle enrichment rejects a repeated cursor and reports a missing target", async () => {
  let emptyReads = 0;
  const empty = await loadLeaderDocumentsForIds(async () => {
    emptyReads++;
    throw new Error("empty visible sets do not need a lifecycle read");
  }, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.items.size, 0);
  assert.equal(emptyReads, 0);
  await assert.rejects(loadLeaderDocumentsForIds(async () => ({
    items: [], nextCursor: "loop", total: 1, counts: {}, changeSequence: 1,
    observedAt: "2026-10-29T00:00:00Z", partial: false,
  }), ["missing"]), /游标重复/);
  const missing = await loadLeaderDocumentsForIds(async () => ({
    items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1,
    observedAt: "2026-10-29T00:00:00Z", partial: false,
  }), ["missing"]);
  assert.equal(missing.complete, false);
});

test("Leader index continuation retains prior Task rows in the same changing snapshot", () => {
  const page = (ids: string[], changeSequence: number, nextCursor: string | null) => ({
    items: ids.map(taskId => ({ taskId })), nextCursor, total: 3, counts: { ready: 3 },
    changeSequence, observedAt: "2026-10-29T00:00:00Z", partial: false,
  });
  const merged = appendLeaderWorkPage(page(["one", "two"], 7, "next"),
    page(["two", "three"], 7, null));
  assert.deepEqual(merged.items.map(item => item.taskId), ["one", "two", "three"]);
  assert.equal(merged.nextCursor, null);
  assert.throws(() => appendLeaderWorkPage(page(["one"], 7, "next"),
    page(["two"], 8, null)), /快照已变化/);
});

test("Leader row statuses are deduplicated and read within the existing 50-item request limit", async () => {
  const ids = Array.from({ length: 51 }, (_, index) => `task-${index}`);
  const calls: string[][] = [];
  const result = await loadLeaderWorkStatuses([...ids, ids[0]!], async batch => {
    calls.push(batch);
    return batch.map(taskId => ({ taskId } as WorkTaskStatus));
  });
  assert.deepEqual(calls.map(batch => batch.length), [50, 1]);
  assert.equal(result.statuses.length, 51);
  assert.deepEqual(result.missing, []);
});

test("a Role-generated Session title is not treated as a registered display name", () => {
  assert.equal(leaderSessionDisplayName({ profile: { displayName: "产品文档" } as never }), "产品文档");
  assert.equal(leaderSessionDisplayName({ profile: null }), null);
});

test("active Document enrichment never asks the default index for hidden archived rows", () => {
  const items = [
    { id: "draft", title: "Draft", kind: "spec", status: "draft" as const },
    { id: "published", title: "Published", kind: "report", status: "published" as const },
    { id: "archived", title: "Archived", kind: "spec", status: "archived" as const },
  ];
  assert.deepEqual(visibleLeaderDocuments(items, "active", "all", "").map(item => item.id),
    ["draft", "published"]);
  assert.deepEqual(visibleLeaderDocuments(items, "archived", "spec", "").map(item => item.id),
    ["archived"]);
});

test("late Leader reads cannot cross Task identity, version or revision", () => {
  const current = { id: "task-two", version: 3, currentRevisionId: "revision-three" };
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 3, currentRevisionId: "revision-three",
  }, current), true);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-one", version: 3, currentRevisionId: "revision-three",
  }, current), false);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 2, currentRevisionId: "revision-three",
  }, current), false);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 3, currentRevisionId: "revision-two",
  }, current), false);
});

test("Leader overview maps historical cognition to readable source labels", () => {
  const taskId = "30000005-0000-4000-8000-000000000005";
  const item = {
    kind: "task", taskId, version: 3, currentRevisionId: `revision-${taskId}`,
    workChangeSequence: 9, title: "Cognition: business result event 25deb2bf-f765-4258-b836-41b2d8502539",
    taskKind: "research", taskState: "in_progress", phase: "awaiting_delivery",
    nextAction: "核对 Run 终态与本人提交；缺交付时保留缺口，不猜结果",
    responsible: { kind: "role", id: "cognition-role", label: "Role cognition" },
    assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null,
    goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0, review: null,
    dates: { createdAt: "2026-10-29T00:00:00Z", businessChangedAt: "2026-10-29T00:00:00Z",
      startedAt: "2026-10-29T00:00:00Z", completedAt: null, observedAt: "2026-10-29T00:00:00Z" },
    actionKey: `task:${taskId}:v3:awaiting_delivery:9`,
  } satisfies LeaderWorkTask;
  const status: WorkTaskStatus = {
    taskId, cognition: true, dispatchId: "dispatch", dispatchState: "accepted", outcome: "delivered",
    runId: "run", runState: "completed", unsettledRunState: null, loopState: "active",
    goalOutcome: "完成真实闭环验收", stageDeliverable: null, sourceKind: "worker.outcome",
    sourceTaskId: null, sourceTaskTitle: null, decisionKind: null, decisionReason: null,
    useRequired: true, deliveryId: null, technicalResult: null, observationResult: null,
    observerKind: null, hasClosure: false, readyForAcceptance: false,
  };
  const presentation = leaderWorkItemPresentation(item, status);
  assert.equal(presentation.title, "业务结果反馈 · 完成真实闭环验收");
  assert.equal(presentation.responsibility, "历史判断记录 · 原任务责任见原任务");
  assert.doesNotMatch(`${presentation.title} ${presentation.responsibility}`, /Cognition:|Role cognition|25deb2bf/);
  assert.deepEqual(leaderWorkItemPresentation({...item, title:"普通业务任务",
    responsible:{kind:"role",id:"role-1",label:"Role role-1"}}, {
    ...status,cognition:false
  }, "交付负责人"), {title:"普通业务任务",responsibility:"负责 交付负责人"});
  assert.deepEqual(leaderWorkItemPresentation({...item,
    responsible:{kind:"session",id:"session-1",label:"受管 Session session-1"},
    assignment:{state:"accepted",targetKind:"owned",targetId:"session-1",recipientActorId:"worker"},
  }, undefined, undefined, "产品文档"), {
    title:"任务记录 · 来源状态待核对",
    responsibility:"受管 Session · 产品文档",
  });
});
