// 待我处理: which deliveries wait for me to use them (H1), and what the count in the shell may claim (L1).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConsumerObservation } from "@evoloop/contracts";
import type { LeaderWorkDeliveryFact, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  deliveredAt, deliveryLink, inboxBadge, judgeMyDelivery, lastUseText, myLatestObservation, shellInboxCount, useRequirementText,
} from "../src/features/workflow/inboxModel.ts";
import { readDeliveriesForMe } from "../src/features/workflow/inboxDeliveries.ts";

const me = "consumer-a", other = "consumer-b";
const stamp = "2026-11-09T01:00:00.000Z";
const delivery = (fact: Partial<LeaderWorkDeliveryFact> = {}): LeaderWorkDeliveryFact => ({
  deliveryId: "delivery-1", taskRevisionId: "rev-2", technicalResult: "passed", consumer: me, useRequired: true,
  observationResult: null, observationActorId: null, observationKind: null, ...fact,
});
const task = (fact: Partial<LeaderWorkDeliveryFact> | null = {}, extra: Partial<LeaderWorkTask> = {}): LeaderWorkTask => ({
  kind: "task", taskId: extra.taskId ?? "task-1", version: 2, currentRevisionId: "rev-2", workChangeSequence: 1, title: "截图说明",
  taskKind: "implementation", taskState: "in_progress", phase: "awaiting_acceptance", nextAction: "", responsible: { kind: "consumer", id: me, label: me },
  assignment: null, latestRun: null, delivery: fact === null ? null : delivery(fact), pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
  plan: null, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp }, latestProgress: null,
  timing: { createdAt: stamp, publication: { at: null, source: "unknown" }, current: { stage: "awaiting_acceptance", startedAt: stamp, endedAt: null, source: null,
    waitingFor: { kind: "consumer", id: me }, elapsedMs: null }, rounds: [], latestEffectiveProgress: null, executionActivity: null, observedAt: stamp },
  actionKey: "task", ...extra,
});
const observation = (observer: string, result: ConsumerObservation["result"], createdAt: string, deliveryId = "delivery-1"): ConsumerObservation => ({
  projectId: "p", id: `${observer}-${createdAt}`, taskId: "task-1", deliveryId, observer, observerKind: "human", result, evidence: "e", reason: "r",
  actorId: observer, createdAt,
});

test("a current delivery declared for me waits until I record 已使用", () => {
  assert.deepEqual(judgeMyDelivery(task(), me), { kind: "waiting", last: null });
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "failed" }), me), { kind: "waiting", last: "failed" });
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "notUsed" }), me), { kind: "waiting", last: "notUsed" });
  // Declared but not required for closing: still mine to use.
  assert.deepEqual(judgeMyDelivery(task({ useRequired: false }), me), { kind: "waiting", last: null });
});

test("I already recorded 已使用 on the current delivery", () => {
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "used" }), me), { kind: "used" });
});

test("another consumer, no consumer, or a different spelling of me is not mine", () => {
  assert.deepEqual(judgeMyDelivery(task({ consumer: other }), me), { kind: "none", reason: "other-consumer" });
  assert.deepEqual(judgeMyDelivery(task({ consumer: null }), me), { kind: "none", reason: "other-consumer" });
  assert.deepEqual(judgeMyDelivery(task({ consumer: "Consumer-A" }), me), { kind: "none", reason: "other-consumer" });
  assert.deepEqual(judgeMyDelivery(task({ consumer: "" }), ""), { kind: "none", reason: "other-consumer" });
});

test("a delivery of an older task revision, a closed task, no delivery or a failed check is not waiting", () => {
  assert.deepEqual(judgeMyDelivery(task({ taskRevisionId: "rev-1" }), me), { kind: "none", reason: "old-revision" });
  assert.deepEqual(judgeMyDelivery(task({}, { taskState: "done" }), me), { kind: "none", reason: "closed" });
  assert.deepEqual(judgeMyDelivery(task({}, { taskState: "cancelled" }), me), { kind: "none", reason: "closed" });
  assert.deepEqual(judgeMyDelivery(task(null), me), { kind: "none", reason: "no-delivery" });
  assert.deepEqual(judgeMyDelivery(task({ technicalResult: "failed" }), me), { kind: "none", reason: "not-passed" });
});

