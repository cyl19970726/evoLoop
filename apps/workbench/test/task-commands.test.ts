// The commands the task page writes (taskCommands.ts) and how useCommand prepares them. Each command keeps the
// shape the old forms on main sent (TaskWorkflow, TaskSchedulePanel, ImpactReview, TaskAssignmentPanel,
// ResidentQueuePanel, RuntimePanel, TaskAttention); the expected versions always come from what the form recorded
// when it opened (`seen`), never from a later read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSchema, type TaskDetail } from "@evoloop/contracts";
import { leaderWorkDependenciesCommandSchema, leaderWorkPlanCommandSchema, leaderWorkReviewCommandSchema, type LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { ResidentQueue } from "@evoloop/contracts/queues";
import type { TaskTimingView } from "../src/shared/api.ts";
import {
  acceptanceResponsibilityCommand, assignmentAcknowledgeCommand, assignmentObserveCommand, assignmentReleaseCommand, assignmentSetCommand,
  attentionResolveCommand, closableDelivery, deliveryRecordCommand, dependenciesCommand, followUpCommand, handoffRecordCommand, impactSeen,
  instantOrNull, leaderSeen, localInput, observationRecordCommand, olderBasisSources, planCommand, publicationCommand, queueAdoptCommand,
  queueAmendCommand, queueCreateCommand, queueHoldCommand, queueReorderCommand, queueUnholdCommand, reviewBasisCommand, reviewCommand,
  runAbandonCommand, runInterruptCommand, runReserveCommand, seriesCurrentPromptCommand, seriesFuturePromptCommand, taskCancelCommand,
  taskCloseCommand, taskReopenCommand, taskStartCommand, taskUpdateCommand, withoutOperationType,
} from "../src/features/workflow/taskCommands.ts";
import { timingSetPayload, timingStopPayload } from "../src/features/workflow/taskTimingPresentation.ts";
import { baselineText, incompleteText, prepareCommand, submissionRefusal } from "../src/shared/command/index.ts";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const projectId = uuid(1), taskId = uuid(2), revisionId = uuid(3), owner = uuid(4), docA = uuid(5), docB = uuid(6);
const task = { projectId, id: taskId, version: 7, currentRevisionId: revisionId, title: "任务", content: "正文", contentDocumentId: docA,
  contentRevisionId: uuid(7), kind: "implementation" as const, acceptance: "验收", owner, state: "todo" as const };
const proposal = { projectId, taskId, taskRevisionId: revisionId, stageId: null, consumer: "qa-agent", useRequired: true,
  acceptanceMode: "independent_agent" as const, evidence: "来源", stopCondition: "停止", createdAt: "2026-11-01T00:00:00Z" };
const detail = { task, revision: { id: revisionId }, basis: null, impacts: [], decisions: [], proposal,
  links: [{ projectId, id: uuid(8), taskId, documentId: docB, actorId: "a", createdAt: "x" }] } as unknown as TaskDetail;
// A form opened on version 5 sends version 5 even after the task moved on to 7.
const seen = { taskVersion: 5 };
const sent = (built: Record<string, unknown>) => prepareCommand(built, projectId, uuid(99)) as Record<string, unknown>;

test("a baseline compares its fixed inputs whatever the key order, and any change refuses the submit", () => {
  assert.equal(baselineText({ a: 1, b: "x" }), baselineText({ b: "x", a: 1 }));
  assert.notEqual(baselineText({ taskVersion: 1, queueVersion: 2 }), baselineText({ taskVersion: 1, queueVersion: 3 }));
  assert.equal(baselineText("1:2"), "1:2");
  assert.equal(submissionRefusal({ busy: false, blocked: false, stale: false, recorded: baselineText({ a: 1 }), current: baselineText({ a: 2 }) }), "baseline");
  assert.equal(submissionRefusal({ busy: false, blocked: false, stale: false, recorded: baselineText({ a: 1 }), current: baselineText({ a: 1 }) }), null);
});

test("commands are parsed by the shared schema unless the form validates its own, and an invalid one is never sent", () => {
  const parsed = prepareCommand({ type: "task.cancel", taskId, expectedVersion: 3, reason: "  理由  " }, projectId, uuid(99));
  assert.equal((parsed as { reason: string }).reason, "理由", "the shared schema trims text");
  const kept = prepareCommand({ type: "work.plan.set", taskId, reason: " x " }, projectId, uuid(99), { validate: () => {} });
  assert.deepEqual(kept, { type: "work.plan.set", taskId, reason: " x ", projectId, operationId: uuid(99) }, "a validated command is sent as built");
  assert.throws(() => prepareCommand({ type: "task.cancel", taskId, reason: "缺版本" }, projectId, uuid(99)), new RegExp(incompleteText));
});

test("任务操作 commands keep main's shape and the recorded task version", () => {
  assert.deepEqual(taskUpdateCommand(detail, seen, { title: "新名", kind: "", content: "新正文", acceptance: "新验收", owner, reason: "改" }), {
    taskId, expectedVersion: 5, type: "task.update", title: "新名", kind: null, content: "新正文", acceptance: "新验收", owner, documentIds: [docB],
    consumer: "qa-agent", useRequired: true, evidence: "来源", stopCondition: "停止", reason: "改" });
  assert.deepEqual(acceptanceResponsibilityCommand(detail, seen, { acceptanceMode: "human_required", consumer: " me ", reason: "r" }), {
    taskId, expectedVersion: 5, type: "task.update", title: "任务", content: "正文", acceptance: "验收", owner, kind: "implementation",
    documentIds: [docB], acceptanceMode: "human_required", useRequired: true, consumer: "me", reason: "r" });
  assert.equal("acceptanceMode" in acceptanceResponsibilityCommand(detail, seen, { acceptanceMode: "legacy", consumer: "", reason: "r" }), false);
  assert.equal(acceptanceResponsibilityCommand(detail, seen, { acceptanceMode: "legacy", consumer: "", reason: "r" }).consumer, null);
  assert.deepEqual(deliveryRecordCommand(detail, seen, { runId: "", artifactRef: "a", artifactRevision: "r", contentHash: "f".repeat(64),
    technicalResult: "passed", technicalEvidence: "e", reason: "x" }), { taskId, expectedVersion: 5, type: "delivery.record", artifactRef: "a",
    artifactRevision: "r", contentHash: "f".repeat(64), technicalResult: "passed", technicalEvidence: "e", reason: "x" });
  assert.equal(deliveryRecordCommand(detail, seen, { runId: uuid(9), artifactRef: "a", artifactRevision: "r", contentHash: "f".repeat(64),
    technicalResult: "passed", technicalEvidence: "e", reason: "x" }).runId, uuid(9));
  assert.deepEqual(observationRecordCommand(detail, { deliveryId: uuid(10) }, { observer: "me", observerKind: "agent", result: "used", evidence: "e", reason: "r" }),
    { type: "observation.record", taskId, deliveryId: uuid(10), observer: "me", observerKind: "agent", result: "used", evidence: "e", reason: "r" });
  assert.deepEqual(taskCloseCommand(detail, { taskVersion: 5, deliveryId: uuid(10) }, { acceptanceEvidence: "满足", reason: "关" }),
    { taskId, expectedVersion: 5, type: "task.close", deliveryId: uuid(10), acceptanceResult: "met", acceptanceEvidence: "满足", reason: "关" });
  assert.deepEqual(taskCancelCommand(detail, seen, { reason: "取消" }), { taskId, expectedVersion: 5, type: "task.cancel", reason: "取消" });
  assert.deepEqual(taskReopenCommand(detail, seen, { reason: "重开" }), { taskId, expectedVersion: 5, type: "task.reopen", reason: "重开" });
  for (const built of [taskUpdateCommand(detail, seen, { title: "n", kind: "research", content: "c", acceptance: "a", owner, reason: "r" }),
    taskCancelCommand(detail, seen, { reason: "r" }), taskReopenCommand(detail, seen, { reason: "r" }),
    taskCloseCommand(detail, { taskVersion: 5, deliveryId: uuid(10) }, { acceptanceEvidence: "e", reason: "r" })])
    assert.equal(sent(built).expectedVersion, 5, `${built.type} passes the shared schema with the recorded version`);
});

test("starting keeps only written retention reasons for basis documents whose published version moved on", () => {
  const basisDetail = { ...detail, basis: { projectId, taskId, taskRevisionId: revisionId, id: uuid(11), sealed: true,
    members: [{ documentId: docA, revisionId: uuid(12) }, { documentId: docB, revisionId: uuid(13) }],
    retentions: [{ documentId: docB, revisionId: uuid(13), observedAdoptedRevisionId: uuid(14), reason: "保留", actorId: "a", createdAt: "x" }] } } as unknown as TaskDetail;
  const documents = { [docA]: { document: { title: "甲", adoptedRevisionId: uuid(15) } }, [docB]: { document: { title: "乙", adoptedRevisionId: uuid(14) } } } as never;
  const older = olderBasisSources(basisDetail, documents);
  assert.deepEqual(older, [{ documentId: docA, revisionId: uuid(12), title: "甲", observedAdoptedRevisionId: uuid(15) }], "a recorded retention for the same published version is reused");
  assert.deepEqual(taskStartCommand(detail, seen, older, { reason: "开始", retain: { [docA]: "  旧版仍适用 " } }), {
    taskId, expectedVersion: 5, type: "task.start", reason: "开始",
    retentions: [{ documentId: docA, revisionId: uuid(12), observedAdoptedRevisionId: uuid(15), reason: "旧版仍适用" }] });
  assert.equal("retentions" in taskStartCommand(detail, seen, older, { reason: "开始", retain: { [docA]: " " } }), false, "an empty reason is not consent");
});

test("the Leader's plan, dependencies and review use the recorded versions and pass their own schemas", () => {
  const leader = { workChangeSequence: 17, plan: { version: 3 }, dependencyVersion: 2 } as unknown as LeaderWorkTask;
  const recorded = leaderSeen(task, leader);
  assert.deepEqual(recorded, { taskVersion: 7, revisionId, planVersion: 3, dependencyVersion: 2, workChangeSequence: 17 });
  const plan = planCommand(taskId, { taskVersion: 5, planVersion: 3 }, { plannedStartAt: "", dueAt: "2026-11-20T10:00:00Z", priority: "2", reason: "排期" });
  assert.deepEqual(plan, { type: "work.plan.set", taskId, expectedTaskVersion: 5, expectedPlanVersion: 3, plannedStartAt: null,
    dueAt: "2026-11-20T10:00:00.000Z", priority: 2, reason: "排期" });
  assert.equal(planCommand(taskId, { taskVersion: 5, planVersion: 0 }, { plannedStartAt: "", dueAt: "", priority: "", reason: "r" }).priority, null);
  assert.throws(() => planCommand(taskId, { taskVersion: 5, planVersion: 0 }, { plannedStartAt: "不是时间", dueAt: "", priority: "", reason: "r" }), /计划开始/);
  leaderWorkPlanCommandSchema.parse(withoutOperationType(prepareCommand(plan, projectId, uuid(99), { validate: () => {} })));
  const dependencies = dependenciesCommand(taskId, { taskVersion: 5, dependencyVersion: 2 }, { dependsOnTaskIds: [` ${uuid(20)} `, ""], reason: "依赖" });
  assert.deepEqual(dependencies, { type: "work.dependencies.set", taskId, expectedTaskVersion: 5, expectedDependencyVersion: 2, dependsOnTaskIds: [uuid(20)], reason: "依赖" });
  leaderWorkDependenciesCommandSchema.parse(withoutOperationType(prepareCommand(dependencies, projectId, uuid(99), { validate: () => {} })));
  const review = reviewCommand(taskId, { taskVersion: 5, revisionId, workChangeSequence: 17 }, { decision: "deferred", reason: "等" });
  assert.deepEqual(review, { type: "work.review.set", taskId, expectedTaskVersion: 5, expectedTaskRevisionId: revisionId,
    expectedWorkChangeSequence: 17, decision: "deferred", reason: "等" });
  leaderWorkReviewCommandSchema.parse(withoutOperationType(prepareCommand(review, projectId, uuid(99), { validate: () => {} })));
});

test("a basis review is fixed to the impact and task version the form opened on", () => {
  const impact = { id: uuid(30), state: "pending" as const, fromRevisionId: uuid(31), toRevisionId: uuid(32) };
  assert.deepEqual(impactSeen(task, impact), { taskVersion: 7, impactId: uuid(30), impactState: "pending", from: uuid(31), to: uuid(32) });
  assert.deepEqual(reviewBasisCommand(taskId, { taskVersion: 5, impactId: uuid(30) }, { decision: "adopt", reason: " 采用 ", acceptance: " 新验收 " }),
    { type: "task.reviewBasis", taskId, expectedVersion: 5, impactId: uuid(30), decision: "adopt", reason: "采用", acceptance: "新验收" });
  const retain = reviewBasisCommand(taskId, { taskVersion: 5, impactId: uuid(30) }, { decision: "retain", reason: "保留", acceptance: "忽略" });
  assert.equal("acceptance" in retain, false);
  assert.equal(sent(retain).expectedVersion, 5);
});

test("timing commands carry the recorded task and timing versions", () => {
  const timing = { version: 4, executeAtUtc: "2026-11-11T00:00:00.000Z", timezone: "Asia/Shanghai", repeat: "daily", seriesState: "active",
    futureTemplate: { title: "t", content: "c", acceptance: "a" } } as TaskTimingView;
  const set = timingSetPayload(taskId, 5, { ...timing, version: 3 }, { executeAtUtc: "2026-11-12T08:00:00+08:00", timezone: "Asia/Shanghai", repeat: "daily", scope: "this", reason: " r " });
  assert.deepEqual(set, { type: "task.timing.set", taskId, expectedTaskVersion: 5, expectedTimingVersion: 3, executeAtUtc: "2026-11-12T00:00:00.000Z",
    timezone: "Asia/Shanghai", repeat: "daily", scope: "this", reason: "r" });
  commandSchema.parse({ ...set, projectId, operationId: uuid(99) });
  assert.equal(timingSetPayload(taskId, 5, null, { executeAtUtc: "2026-11-12T08:00:00Z", timezone: "UTC", repeat: "none", scope: "this", reason: "r" }).expectedTimingVersion, 0);
  assert.deepEqual(timingStopPayload(taskId, { ...timing, version: 3 }, " 停 "), { type: "task.timing.stop", taskId, expectedTimingVersion: 3, reason: "停" });
  const future = seriesFuturePromptCommand(taskId, { taskVersion: 5, timingVersion: 3 }, timing, { title: "以后", content: "以后正文", acceptance: "以后验收", reason: "改" });
  assert.equal(future.expectedTaskVersion, 5); assert.equal(future.expectedTimingVersion, 3, "the recorded timing version, not the newer read");
  assert.equal(future.scope, "future"); assert.equal(future.title, "以后");
  commandSchema.parse({ ...future, projectId, operationId: uuid(99) });
  const current = seriesCurrentPromptCommand(detail, { taskVersion: 5, timingVersion: 3 }, { scope: "this_and_future", title: "n", content: "c", acceptance: "a", reason: "r" });
  assert.equal(current.expectedVersion, 5); assert.equal(current.expectedTimingVersion, 3); assert.equal(current.repeatScope, "this_and_future");
  assert.equal("expectedTimingVersion" in seriesCurrentPromptCommand(detail, { taskVersion: 5, timingVersion: 3 }, { scope: "this", title: "n", content: "c", acceptance: "a", reason: "r" }), false);
  assert.throws(() => seriesCurrentPromptCommand(detail, { taskVersion: 5, timingVersion: 3 }, { scope: "this", title: "", content: "c", acceptance: "a", reason: "r" }));
  commandSchema.parse({ ...current, projectId, operationId: uuid(99) });
});

test("assignment commands carry the recorded assignment and task versions", () => {
  const recorded = { taskVersion: 5, assignmentVersion: 2 };
  assert.deepEqual(assignmentAcknowledgeCommand(taskId, recorded, { evidence: "接手", sourceRef: "" }),
    { type: "task.assignment.acknowledge", taskId, expectedVersion: 2, expectedTaskVersion: 5, evidence: "接手", sourceRef: null });
  assert.deepEqual(assignmentObserveCommand(taskId, recorded, { evidence: "看到", sourceRef: "ref" }),
    { type: "task.assignment.observeAcceptance", taskId, expectedVersion: 2, expectedTaskVersion: 5, evidence: "看到", sourceRef: "ref" });
  assert.deepEqual(assignmentReleaseCommand(taskId, recorded, { reason: "释放" }), { type: "task.assignment.release", taskId, expectedVersion: 2, reason: "释放" });
  const target = { kind: "owned", sessionId: uuid(40) };
  assert.deepEqual(assignmentSetCommand(taskId, { taskVersion: 5, assignmentVersion: 0 }, { target, recipientActorId: " ", reason: " 分派 " }),
    { type: "task.assignment.set", taskId, expectedTaskVersion: 5, expectedVersion: 0, target, recipientActorId: null, reason: "分派" });
  for (const built of [assignmentAcknowledgeCommand(taskId, recorded, { evidence: "e", sourceRef: "" }), assignmentReleaseCommand(taskId, recorded, { reason: "r" }),
    assignmentSetCommand(taskId, recorded, { target, recipientActorId: "", reason: "r" })]) sent(built);
});

test("queue and run commands carry the recorded queue, entry, task and run versions", () => {
  const entry = (id: number, position: number, state = "queued") => ({ id: uuid(id), position, state, version: 9 });
  const queue = { id: uuid(50), version: 6, entries: [entry(53, 2), entry(51, 0), entry(52, 1)] } as unknown as ResidentQueue;
  assert.deepEqual(queueAdoptCommand(queue.id, { queueVersion: 6 }), { type: "queue.adopt", queueId: uuid(50), expectedVersion: 6 });
  assert.deepEqual(queueReorderCommand(queue, { queueVersion: 6 }, { entryId: uuid(53), reason: "提前" }),
    { type: "queue.reorder", queueId: uuid(50), expectedVersion: 6, entryIds: [uuid(51), uuid(53), uuid(52)], reason: "提前" });
  assert.throws(() => queueReorderCommand(queue, { queueVersion: 6 }, { entryId: uuid(51), reason: "r" }), /第一项/);
  assert.deepEqual(queueAmendCommand(queue.id, { queueVersion: 6, entryId: uuid(51), taskRevisionId: revisionId }, { reason: "更新" }),
    { type: "queue.amend", queueId: uuid(50), expectedVersion: 6, entryId: uuid(51), taskRevisionId: revisionId, reason: "更新" });
  assert.deepEqual(queueHoldCommand(queue.id, { id: uuid(51) }, { reason: "停" }), { type: "queue.hold", queueId: uuid(50), entryId: uuid(51), reason: "停" });
  assert.deepEqual(queueUnholdCommand(queue.id, { entryId: uuid(51), entryVersion: 9 }, { reason: "放" }),
    { type: "queue.unhold", queueId: uuid(50), entryId: uuid(51), expectedEntryVersion: 9, reason: "放" });
  let next = 60;
  const ids = () => uuid(next++);
  const arrange = { taskVersion: 5, revisionId, owner };
  assert.deepEqual(queueCreateCommand(detail, arrange, { sessionId: uuid(41), consumerId: "qa-agent", reason: "安排" }, ids), {
    type: "queue.create", queueId: uuid(60), maxRuns: 3, reason: "安排", entries: [{ id: uuid(61), taskId, taskRevisionId: revisionId,
      sessionId: uuid(41), roleId: owner, dependsOn: [], consumerId: "qa-agent", useRequired: true, releaseRule: "accepted" }] });
  assert.deepEqual(runReserveCommand(taskId, arrange, { sessionId: uuid(41), input: "做" }, ids),
    { type: "runtime.run.reserve", runId: uuid(62), taskId, expectedVersion: 5, sessionId: uuid(41), input: "做" });
  assert.deepEqual(runInterruptCommand(uuid(70), { reason: "停" }), { type: "runtime.run.interrupt", runId: uuid(70), reason: "停" });
  assert.deepEqual(runAbandonCommand(uuid(70), { runVersion: 4 }, { reason: "r", evidence: "e" }),
    { type: "runtime.run.abandonReadOnly", runId: uuid(70), expectedVersion: 4, reason: "r", evidence: "e" });
  assert.deepEqual(handoffRecordCommand(uuid(70), { stage: "read", evidence: "e" }), { type: "runtime.handoff.record", runId: uuid(70), stage: "read", evidence: "e" });
  for (const built of [queueAdoptCommand(queue.id, { queueVersion: 6 }), queueUnholdCommand(queue.id, { entryId: uuid(51), entryVersion: 9 }, { reason: "r" }),
    queueCreateCommand(detail, arrange, { sessionId: uuid(41), consumerId: "qa", reason: "r" }, ids), runReserveCommand(taskId, arrange, { sessionId: uuid(41), input: "i" }, ids),
    runAbandonCommand(uuid(70), { runVersion: 4 }, { reason: "r", evidence: "e" })]) sent(built);
});

test("attention follow-up, publication and resolve keep the recorded follow-up, item and task versions", () => {
  const recorded = { taskVersion: 5, revisionId, followUpVersion: 2 };
  const followUp = followUpCommand(taskId, recorded, { waitingKind: "consumer", waitingId: " qa ", decision: "waiting", actionTaken: " 已催 ", evidenceRef: "",
    nextCheck: "2026-11-12T09:00:00Z", reason: " 跟进 ", handoff: null });
  assert.deepEqual(followUp, { type: "task.attention.followUp.set", taskId, expectedTaskVersion: 5, expectedTaskRevisionId: revisionId, expectedVersion: 2,
    waitingOn: { kind: "consumer", id: "qa" }, decision: "waiting", actionTaken: "已催", evidenceRef: null, nextCheckAt: "2026-11-12T09:00:00.000Z",
    releaseHandoff: null, reason: "跟进" });
  sent(followUp);
  const publication = publicationCommand(taskId, recorded, { publishedAt: "2026-11-12T10:00:00Z", publicationRef: " tag ", reason: " 发布 " });
  assert.deepEqual(publication, { type: "task.attention.publication.record", taskId, expectedTaskVersion: 5, expectedTaskRevisionId: revisionId,
    expectedVersion: 2, publishedAt: "2026-11-12T10:00:00.000Z", publicationRef: "tag", reason: "发布" });
  sent(publication);
  const resolve = attentionResolveCommand({ id: uuid(80) }, { itemVersion: 3 }, { reason: " 已解决 " });
  assert.deepEqual(resolve, { type: "task.attention.resolve", itemId: uuid(80), expectedVersion: 3, disposition: "resolved", reason: "已解决" });
  sent(resolve);
});

test("a task closes only on a passed delivery of its current revision with the agreed use", () => {
  const delivery = { id: uuid(90), taskRevisionId: revisionId, technicalResult: "passed", submittedByActorId: "worker" };
  const use = (actorId: string, observerKind = "agent", result = "used") => ({ deliveryId: uuid(90), observer: actorId, actorId, observerKind, result });
  const base = { revision: { id: revisionId }, deliveries: [delivery], proposal: { ...proposal, consumer: "" } } as unknown as TaskDetail;
  assert.equal(closableDelivery({ ...base, observations: [] }), false, "use is required");
  assert.equal(closableDelivery({ ...base, observations: [use("worker")] } as never), false, "the submitter cannot accept its own delivery");
  assert.equal(closableDelivery({ ...base, observations: [use("qa")] } as never), true);
  assert.equal(closableDelivery({ ...base, deliveries: [{ ...delivery, taskRevisionId: uuid(91) }], observations: [use("qa")] } as never), false, "an older revision's delivery");
  assert.equal(closableDelivery({ ...base, deliveries: [{ ...delivery, technicalResult: "failed" }], observations: [use("qa")] } as never), false);
});

test("date-time inputs convert both ways and an empty one is not a time", () => {
  assert.equal(instantOrNull("", "x"), null);
  assert.equal(instantOrNull("2026-11-10T08:00:00Z", "x"), "2026-11-10T08:00:00.000Z");
  assert.equal(localInput(null), "");
  assert.match(localInput("2026-11-10T08:00:00Z"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(new Date(localInput("2026-11-10T08:00:00Z")).toISOString(), "2026-11-10T08:00:00.000Z");
});

test("the timing's waiting reason is shown without the record IDs it names", async () => {
  const { timingWaitingText } = await import("../src/features/workflow/taskTimingPresentation.ts");
  assert.equal(timingWaitingText(`上一份任务 ${uuid(5)} 仍为待办`), "上一份任务仍为待办");
  assert.equal(timingWaitingText(`上一份任务 ${uuid(5)} 的运行尚未结算`), "上一份任务的运行尚未结算");
});
