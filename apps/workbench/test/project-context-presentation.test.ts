import test from "node:test";
import assert from "node:assert/strict";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { WorkTaskStatus } from "../src/workflow/workStatusPresentation.ts";
import { readOutcome,selectAttention } from "../src/overview/contextPresentation.ts";
const row=(overrides:Partial<LeaderWorkTask>={})=>({taskId:"task",version:2,currentRevisionId:"closed",taskState:"in_progress",phase:"blocked",plan:null,review:null,delivery:{deliveryId:"accepted"},...overrides}) as LeaderWorkTask;
const statuses={task:{taskId:"task",cognition:false}} as Record<string,WorkTaskStatus>;
test("attention ignores closed and formal cognition rows and keeps deferred work behind other current work",()=>{
 assert.equal(selectAttention([row({taskState:"done"})],statuses),null);
 assert.equal(selectAttention([row()],{task:{...statuses.task!,cognition:true}}),null);
 assert.equal(selectAttention([row()],{}),null);
 const other=row({taskId:"other",phase:"ready"});
 assert.equal(selectAttention([row({review:{decision:"deferred"} as LeaderWorkTask['review']}),other],{...statuses,other:{...statuses.task!,taskId:"other"}})?.taskId,"other");
});
test("observed use follows the exact current/closure-linked delivery, not later unrelated history",()=>{
 const detail={task:{id:"task",version:2,currentRevisionId:"closed",projectId:"p"},deliveries:[{id:"accepted",taskId:"task",projectId:"p"},{id:"unrelated",taskId:"task",projectId:"p"}],observations:[{id:"used",deliveryId:"accepted",createdAt:"2026-10-30T00:00:00Z"},{id:"later",deliveryId:"unrelated",createdAt:"2026-10-31T00:00:00Z"}]} as TaskDetail;
 assert.equal(readOutcome(row(),detail)?.observation.id,"used");
 assert.equal(readOutcome(row({version:3}),detail),null);
 assert.equal(readOutcome(row({currentRevisionId:"reopened"}),detail),null);
 detail.observations.push({...detail.observations[0]!,id:"correction",createdAt:"2026-10-29T00:00:00Z"});
 assert.equal(readOutcome(row(),detail)?.observation.id,"correction", "later registered correction wins even with earlier use time");
 detail.observations.push({...detail.observations[0]!,id:"same-time"});
 assert.equal(readOutcome(row(),detail)?.observation.id,"same-time");
});
