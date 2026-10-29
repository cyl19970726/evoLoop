import test from "node:test";
import assert from "node:assert/strict";
import type { Occurrence } from "@evoloop/contracts/scheduling";
import { scheduleRuleLabel, latestOccurrence, occurrenceLabel, scheduleReadView, utcInstant } from "../src/scheduling/presentation.ts";
test("once and interval anchors label their stored UTC instant, not the browser's local zone",()=>{
 assert.match(scheduleRuleLabel({kind:"once",atUtc:"2026-10-30T00:00:00Z"}),/2026-10-30 00:00:00 UTC/);
 assert.match(scheduleRuleLabel({kind:"interval",anchorUtc:"2026-10-30T08:00:00+08:00",everyMinutes:30}),/2026-10-30 00:00:00 UTC/);
 assert.equal(utcInstant("2026-10-30T08:00:00+08:00"),"2026-10-30 00:00:00 UTC");
 assert.equal(utcInstant("2026-10-30T00:00:00.123Z"),"2026-10-30 00:00:00.123 UTC");
 assert.match(scheduleRuleLabel({kind:"daily",localTime:"09:00"},"Asia/Taipei"),/09:00（Asia\/Taipei 当地时间）/);
});
test("latest check is ordered by observed time and does not imply a Run or acceptance",()=>{
 const older={state:"created",observedAtUtc:"2026-10-29T02:00:00Z"} as Occurrence;
 const newer={state:"skipped",observedAtUtc:"2026-10-30T02:00:00Z"} as Occurrence;
 assert.equal(latestOccurrence([newer,older]),newer);
 assert.equal(occurrenceLabel(older),"已创建待办任务");
 assert.equal(latestOccurrence([]),null);
});
test("schedule read keeps prior same-scope facts visible but revokes write freshness on refresh or failure",()=>{
 const old={scope:"project-a:actor-a",readKey:"read-1",schedules:["schedule-a"]};
 assert.equal(scheduleReadView(old,old.scope,"read-1",{readKey:"read-1",loading:false,error:""}).fresh,true);
 const refreshing=scheduleReadView(old,old.scope,"read-2",{readKey:"read-1",loading:false,error:""});
 assert.deepEqual(refreshing.value?.schedules,["schedule-a"]);
 assert.equal(refreshing.fresh,false);
 const failed=scheduleReadView(old,old.scope,"read-2",{readKey:"read-2",loading:false,error:"服务不可用"});
 assert.equal(failed.value,old);
 assert.equal(failed.fresh,false);
 assert.equal(failed.error,"服务不可用");
 assert.equal(scheduleReadView(old,"project-b:actor-a","read-2",{readKey:"read-1",loading:false,error:""}).value,null);
});
