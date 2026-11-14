// Task 3c6973c5: a tool of a Turn that has ended is not "running". Pure functions; the page is checked in turn-state-browser.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settleEndedTools } from "../src/features/sessions/workspaceTimelineModel";
import { toolGroupStatus, toolStepState } from "../src/features/sessions/conversationPresentation";
import { timelineAssistant, timelineMessage, timelineTool } from "./session-timeline-fixtures";

const turn = (id: string, state: "running" | "completed" | "failed" | "interrupted" | "unknown") => ({ id, state });
const running = (turnId: string) => timelineTool(`tool-${turnId}`, "命令", turnId, "running", { turnId, freshness: "live" });
const tools = (entries: ReturnType<typeof settleEndedTools>) => entries.filter(e => e.kind === "tool");

test("a running tool of a completed, failed or interrupted Turn becomes unconfirmed; a tool of a running or unknown Turn, or of no known Turn, is left alone", () => {
  const entries = [running("done"), running("int"), running("fail"), running("run"), running("unk"), running("nowhere"), timelineMessage("m", "x"), timelineAssistant("a", "y", { turnId: "done" })];
  const settled = settleEndedTools(entries, [turn("done", "completed"), turn("int", "interrupted"), turn("fail", "failed"), turn("run", "running"), turn("unk", "unknown")]);
  const state = (id: string) => (tools(settled).find(e => e.turnId === id) as { state: string }).state;
  assert.deepEqual(["done", "int", "fail"].map(state), ["unknown", "unknown", "unknown"]);
  assert.deepEqual(["run", "unk", "nowhere"].map(state), ["running", "running", "running"]);
  assert.equal(settled.length, entries.length, "nothing is added or dropped");
  assert.equal(settled.find(e => e.id === "a"), entries.find(e => e.id === "a"), "other entries are the same objects");
});

test("a tool that already ended keeps its own result; settling twice changes nothing; with no ended Turn the same array comes back", () => {
  const done = timelineTool("t1", "命令", "ok", "completed", { turnId: "done" }), failed = timelineTool("t2", "命令", "bad", "failed", { turnId: "done" });
  const entries = [done, failed, running("done")];
  const once = settleEndedTools(entries, [turn("done", "interrupted")]);
  assert.equal(once[0], done); assert.equal(once[1], failed);
  assert.deepEqual(settleEndedTools(once, [turn("done", "interrupted")]), once);
  const untouched = [running("run")];
  assert.equal(settleEndedTools(untouched, [turn("run", "running")]), untouched);
});

test("the group line and the step say 结果未确认 for such a tool, never 正在进行 or 进行中, and a really running tool still says it", () => {
  const [settled] = tools(settleEndedTools([running("int")], [turn("int", "interrupted")])) as Array<{ state: any; freshness: any; durationMs: number | null }>;
  assert.ok(!/正在进行|进行中/.test(toolGroupStatus([settled!])), toolGroupStatus([settled!]));
  assert.match(toolGroupStatus([settled!]), /1 项结果未确认/);
  assert.match(toolStepState(settled!), /结果未确认/);
  const live = running("run") as { state: any; freshness: any; durationMs: number | null };
  assert.match(toolGroupStatus([live]), /正在进行/);
  assert.equal(toolStepState(live), "进行中");
});
