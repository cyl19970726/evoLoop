import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskAttentionFollowUp, TaskAttentionTimedTask } from "@evoloop/contracts";
import { assessTaskAttention,trialAttentionThreshold } from "../src/task-attention.ts";

const now="2026-11-04T12:00:00.000Z";
function task():TaskAttentionTimedTask {
  return {taskId:"11111111-1111-4111-8111-111111111111",
    currentRevisionId:"22222222-2222-4222-8222-222222222222",stage:null,
    latestRun:{runId:"33333333-3333-4333-8333-333333333333",state:"running"},
    timing:{createdAt:"2026-11-04T00:00:00.000Z",publication:{at:null,source:"unknown"},
      current:{stage:"running",startedAt:"2026-11-04T02:00:00.000Z",endedAt:null,
        source:{kind:"run",id:"33333333-3333-4333-8333-333333333333"},
        waitingFor:{kind:"session",id:"44444444-4444-4444-8444-444444444444"},elapsedMs:36000000},
      rounds:[],latestEffectiveProgress:null,
      executionActivity:{runId:"33333333-3333-4333-8333-333333333333",kind:"native_turn",
        at:"2026-11-04T11:55:00.000Z",observedAt:now,freshness:"live"},observedAt:now}};
}
test("live activity without effective progress ages from stage start; another Run cannot reset or trigger it",()=>{
  const source=task(),config=trialAttentionThreshold("running")!;
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="activity_without_progress")?.status,"triggered");
  source.timing.executionActivity!.runId="55555555-5555-4555-8555-555555555555";
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="activity_without_progress")?.status,"unknown");
});
test("older progress is bounded by stage start, while later progress than activity is unknown",()=>{
  const source=task(),config=trialAttentionThreshold("running")!;
  source.timing.latestEffectiveProgress={kind:"delivery",sourceId:"one",at:"2026-11-03T12:00:00.000Z"};
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="activity_without_progress")?.status,"triggered");
  source.timing.latestEffectiveProgress={kind:"delivery",sourceId:"two",at:"2026-11-04T11:58:00.000Z"};
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="activity_without_progress")?.reason,"PROGRESS_AFTER_ACTIVITY");
});
test("stale observation uses last native activity, not the time the snapshot was read",()=>{
  const source=task(),config=trialAttentionThreshold("running")!;
  source.timing.executionActivity!.freshness="stale";
  source.timing.executionActivity!.at="2026-11-04T10:00:00.000Z";
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="observation_gap")?.status,"triggered");
  source.timing.executionActivity!.freshness="unknown";
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="observation_gap")?.status,"unknown");
});
test("an explicit null threshold clears the signal instead of preserving an old alert",()=>{
  const source=task(),config=trialAttentionThreshold("running")!;
  assert.equal(assessTaskAttention(source,config,now).find(x=>x.signal==="activity_without_progress")?.status,"triggered");
  const disabled=assessTaskAttention(source,{...config,activityWithoutProgressMs:null,
    observationGapMs:null,stageOverdueMs:null},now);
  for(const signal of disabled) assert.deepEqual([signal.status,signal.reason],["clear","THRESHOLD_DISABLED"]);
});
test("current revision waiting suppresses only until its checkpoint",()=>{
  const source=task(); source.timing.current.stage="awaiting_acceptance";
  const followUp={taskId:source.taskId,taskRevisionId:source.currentRevisionId,version:1,
    waitingOn:{kind:"consumer" as const,id:"qa"},decision:"waiting" as const,
    actionTaken:"Asked QA",evidenceRef:null,nextCheckAt:"2026-11-04T13:00:00.000Z",
    releaseHandoff:null,publication:null,actorId:"lead",reason:"QA scheduled",updatedAt:now} satisfies TaskAttentionFollowUp;
  const config=trialAttentionThreshold("awaiting_acceptance")!;
  assert.equal(assessTaskAttention(source,config,now,followUp).find(x=>x.signal==="stage_overdue")?.reason,
    "WAITING_FOR_NEXT_CHECKPOINT");
  assert.equal(assessTaskAttention(source,config,"2026-11-04T13:00:00.000Z",followUp)
    .find(x=>x.signal==="stage_overdue")?.reason,"NEXT_CHECKPOINT_DUE");
  assert.equal(assessTaskAttention(source,config,now,{...followUp,taskRevisionId:"other"})
    .find(x=>x.signal==="stage_overdue")?.status,"triggered");
});
test("publication requires a fixed handoff; no normal Delivery implies it",()=>{
  const source=task();source.timing.current.stage="awaiting_publication";
  assert.equal(assessTaskAttention(source,trialAttentionThreshold("awaiting_publication"),now)[0]?.status,"unknown");
});
test("a fixed follow-up supplies the checkpoint source for a blocked stage without a start time",()=>{
  const source=task();source.timing.current={stage:"blocked",startedAt:null,endedAt:null,source:null,
    waitingFor:{kind:"unknown",id:null},elapsedMs:null};
  const followUp:TaskAttentionFollowUp={taskId:source.taskId,taskRevisionId:source.currentRevisionId,
    version:2,waitingOn:{kind:"task",id:"dependency"},decision:"waiting",actionTaken:"Checked dependency",
    evidenceRef:"fixture://dependency",nextCheckAt:"2026-11-04T11:00:00.000Z",
    releaseHandoff:null,publication:null,actorId:"lead",reason:"Waiting",updatedAt:now};
  assert.equal(assessTaskAttention(source,null,now,followUp)[0]?.reason,"NEXT_CHECKPOINT_DUE");
});