test("when the latest observation is someone else's, mine is read from the task", () => {
  // Even someone else's 已使用 does not satisfy a delivery declared for me.
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: other, observationResult: "used" }), me), { kind: "check-own" });
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: other, observationResult: "failed" }), me), { kind: "check-own" });
  const observations = [observation(me, "failed", "2026-11-09T02:00:00.000Z"), observation(me, "used", "2026-11-09T03:00:00.000Z"),
    observation(other, "failed", "2026-11-09T04:00:00.000Z"), observation(me, "notUsed", "2026-11-09T05:00:00.000Z", "delivery-0")];
  assert.equal(myLatestObservation(observations, "delivery-1", me)?.result, "used");
  assert.equal(myLatestObservation(observations.slice(0, 1), "delivery-1", me)?.result, "failed");
  assert.equal(myLatestObservation([observation(other, "used", stamp)], "delivery-1", me), null);
});

test("the delivery time comes from the index's timeline, never from another delivery", () => {
  const interval = (id: string, startedAt: string) => ({ stage: "awaiting_acceptance" as const, startedAt, endedAt: null, source: { kind: "delivery", id }, waitingFor: { kind: "consumer" as const, id: me } });
  const timed = task({}, { timing: { ...task().timing, rounds: [{ number: 1, startedAt: stamp, endedAt: null, elapsedMs: null,
    intervals: [interval("delivery-0", "2026-11-08T00:00:00.000Z"), interval("delivery-1", "2026-11-09T06:00:00.000Z")] }] } });
  assert.equal(deliveredAt(timed), "2026-11-09T06:00:00.000Z");
  assert.equal(deliveredAt(task({}, { latestProgress: { sequence: 3, entityKind: "delivery", entityId: "delivery-1", eventName: "delivery.recorded", changedAt: "2026-11-09T07:00:00.000Z" } })), "2026-11-09T07:00:00.000Z");
  assert.equal(deliveredAt(task({}, { latestProgress: { sequence: 3, entityKind: "delivery", entityId: "delivery-0", eventName: "delivery.recorded", changedAt: stamp } })), null);
  assert.equal(deliveredAt(task(null)), null);
});

test("row wording and the link into the task's 交付与使用 with the way back", () => {
  assert.equal(useRequirementText(true), "必须使用才能关闭");
  assert.equal(useRequirementText(false), "只是声明的使用者");
  assert.equal(lastUseText(null), "尚未记录使用");
  assert.equal(lastUseText({ result: "failed", at: null }), "你上次：使用失败");
  assert.equal(lastUseText({ result: "notUsed", at: stamp }), "你上次：未使用");
  const link = new URL(deliveryLink("p-1", "t-1", "人 a"), "http://x");
  assert.equal(link.pathname, "/p/p-1/tasks/t-1");
  assert.equal(link.searchParams.get("tab"), "delivery");
  assert.equal(link.searchParams.get("return"), "/p/p-1/inbox");
  assert.equal(link.searchParams.get("actor"), "人 a");
  assert.equal(link.searchParams.get("returnTitle"), "待我处理");
});

test("the 待我处理 count adds the three parts, and a part that failed or was not read through is never counted short", () => {
  const part = (label: string, count: number | undefined, failed = false, incomplete = false) => ({ label, count, failed, incomplete });
  assert.deepEqual(inboxBadge([part("待我验收", 1), part("依据变化", 2), part("等我使用的交付", 3)]), { state: "known", count: 6 });
  assert.deepEqual(inboxBadge([part("待我验收", 0), part("依据变化", 0), part("等我使用的交付", 0)]), { state: "known", count: 0 });
  assert.deepEqual(inboxBadge([part("待我验收", 1), part("依据变化", undefined), part("等我使用的交付", 3)]), { state: "reading" });
  const failed = inboxBadge([part("待我验收", 1), part("依据变化", undefined, true), part("等我使用的交付", 3)]);
  assert.equal(failed.state, "unknown");
  assert.equal(failed.state === "unknown" && failed.known, 4);
  assert.match(failed.state === "unknown" ? failed.text : "", /依据变化读取失败.*已读回的 4 项不是全部/);
  // A failed reread keeps the old answer on the page, but the count does not use it.
  const stale = inboxBadge([part("待我验收", 5, true), part("依据变化", 0), part("等我使用的交付", 0)]);
  assert.deepEqual(stale.state === "unknown" && [stale.known, /待我验收读取失败/.test(stale.text), /已读回/.test(stale.text)], [0, true, false]);
  const partial = inboxBadge([part("待我验收", 0), part("依据变化", 0), part("等我使用的交付", 2, false, true)]);
  assert.match(partial.state === "unknown" ? partial.text : "", /等我使用的交付没有读完/);
  // The shell adds the unconfirmed operations itself: an unknown count shows no number at all.
  assert.equal(shellInboxCount({ state: "known", count: 6 }, 2), 6);
  assert.equal(shellInboxCount({ state: "reading" }, 2), 0);
  assert.equal(shellInboxCount(failed, 2) + 2, 0);
});

