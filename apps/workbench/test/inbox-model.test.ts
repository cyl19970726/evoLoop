// 待我处理: which deliveries wait for me to use them (H1), and what the count in the shell may claim (L1).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConsumerObservation } from "@evoloop/contracts";
import type { LeaderWorkDeliveryFact, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  decisionKindText, decisionLink, decisionLinkProblem, deliveredAt, usageAlerts, usageWindow, deliveryLink, inboxBadge, inboxTaskLink, judgeMyDelivery, lastUseText, myLatestObservation, shellInboxCount, useRequirementText,
} from "../src/features/workflow/inboxModel.ts";
import type { DecisionItem } from "@evoloop/contracts/decision-requests";
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
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "notUsed" }), me), { kind: "waiting", last: "notUsed" });
  // Declared but not required for closing: still mine to use.
  assert.deepEqual(judgeMyDelivery(task({ useRequired: false }), me), { kind: "waiting", last: null });
});

test("I already recorded 已使用 on the current delivery", () => {
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "used" }), me), { kind: "used" });
});

test("my latest 使用失败 on the current delivery sends it back to rework: not mine to use, not counted (N9)", () => {
  // The next step is the executor's rework, not mine; 未使用 still waits for me.
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "failed" }), me), { kind: "failed" });
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "failed" }, { phase: "rework" }), me), { kind: "failed" });
  assert.deepEqual(judgeMyDelivery(task({ observationActorId: me, observationResult: "notUsed" }, { phase: "rework" }), me), { kind: "waiting", last: "notUsed" });
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
  assert.equal(lastUseText({ result: "notUsed", at: stamp }), "你上次：未使用");
  const link = new URL(deliveryLink("p-1", "t-1", "人 a"), "http://x");
  assert.equal(link.pathname, "/p/p-1/tasks/t-1");
  assert.equal(link.searchParams.get("tab"), "delivery");
  assert.equal(link.searchParams.get("return"), "/p/p-1/inbox");
  assert.equal(link.searchParams.get("actor"), "人 a");
  assert.equal(link.searchParams.get("returnTitle"), "待我验收与判断");
  // 依据变化 and 待我验收 carry the same way back (N1): to 依据与影响, or to the task's first tab.
  const basis = new URL(inboxTaskLink("p-1", "t-2", "人 a", "basis"), "http://x");
  assert.deepEqual([basis.pathname, basis.searchParams.get("tab"), basis.searchParams.get("return"), basis.searchParams.get("actor"), basis.searchParams.get("returnTitle")],
    ["/p/p-1/tasks/t-2", "basis", "/p/p-1/inbox", "人 a", "待我验收与判断"]);
  const plain = new URL(inboxTaskLink("p-1", "t-3", "人 a"), "http://x");
  assert.deepEqual([plain.searchParams.has("tab"), plain.searchParams.get("return"), plain.searchParams.get("returnTitle")], [false, "/p/p-1/inbox", "待我验收与判断"]);
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
  // The shell adds the unconfirmed operations itself; an unknown count is handed over as unknown (the dot says 待核对).
  assert.equal(shellInboxCount({ state: "known", count: 6 }), 6);
  assert.equal(shellInboxCount({ state: "reading" }), 0);
  assert.equal(shellInboxCount(failed), null);
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
    : detail([observation(me, "notUsed", "2026-11-09T02:00:00.000Z"), observation(other, "used", "2026-11-09T03:00:00.000Z")]), async () => {
    const [row] = (await readDeliveriesForMe("p", me)).items;
    assert.deepEqual([row?.othersObserved, row?.last, row?.deliveredAt], [true, { result: "notUsed", at: "2026-11-09T02:00:00.000Z" }, "2026-11-09T00:30:00.000Z"]);
  });
  // My own latest 使用失败, read from the task, sends it back to rework as well.
  await withFetch(path => path.includes("/work-management/index") ? index
    : detail([observation(me, "failed", "2026-11-09T02:00:00.000Z"), observation(other, "used", "2026-11-09T03:00:00.000Z")]), async () => {
    assert.deepEqual((await readDeliveriesForMe("p", me)).items, []);
  });
  await withFetch(path => path.includes("/work-management/index") ? index : { task: { projectId: "p", id: "another" }, observations: [] }, async () => {
    await assert.rejects(readDeliveriesForMe("p", me), /不符/);
  });
});