// A ready Task nobody dispatched: todo with no assignment ("unassigned"), or sent back for rework. Before this policy only the later phases had a trial
// threshold, so six Tasks waited seven hours without one notice. Dependencies not yet met is "blocked", which has no trial threshold and never fires here.
const hour=60*60*1000;
const waitingSince=(stage:"unassigned"|"rework"|"blocked",agoMs:number,at=now):TaskAttentionTimedTask=>{
  const source=task();
  source.latestRun=null as never;source.timing.executionActivity=null;
  source.timing.current={stage,startedAt:new Date(Date.parse(at)-agoMs).toISOString(),endedAt:null,source:{kind:"task_revision",id:source.currentRevisionId},waitingFor:null,elapsedMs:agoMs};
  return source;
};
const stageOverdue=(source:TaskAttentionTimedTask,at=now,followUp:TaskAttentionFollowUp|null=null)=>
  assessTaskAttention(source,trialAttentionThreshold(source.timing.current.stage),at,followUp).find(x=>x.signal==="stage_overdue")!;
test("a ready Task with no assignment gets a 2 hour trial threshold, and so does rework",()=>{
  assert.equal(trialAttentionThreshold("unassigned")?.stageOverdueMs,2*hour);
  assert.equal(trialAttentionThreshold("rework")?.stageOverdueMs,2*hour);
  for(const stage of ["unassigned","rework"] as const){
    assert.deepEqual([stageOverdue(waitingSince(stage,2*hour+60_000)).status,stageOverdue(waitingSince(stage,2*hour+60_000)).reason],["triggered","THRESHOLD_REACHED"],`${stage} past 2 hours`);
    assert.deepEqual([stageOverdue(waitingSince(stage,2*hour-60_000)).status,stageOverdue(waitingSince(stage,2*hour-60_000)).reason],["clear","BELOW_THRESHOLD"],`${stage} just ready`);
  }
  assert.equal(stageOverdue(waitingSince("unassigned",4*hour+60_000)).severity,"urgent","twice the threshold escalates");
});
test("the same Task at night reminds the same way: no time of day is consulted",()=>{
  const night="2026-11-04T03:10:00.000Z";
  assert.equal(stageOverdue(waitingSince("unassigned",3*hour,night),night).status,"triggered");
});
test("a Task marked as waiting for something, or waiting on its dependencies, is not reminded",()=>{
  const source=waitingSince("unassigned",3*hour);
  const followUp={taskId:source.taskId,taskRevisionId:source.currentRevisionId,version:1,waitingOn:{kind:"user" as const,id:"the consumer"},decision:"waiting" as const,
    actionTaken:"Waiting for the user to be free",evidenceRef:null,nextCheckAt:"2026-11-04T18:00:00.000Z",releaseHandoff:null,publication:null,actorId:"lead",reason:"explicit wait",updatedAt:now} satisfies TaskAttentionFollowUp;
  assert.equal(stageOverdue(source,now,followUp).reason,"WAITING_FOR_NEXT_CHECKPOINT");
  assert.equal(stageOverdue(source,"2026-11-04T18:00:00.000Z",followUp).reason,"NEXT_CHECKPOINT_DUE","and again once the checkpoint passes");
  const blocked=waitingSince("blocked",10*hour);
  assert.notEqual(stageOverdue(blocked).status,"triggered","unmet dependencies are blocked, not ready");
});