async function withFetch(mock: (path: string) => unknown, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const value = mock(String(input));
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = previous; }
}
const indexPage = (items: LeaderWorkTask[], nextCursor: string | null, changeSequence = 7): LeaderWorkPage<LeaderWorkTask> =>
  ({ items, nextCursor, total: items.length, counts: {}, changeSequence, observedAt: stamp, partial: false });

test("every page of the work index is read before saying what waits for me", async () => {
  const paths: string[] = [];
  await withFetch(path => {
    paths.push(path);
    const cursor = new URL(path, "http://x").searchParams.get("cursor");
    if (path.includes("/work-management/index")) return cursor === null
      ? indexPage([task({ consumer: other }, { taskId: "t-a" })], "2")
      : indexPage([task({}, { taskId: "t-b" }), task({ observationActorId: me, observationResult: "used" }, { taskId: "t-c" })], null);
    return new Response("{}", { status: 404 });
  }, async () => {
    const result = await readDeliveriesForMe("p", me);
    assert.equal(result.complete, true);
    assert.equal(result.tasksRead, 3);
    assert.deepEqual(result.items.map(item => item.taskId), ["t-b"]);
  });
  assert.equal(paths.filter(path => path.includes("/work-management/index")).length, 2);
});

test("a work index that does not end is reported as not read through", async () => {
  let calls = 0;
  await withFetch(() => { calls++; return indexPage([task({}, { taskId: `t-${calls}` })], `next-${calls}`); }, async () => {
    const result = await readDeliveriesForMe("p", me);
    assert.equal(result.complete, false);
    assert.equal(result.items.length, 20);
  });
  calls = 0;
  await withFetch(() => { calls++; return indexPage([task({}, { taskId: `t-${calls}` })], "same"); }, async () => {
    assert.equal((await readDeliveriesForMe("p", me)).complete, false);
  });
});

test("someone else observed last: my own observation decides, read from the task", async () => {
  const detail = (observations: ConsumerObservation[]) => ({ task: { projectId: "p", id: "task-1" }, observations,
    deliveries: [{ id: "delivery-1", createdAt: "2026-11-09T00:30:00.000Z" }] });
  const index = indexPage([task({ observationActorId: other, observationResult: "used" })], null);
  await withFetch(path => path.includes("/work-management/index") ? index
    : detail([observation(me, "used", "2026-11-09T02:00:00.000Z"), observation(other, "used", "2026-11-09T03:00:00.000Z")]), async () => {
    assert.deepEqual((await readDeliveriesForMe("p", me)).items, []);
  });
  await withFetch(path => path.includes("/work-management/index") ? index
    : detail([observation(me, "failed", "2026-11-09T02:00:00.000Z"), observation(other, "used", "2026-11-09T03:00:00.000Z")]), async () => {
    const [row] = (await readDeliveriesForMe("p", me)).items;
    assert.deepEqual([row?.othersObserved, row?.last, row?.deliveredAt], [true, { result: "failed", at: "2026-11-09T02:00:00.000Z" }, "2026-11-09T00:30:00.000Z"]);
  });
  await withFetch(path => path.includes("/work-management/index") ? index : { task: { projectId: "p", id: "another" }, observations: [] }, async () => {
    await assert.rejects(readDeliveriesForMe("p", me), /不符/);
  });
});
