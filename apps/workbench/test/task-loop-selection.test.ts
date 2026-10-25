import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import type { WorkTaskStatus } from "../src/workflow/workStatusPresentation.ts";
import { selectedTaskLoop, taskLoopAssociation } from "../src/orchestration/taskLoopSelection.ts";

const old = { loopId: "old-loop", dispatchIds: ["old-dispatch"], parentDispatchIds: [], sourceEventIds: [] };
const current = { loopId: "new-loop", dispatchIds: ["new-dispatch"], parentDispatchIds: [], sourceEventIds: [] };
const status = { taskId: "task", dispatchId: "new-dispatch", runId: "new-run", runState: "running" } as WorkTaskStatus;
const run = { id: "new-run", taskId: "task", state: "running" } as RuntimeRunRecord;

test("running Task selects its formal dispatch's Loop even when a stopped historical Loop is first", () => {
  const association = taskLoopAssociation(status, [old,current], [run], false);
  assert.deepEqual(association, {kind:"current",loopId:"new-loop",runId:"new-run"});
  assert.equal(selectedTaskLoop(null,association,[old.loopId,current.loopId]),current.loopId);
});

test("ambiguous, missing and failed evidence never claims a current Loop", () => {
  for (const contexts of [[old], [current,{...current,loopId:"duplicate"}]])
    assert.equal(taskLoopAssociation(status,contexts,[run],false).kind,"unresolved");
  assert.equal(taskLoopAssociation(null,[old,current],[run],false).kind,"unresolved");
  assert.equal(taskLoopAssociation(status,[old,current],null,false).kind,"unresolved");
  assert.equal(taskLoopAssociation(status,[old,current],[run],true).kind,"unresolved");
  assert.equal(taskLoopAssociation(status,[old,current],[{...run,id:"other"}],false).kind,"unresolved");
  assert.equal(taskLoopAssociation(status,[old,current],[{...run,taskId:"other-task"}],false).kind,"unresolved");
  assert.equal(taskLoopAssociation(status,[old,current],[],false).kind,"unresolved");
});

test("manual history selection survives refreshed evidence and run polling, then resets with Task context", () => {
  const association = taskLoopAssociation(status,[old,current],[run],false);
  assert.equal(selectedTaskLoop(old.loopId,association,[old.loopId,current.loopId]),old.loopId);
  const polled = taskLoopAssociation({...status,runState:"completed"},[old,current],[{...run,state:"completed"}],false);
  assert.equal(polled.kind,"recent");
  assert.equal(selectedTaskLoop(old.loopId,polled,[old.loopId,current.loopId]),old.loopId);
  const otherTask = taskLoopAssociation({...status,taskId:"other",dispatchId:"old-dispatch",runId:null,runState:null},[old,current],[],false);
  assert.equal(selectedTaskLoop(null,otherTask,[old.loopId,current.loopId]),old.loopId);
});
