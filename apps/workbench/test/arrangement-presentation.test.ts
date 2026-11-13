import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityUnknownReason, directoryWorkCaption, freeCountStat, noConflictText, noFreeAgentText, readStateOf,
} from "../src/features/sessions/arrangementPresentation.ts";

// The next step per phase moved to shared/workPresentation.ts; its tests are in work-presentation.test.ts.

test("the directory's current work says where it comes from and that its phase is unread", () => {
  assert.equal(directoryWorkCaption("accepted"), "智能体目录记录：已接手 · 阶段未读取");
  assert.equal(directoryWorkCaption("claimed"), "智能体目录记录：已从排队中领取 · 阶段未读取");
  assert.doesNotMatch(directoryWorkCaption("assigned"), /回报/, "the agent did not report it");
});

test("read states separate no answer, a failed read and a previous answer kept after a failed reread", () => {
  assert.equal(readStateOf({}), "loading");
  assert.equal(readStateOf({ error: new Error("x") }), "failed");
  assert.equal(readStateOf({ data: [], error: new Error("x") }), "stale");
  assert.equal(readStateOf({ data: [], error: null }), "ready");
});

test("free capacity is only judged with every open Task and the queues", () => {
  assert.match(capacityUnknownReason("loading", false, "ready")!, /正在读取任务/);
  assert.match(capacityUnknownReason("failed", false, "ready")!, /无法判断谁空闲/);
  assert.match(capacityUnknownReason("ready", false, "ready")!, /没有读全/);
  assert.match(capacityUnknownReason("ready", true, "failed")!, /队列暂不可读取/);
  assert.match(capacityUnknownReason("ready", true, "loading")!, /正在读取队列/);
  assert.equal(capacityUnknownReason("ready", true, "ready"), null);
  assert.equal(capacityUnknownReason("stale", true, "stale"), null, "a kept answer is shown, labelled by the page");
});

test("nobody free is only 'everyone has work' when every other agent's work is on record", () => {
  assert.equal(noFreeAgentText({ judged: true, free: [], others: 0, unknown: 0 }), "统筹以外还没有其他智能体。");
  assert.doesNotMatch(noFreeAgentText({ judged: true, free: [], others: 0, unknown: 0 }), /都有|每个/);
  assert.match(noFreeAgentText({ judged: true, free: [], others: 3, unknown: 0 }), /都有在做、已分派或排队的工作/);
  assert.match(noFreeAgentText({ judged: true, free: [], others: 1, unknown: 0 }), /唯一的智能体有在做/);
  assert.equal(noFreeAgentText({ judged: true, free: [], others: 3, unknown: 1 }), "没有可确认空闲的智能体。");
  assert.match(noFreeAgentText({ judged: true, free: [], others: 2, unknown: 2 }), /都待核对/);
});

test("the 空闲 count at the top is never 0 while the right column cannot say who is free (N6)", () => {
  const row = {} as never;
  // Records not complete enough to judge: 无法判断, not 0 and not a bare question mark.
  assert.deepEqual(freeCountStat({ judged: false, free: [], others: 2, unknown: 0 }, "任务没有读全，无法确认谁空闲。", false), { value: "无法判断", label: "谁空闲" });
  // Every other agent's occupation is still 待核对 (the right column: 暂不能确认谁空闲): 无法判断 as well.
  assert.deepEqual(freeCountStat({ judged: true, free: [], others: 2, unknown: 2 }, null, false), { value: "无法判断", label: "谁空闲" });
  assert.deepEqual(freeCountStat({ judged: true, free: [], others: 3, unknown: 1 }, null, false), { value: "无法判断", label: "谁空闲" });
  // Known: the number, with the agents still to check noted rather than counted.
  assert.deepEqual(freeCountStat({ judged: true, free: [row], others: 3, unknown: 1 }, null, false), { value: 1, label: "个智能体空闲", note: "另有 1 个待核对" });
  assert.deepEqual(freeCountStat({ judged: true, free: [], others: 2, unknown: 0 }, null, false), { value: 0, label: "个智能体空闲" }, "0 only when everyone's work is on record");
  assert.deepEqual(freeCountStat({ judged: true, free: [row, row], others: 2, unknown: 0 }, null, true), { value: 2, label: "个智能体空闲", note: "上次读回" });
});

test("no conflict is only claimed from a complete read", () => {
  assert.match(noConflictText("loading", false, ""), /正在读取任务/);
  assert.equal(noConflictText("failed", false, "服务不可用"), "任务暂不可读取，无法判断冲突：服务不可用");
  assert.match(noConflictText("ready", false, ""), /其余任务还没核对/);
  assert.match(noConflictText("ready", true, ""), /记录里没有看出冲突/);
});

test("an agent directory that was not read to its end never yields a '0 个空闲' (#295 item 1)", () => {
  const row = {} as never;
  // Nobody known to be free, but agents were left unread: not 0.
  assert.deepEqual(freeCountStat({ judged: true, free: [], others: 3, unknown: 0 }, null, false, false), { value: "无法判断", label: "谁空闲", note: "智能体目录没读全" });
  // Some known to be free: the count is a floor and says so.
  assert.deepEqual(freeCountStat({ judged: true, free: [row], others: 3, unknown: 0 }, null, false, false), { value: 1, label: "个智能体空闲", note: "目录没读全，未读到的智能体未计入" });
  // A fully read directory keeps the old, exact behaviour (0 only when everyone's work is on record).
  assert.deepEqual(freeCountStat({ judged: true, free: [], others: 2, unknown: 0 }, null, false, true), { value: 0, label: "个智能体空闲" });
  assert.match(noFreeAgentText({ judged: true, free: [], others: 3, unknown: 0 }, false), /智能体目录没有读全，无法确认谁空闲/);
  assert.doesNotMatch(noFreeAgentText({ judged: true, free: [], others: 3, unknown: 0 }, false), /没有空闲的智能体：/);
  assert.match(noFreeAgentText({ judged: true, free: [], others: 3, unknown: 0 }, true), /没有空闲的智能体：/);
});
