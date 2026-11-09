import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaderWorkDependency } from "@evoloop/contracts/work-index";
import { blockedReasons, relayProgress, relayRecipient, relayStageLabel, relayStateLabel, waitingText, workItemNextStep, workNextStep } from "../src/shared/workPresentation.ts";

test("acceptance relay steps read in plain words and never print raw values", () => {
  assert.equal(relayProgress({ messageState: "queued", processingState: "running", readActorId: null, humanReadAt: null, observationResult: null }),
    "消息已排队 · 处理正在处理 · 本人读取未记录 · 使用尚未关联");
  assert.equal(relayProgress({ messageState: "manual_pending", processingState: null, readActorId: "a", humanReadAt: null, observationResult: "notUsed" }),
    "消息等人工转交 · 处理尚未开始 · 本人读取已记录 · 使用未使用");
  const unknown = relayProgress({ messageState: "future_state", processingState: "other", readActorId: null, humanReadAt: null, observationResult: "x" as never });
  assert.match(unknown, /状态未识别/);
  assert.doesNotMatch(unknown, /future_state|other/);
});

test("the relay names who it hands acceptance to by kind; the recipient's identity stays in the full-identifier layer", () => {
  assert.equal(relayRecipient({ mode: "human" }), "交给指定的人");
  assert.equal(relayRecipient({ mode: "session" }), "交给业务智能体");
  assert.equal(relayRecipient({ mode: "leader" }), "交给统筹");
  for (const label of [...Object.values(relayStageLabel), ...Object.values(relayStateLabel)]) assert.doesNotMatch(label, /[A-Za-z]/);
});

test("a stage waits on a kind of party in words, the same kinds the next responsibility uses", () => {
  assert.equal(waitingText({ kind: "consumer", id: "c" }, null), "等待指定验收者");
  assert.equal(waitingText({ kind: "session", id: "s" }, { targetKind: "external", targetId: "s" }), "等待外部智能体");
  assert.equal(waitingText({ kind: "unknown", id: null }, null), "等待对象未登记");
});

const dependency = (title: string, acceptanceSatisfied = false): LeaderWorkDependency => ({ taskId: `${title}-id`, title,
  state: "in_progress", currentRevisionId: "r", acceptanceSatisfied, reason: null } as LeaderWorkDependency);
const blocked = { phase: "blocked" as const, pendingImpactCount: 0, dependencies: [] as LeaderWorkDependency[], queueHold: null as string | null };

test("blocked work says what holds it: basis to review, prerequisites not yet accepted, a queue hold", () => {
  assert.equal(workItemNextStep({ ...blocked, dependencies: [dependency("前置结果")], queueHold: "dependency" }),
    "等待前置任务「前置结果」通过验收；处理后再安排承接", "a dependency hold is the same fact as the prerequisite");
  assert.deepEqual(blockedReasons({ ...blocked, pendingImpactCount: 2, dependencies: [dependency("甲"), dependency("乙", true)], queueHold: "manual_review" }),
    ["2 项依据变化待复核", "等待前置任务「甲」通过验收", "队列暂停：等待人工复核"]);
  assert.equal(blockedReasons({ ...blocked, dependencies: ["一", "二", "三", "四"].map(title => dependency(title)) })[0],
    "等待前置任务「一」「二」「三」等 4 项通过验收");
  assert.deepEqual(blockedReasons({ ...blocked, queueHold: "something_new" }), ["队列暂停：原因待核对"], "an unknown hold code is not printed");
  assert.deepEqual(blockedReasons({ ...blocked, queueHold: "awaiting_acceptance" }), [], "waiting for acceptance is not a block");
  assert.equal(workItemNextStep(blocked), workNextStep("blocked"), "no known reason: the phase's general step");
  assert.equal(workItemNextStep({ ...blocked, phase: "ready", pendingImpactCount: 1 }), workNextStep("ready"), "only blocked work lists reasons");
});