const decision = (kind: DecisionItem["kind"]): DecisionItem => {
  const common = { id: "item-1", title: "标题", detail: "说明", proposedBy: "leader", at: stamp };
  switch (kind) {
    case "role_proposal": return { ...common, kind, roleId: "role-1", version: 1 };
    case "stage_proposal": return { ...common, kind, stageId: "stage-1", version: 1 };
    case "task_question": return { ...common, kind, taskId: "task-9", discussionId: "d-1", eventId: "e-1" };
    case "decision_request": return { ...common, kind, taskId: null, options: ["确认", "不确认"], version: 1 };
  }
};

test("待我决定: every item says what it is, and each opens the place that decides it (a request without a task is answered in the list)", () => {
  assert.deepEqual(Object.keys(decisionKindText).sort(), ["decision_request", "role_proposal", "stage_proposal", "task_question"]);
  assert.match(decisionLink("p1", decision("role_proposal"), me)!, /^\/p\/p1\/roles\?/);
  assert.match(decisionLink("p1", decision("stage_proposal"), me)!, /^\/p\/p1\/journey\?/);
  const question = decisionLink("p1", decision("task_question"), me)!;
  assert.match(question, /^\/p\/p1\/tasks\/task-9\?/);
  assert.match(question, /return=%2Fp%2Fp1%2Finbox/, "the way back to the inbox is kept");
  assert.equal(decisionLink("p1", decision("decision_request"), me), null, "answered right in the row");
  assert.match(decisionLink("p1", { ...decision("decision_request"), taskId: "task-3" } as DecisionItem, me)!, /tasks\/task-3/);
  // A link is never a conversation: no item sends the reader to a Leader chat.
  for (const kind of ["role_proposal", "stage_proposal", "task_question"] as const) assert.doesNotMatch(decisionLink("p1", decision(kind), me)!, /sessions|conversation/);
});

test("the 待我处理 count includes 待我决定, and an unreadable 待我决定 is 待核对, never zero", () => {
  const parts = (decisions: { count: number | undefined; failed: boolean }) => [
    { label: "待我验收", count: 1, failed: false }, { label: "待我决定", ...decisions }, { label: "依据变化", count: 0, failed: false }];
  assert.deepEqual(inboxBadge(parts({ count: 2, failed: false })), { state: "known", count: 3 });
  assert.equal(inboxBadge(parts({ count: undefined, failed: true })).state, "unknown");
});

test("待我决定 deep links carry the specific id of the item, not a list page", () => {
  const params = (item: DecisionItem) => new URL(decisionLink("p1", item, me)!, "http://x");
  const role = params(decision("role_proposal"));
  assert.equal(role.pathname, "/p/p1/roles");
  assert.equal(role.searchParams.get("role"), "role-1", "the role page selects this role");
  assert.equal(role.searchParams.get("return"), "/p/p1/inbox");
  const stage = params(decision("stage_proposal"));
  assert.equal(stage.pathname, "/p/p1/journey");
  assert.equal(stage.searchParams.get("stage"), "stage-1", "the journey page selects this stage");
  assert.equal(stage.searchParams.get("return"), "/p/p1/inbox");
  const question = params(decision("task_question"));
  assert.equal(question.pathname, "/p/p1/tasks/task-9");
  assert.equal(question.searchParams.get("section"), "collaboration", "the task page opens its collaboration section");
  assert.equal(question.searchParams.get("discussion"), "d-1");
  assert.equal(question.searchParams.get("question"), "e-1", "and the question event itself");
  assert.equal(question.searchParams.get("return"), "/p/p1/inbox");
  assert.equal(question.searchParams.get("actor"), me);
  // Ids are encoded, never concatenated raw.
  assert.equal(params({ ...decision("role_proposal"), roleId: "a b&c" } as DecisionItem).searchParams.get("role"), "a b&c");
});

