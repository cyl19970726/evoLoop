import test from "node:test";
import assert from "node:assert/strict";
import type { Occurrence } from "@evoloop/contracts/scheduling";
import {
  coordinatorErrorText, grantEmptyText, nextTimeText, occurrenceReasonKnown, occurrenceReasonText, ruleIsComputable,
  scheduleRuleLabel, latestOccurrence, occurrenceLabel, scheduleReadView, scheduleRuleText, scheduleTime, utcInstant, zoneName,
} from "../src/features/scheduling/presentation.ts";
test("occurrence reasons from the scheduler read as Chinese; an unknown reason is summarised, not shown",()=>{
 // The codes written by packages/core/src/scheduling/index.ts.
 for (const reason of ["scheduled","overlap skipped","overlap queued","queued occurrence admitted"]) {
  assert.equal(occurrenceReasonKnown(reason),true);
  assert.doesNotMatch(occurrenceReasonText(reason),/[A-Za-z]/);
 }
 assert.equal(occurrenceReasonText("overlap skipped"),"上一份任务还没结束，按设置跳过这个时刻");
 assert.equal(occurrenceReasonKnown("clock skew"),false);
 assert.doesNotMatch(occurrenceReasonText("clock skew"),/clock/);
 assert.doesNotMatch(coordinatorErrorText,/[A-Za-z]/);
});
test("grants are only called absent after a current read",()=>{
 assert.match(grantEmptyText({fresh:true,loading:false}),/^没有/);
 assert.doesNotMatch(grantEmptyText({fresh:false,loading:true}),/没有/);
 assert.doesNotMatch(grantEmptyText({fresh:false,loading:false}),/没有/);
 assert.match(grantEmptyText({fresh:false,loading:false}),/无法判断/);
});
test("a rule that cannot be worked out says so instead of claiming no future instant",()=>{
 const now=Date.parse("2026-11-09T12:00:00.000Z"), format=(iso:string)=>iso;
 assert.equal(ruleIsComputable({kind:"daily",localTime:"09:00"},"Not/AZone"),false);
 assert.equal(ruleIsComputable({kind:"daily",localTime:"25:00"},"Asia/Taipei"),false);
 assert.equal(ruleIsComputable({kind:"daily",localTime:"9:00"},"Asia/Taipei"),false);
 assert.equal(ruleIsComputable({kind:"once",atUtc:"not a time"},"UTC"),false);
 assert.equal(ruleIsComputable({kind:"interval",anchorUtc:"2026-11-09T00:00:00Z",everyMinutes:0},"UTC"),false);
 assert.match(nextTimeText({kind:"daily",localTime:"09:00"},"Not/AZone",now,format),/^无法推算/);
 assert.equal(nextTimeText({kind:"once",atUtc:"2026-11-01T00:00:00Z"},"UTC",now,format),"规则里没有以后的时刻");
 assert.equal(nextTimeText({kind:"once",atUtc:"2026-11-10T00:00:00Z"},"UTC",now,format),"2026-11-10T00:00:00.000Z（按规则推算的预览）");
});
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
test("a schedule's times are said in its own zone, with the reader's clock when it reads otherwise",()=>{
 const at="2026-11-10T01:00:00.000Z";
 // Same wall clock (Taipei and Shanghai are both UTC+8): no second time.
 assert.equal(scheduleTime(at,"Asia/Taipei","Asia/Shanghai"),"2026/11/10 09:00:00 · 台北");
 // A reader in another zone also gets their own time.
 assert.equal(scheduleTime(at,"Asia/Taipei","Europe/London"),"2026/11/10 09:00:00 · 台北（你的时间 2026/11/10 01:00:00）");
 assert.equal(scheduleTime(at,"America/New_York","America/New_York"),"2026/11/9 20:00:00 · 纽约");
 // An unknown zone is not guessed: the reader's time, said as such.
 assert.equal(scheduleTime(at,"Not/AZone","Asia/Shanghai"),"2026/11/10 09:00:00（你的时间；日程时区无法识别）");
 assert.equal(zoneName("Pacific/Auckland"),"Pacific/Auckland");
 assert.equal(scheduleRuleText({kind:"once",atUtc:at},"Asia/Taipei",0,"Asia/Taipei"),"仅一次 · 2026/11/10 09:00:00 · 台北");
 assert.equal(scheduleRuleText({kind:"interval",anchorUtc:at,everyMinutes:30},"UTC",0,"UTC"),"从 2026/11/10 01:00:00 · UTC 起，每 30 分钟");
 const now=Date.parse("2026-11-10T00:00:00Z");
 assert.equal(scheduleRuleText({kind:"daily",localTime:"09:00"},"Asia/Taipei",now,"Asia/Shanghai"),"每天 09:00（台北当地时间）");
 assert.equal(scheduleRuleText({kind:"daily",localTime:"09:00"},"Asia/Taipei",now,"Europe/London"),"每天 09:00（台北当地时间，下次是你的时间 11/10 01:00）");
 // Only the next run is put on the reader clock: across a daylight-saving change the later ones fall at another hour.
 const beforeChange=Date.parse("2026-03-27T12:00:00Z");
 assert.equal(scheduleRuleText({kind:"daily",localTime:"09:00"},"Asia/Taipei",beforeChange,"Europe/London"),"每天 09:00（台北当地时间，下次是你的时间 03/28 01:00）");
 assert.equal(scheduleRuleText({kind:"daily",localTime:"09:00"},"Asia/Taipei",Date.parse("2026-03-30T12:00:00Z"),"Europe/London"),"每天 09:00（台北当地时间，下次是你的时间 03/31 02:00）");
 assert.equal(scheduleRuleText({kind:"daily",localTime:"09:00"},"Not/AZone",now,"Asia/Shanghai"),"每天 09:00（Not/AZone 当地时间）");
});