test("待我决定 with a missing id has no link and says why: it never falls back to the list page", () => {
  const blank = (kind: "role_proposal" | "stage_proposal" | "task_question", field: string, value: string) => ({ ...decision(kind), [field]: value }) as DecisionItem;
  const cases: Array<[DecisionItem, RegExp]> = [
    [blank("role_proposal", "roleId", ""), /职责/], [blank("role_proposal", "roleId", "   "), /职责/],
    [blank("stage_proposal", "stageId", ""), /阶段/],
    [blank("task_question", "taskId", ""), /任务/], [blank("task_question", "eventId", ""), /问题/], [blank("task_question", "discussionId", ""), /讨论/],
  ];
  for (const [item, why] of cases) {
    assert.equal(decisionLink("p1", item, me), null, `${item.kind} without its id has no link`);
    assert.match(decisionLinkProblem(item)!, why);
  }
  for (const kind of ["role_proposal", "stage_proposal", "task_question"] as const) assert.equal(decisionLinkProblem(decision(kind)), null, "a complete item has no problem");
  assert.equal(decisionLinkProblem(decision("decision_request")), null, "a request is answered in the row");
  // The empty list needs no link at all.
  assert.equal(([] as DecisionItem[]).map(item => decisionLink("p1", item, me)).length, 0);
});

// W5: budget and context alerts go to the person (待我处理), never to the Leader.
const budget = (state: string, reason: string | null = null) => ({ configured: true, state, limitKind: "input_tokens", limit: 100, used: 90, ratio: 0.9, warningRatio: 0.8, pauseOrdinaryTurns: true, costComplete: true, reason });
const sessionUsage = (sessionId: string, state: string) => ({ sessionId, roleId: "r", context: { configured: true, state, inputTokens: 90, limit: 100, ratio: 0.9, warningRatio: 0.8, pauseOrdinaryTurns: true, observedAt: null, reason: null } });
test("budget and context alerts are listed for the person: nothing for ok, unconfigured or unknown, a line each for warning, exhausted and a Session that must hand off", () => {
  assert.deepEqual(usageAlerts(null), [], "nothing was read");
  assert.deepEqual(usageAlerts({ budget: budget("ok") as never, sessions: [sessionUsage("s1", "ok") as never, sessionUsage("s2", "unknown") as never, sessionUsage("s3", "unconfigured") as never] }), []);
  const warning = usageAlerts({ budget: budget("warning", "今日用量已达到上限的 90%，请留意。") as never, sessions: [] });
  assert.deepEqual(warning.map(item => [item.kind, item.severity]), [["budget", "warning"]]);
  assert.match(warning[0]!.text, /90%/);
  const exhausted = usageAlerts({ budget: budget("exhausted", "今日用量已达到上限；普通结果通知和消息轮次暂停。") as never, sessions: [] });
  assert.deepEqual(exhausted.map(item => [item.kind, item.severity]), [["budget", "limit"]]);
  const context = usageAlerts({ budget: budget("ok") as never, sessions: [sessionUsage("11111111-1111-4111-8111-111111111111", "warning") as never, sessionUsage("22222222-2222-4222-8222-222222222222", "handoff_required") as never] });
  assert.deepEqual(context.map(item => [item.kind, item.severity, item.sessionId]), [["context", "warning", "11111111-1111-4111-8111-111111111111"], ["context", "limit", "22222222-2222-4222-8222-222222222222"]]);
  assert.match(context[1]!.text, /交接/);
  assert.equal(usageAlerts({ budget: { ...budget("warning"), configured: false } as never, sessions: [] }).length, 0, "an unconfigured budget has no alert");
});

// The day a budget alert counts is the project's, not UTC's: the window asked for has to contain it whatever the offset (UTC-12 .. UTC+14).
test("the usage window around now contains the project's calendar day at every UTC offset, at the moments the calendars disagree", () => {
  const dayAt = (instant: string, offsetHours: number) => new Date(Date.parse(instant) + offsetHours * 3_600_000).toISOString().slice(0, 10);
  for (const instant of ["2026-11-12T20:00:00.000Z", "2026-11-12T23:59:00.000Z", "2026-11-13T00:01:00.000Z", "2026-11-13T02:00:00.000Z", "2026-12-31T23:30:00.000Z"]) {
    const { from, to } = usageWindow(instant);
    for (let offset = -12; offset <= 14; offset++) {
      const projectDay = dayAt(instant, offset);
      assert.ok(from <= projectDay && projectDay <= to, `${instant} at UTC${offset >= 0 ? "+" : ""}${offset}: ${projectDay} is in ${from}..${to}`);
    }
  }
  assert.deepEqual(usageWindow("2026-11-12T20:00:00.000Z"), { from: "2026-11-11", to: "2026-11-13" });
  assert.deepEqual(usageWindow("2026-01-01T00:30:00.000Z"), { from: "2025-12-31", to: "2026-01-02" }, "across a year end");
});
