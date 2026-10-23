import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ApiError } from "../src/api.ts";
import { mergePage, orchestrationClient } from "../src/orchestration/client.ts";
import { decisionHeading, deliveryMeaning, dispatchStateLabel, inboxStateLabel, sealReasonLabel, sourceTriggerLabel, storyTitle, submissionStateLabel } from "../src/orchestration/presentation.ts";
import { currentChainSummary, hasUnreadChainPages, inTaskContext, nextAction, orderDispatches, readableOutcome } from "../src/orchestration/summary.ts";
import { navigateTaskTab, scrollToTaskSection, taskSectionFromHash, taskSectionHref } from "../src/orchestration/navigation.ts";
import type { OrchestrationDispatch, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import type { TaskDetail } from "@evoloop/contracts";
import type { WorkTaskStatus } from "../src/workflow/workStatusPresentation.ts";

const projectId = "11111111-1111-4111-8111-111111111111", loopId = "22222222-2222-4222-8222-222222222222";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("observer uses scoped pagination and preserves the server's more-pages signal", async () => {
  const paths: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost"); paths.push(url.pathname + url.search);
    return response({ items: [{ id: loopId }], nextCursor: "opaque/+next" });
  });
  try {
    const client = orchestrationClient("private", projectId);
    const first = await client.loops();
    const second = await client.part(loopId, "dispatches", first.nextCursor!);
    assert.equal(first.nextCursor, "opaque/+next"); assert.equal(second.nextCursor, "opaque/+next");
    assert.deepEqual(paths, [`/api/projects/${projectId}/orchestration/loops?limit=50`,
      `/api/projects/${projectId}/orchestration/loops/${loopId}/dispatches?limit=50&cursor=opaque%2F%2Bnext`]);
    const merged = mergePage({ items: [{ id: "one", version: 1 }], nextCursor: "next" },
      { items: [{ id: "one", version: 2 }, { id: "two", version: 1 }], nextCursor: null });
    assert.deepEqual(merged.items.map(item => [item.id, item.version]), [["one", 2], ["two", 1]]);
    assert.equal(merged.nextCursor, null);
  } finally { fetch.mock.restore(); }
});

test("disabled status is explicit and a malformed page never looks complete", async () => {
  let missing = true;
  const fetch = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    String(input).endsWith("/status") ? response({ code: "NOT_FOUND" }, 404) :
      missing ? response({ code: "NOT_FOUND" }, 404) : response({ items: [] }));
  try {
    const client = orchestrationClient("private", projectId);
    assert.deepEqual(await client.status(), { state: "disabled" });
    assert.deepEqual(await client.overview(), { status: { state: "disabled" }, loops: { items: [], nextCursor: null } });
    missing = false;
    await assert.rejects(client.loops(), error => error instanceof ApiError && /分页状态/.test(error.message));
  } finally { fetch.mock.restore(); }
});

test("presentation keeps Run, submission, sealed Delivery and use separate", () => {
  assert.equal(inboxStateLabel.pending, "待处理");
  assert.equal(inboxStateLabel.acknowledged, "已接收待决定");
  assert.equal(dispatchStateLabel.unknown, "派发结果未知");
  assert.equal(submissionStateLabel.sealed, "已封存交付");
  const submission = { state: "submitted", deliveryId: null } as OrchestrationSubmission;
  assert.match(deliveryMeaning(submission), /尚不能视为正式 Delivery/);
  assert.match(deliveryMeaning({ ...submission, state: "unknown" }), /不可推定交付失败/);
  assert.match(deliveryMeaning({ ...submission, state: "sealed", deliveryId: loopId }), /仍须另行观察使用与 Task 验收/);
  assert.match(sealReasonLabel("AUTHORITATIVE_DELIVERY"), /原交付操作读回/);
});

test("human summary distinguishes signed intent, actual delivery and human use", () => {
  const dispatch={id:"a",taskId:"task",sourceEventId:"source",parentDispatchId:null,state:"accepted",runtimeRunId:"run",outcome:null} as OrchestrationDispatch;
  const submitted={dispatchId:"a",state:"submitted",deliveryId:null} as OrchestrationSubmission;
  assert.match(readableOutcome(dispatch,submitted,undefined),/等待正式封存/);
  assert.match(nextAction(undefined,dispatch,submitted),/等待交付封存/);
  const sealed={...submitted,state:"sealed",deliveryId:"delivery"} as OrchestrationSubmission;
  const detail={deliveries:[{id:"delivery",artifactRef:"固定报告"}],observations:[]} as TaskDetail;
  assert.match(readableOutcome(dispatch,sealed,detail),/尚无可确认的人类使用记录/);
  assert.match(readableOutcome(dispatch,sealed,{...detail,observations:[{deliveryId:"delivery",observerKind:"agent",result:"used"}]} as TaskDetail),/尚无可确认的人类使用记录/);
  assert.match(readableOutcome(dispatch,sealed,{...detail,observations:[{deliveryId:"delivery",observerKind:"human",result:"used"}]} as TaskDetail),/有人记录实际使用/);
  assert.match(readableOutcome({...dispatch,state:"unknown"},sealed,detail),/不能认定没有执行/);
  assert.match(nextAction({state:"pending"} as OrchestrationInbox,undefined,undefined),/核对入站来源/);
});

test("task story follows server-verified dispatch IDs and an explicit upstream parent, never a shared source alone", () => {
  const direct={id:"a",taskId:"task",sourceEventId:"source",parentDispatchId:null} as OrchestrationDispatch;
  const sameSource={id:"b",taskId:"other",sourceEventId:"source",parentDispatchId:null} as OrchestrationDispatch;
  const child={id:"c",taskId:"third",sourceEventId:"later",parentDispatchId:"a"} as OrchestrationDispatch;
  const unrelated={id:"d",taskId:"unrelated",sourceEventId:"unrelated",parentDispatchId:null} as OrchestrationDispatch;
  const context={loopId,sourceEventIds:["source"],dispatchIds:["a"],parentDispatchIds:[]};
  assert.equal(inTaskContext(direct,context),true);
  assert.equal(inTaskContext(sameSource,context),false);
  assert.equal(inTaskContext(child,{...context,dispatchIds:["a","c"]}),true);
  assert.equal(inTaskContext(unrelated,context),false);
  const feedback={...unrelated,id:"next-cognition",sourceEventId:"outcome-event",parentDispatchId:null};
  assert.equal(inTaskContext(feedback,{...context,sourceEventIds:["source","outcome-event"]}),false);
  assert.equal(inTaskContext(feedback,{...context,dispatchIds:["a","next-cognition"]}),true);
  assert.equal(inTaskContext(sameSource,{...context,parentDispatchIds:["b"]}),true);
});

test("three Task links select fixed history, runtime and delivery without crossing Task scope", () => {
  const taskId="33333333-3333-4333-8333-333333333333", revisionId="44444444-4444-4444-8444-444444444444";
  const fixed=taskSectionHref(projectId,taskId,{revisionId});
  const runtime=taskSectionHref(projectId,taskId,{tab:"runtime"});
  const delivery=taskSectionHref(projectId,taskId,{tab:"delivery"});
  assert.equal(taskSectionFromHash(fixed,projectId,taskId),"history");
  assert.equal(taskSectionFromHash(runtime,projectId,taskId),"runtime");
  assert.equal(taskSectionFromHash(delivery,projectId,taskId),"delivery");
  assert.equal(new Set([fixed,runtime,delivery]).size,3);
  assert.equal(taskSectionFromHash(runtime,projectId,"55555555-5555-4555-8555-555555555555"),null);
  assert.equal(taskSectionFromHash(runtime,loopId,taskId),null);
  assert.equal(taskSectionFromHash(`${runtime}&tab=history`,projectId,taskId),"overview");
});

test("deep-linked delivery lands at its visible panel, while hidden or missing panels cannot claim a landing", () => {
  const taskId="33333333-3333-4333-8333-333333333333";
  const calls:string[]=[];
  const deliveryPanel={hidden:false,scrollIntoView:(options:{block:string})=>calls.push(options.block)} as HTMLElement;
  const getElement=(id:string)=>id === `task-panel-${projectId}-${taskId}-current-delivery` ? deliveryPanel : null;
  assert.equal(scrollToTaskSection(projectId,taskId,"delivery",undefined,getElement),true);
  assert.deepEqual(calls,["start"]);
  assert.equal(scrollToTaskSection(projectId,taskId,"runtime",undefined,getElement),false);
  assert.equal(scrollToTaskSection(projectId,taskId,"history",loopId,()=>({...deliveryPanel,hidden:true}) as HTMLElement),false);
  assert.deepEqual(calls,["start"]);
});

test("internal Task tab updates the URL so a later same-Task delivery link changes route and Back restores runtime", () => {
  const taskId="33333333-3333-4333-8333-333333333333";
  const delivery=taskSectionHref(projectId,taskId,{tab:"delivery"});
  const runtime=taskSectionHref(projectId,taskId,{tab:"runtime"});
  const location={hash:delivery};
  assert.equal(navigateTaskTab(projectId,taskId,"runtime",location),true);
  assert.equal(location.hash,runtime);
  assert.equal(taskSectionFromHash(location.hash,projectId,taskId),"runtime");
  assert.notEqual(location.hash,delivery,"the story link is now a real hash navigation");
  location.hash=delivery;
  assert.equal(taskSectionFromHash(location.hash,projectId,taskId),"delivery");
  assert.equal(navigateTaskTab(projectId,taskId,"delivery",location),false);
  location.hash=runtime;
  assert.equal(taskSectionFromHash(location.hash,projectId,taskId),"runtime");
});

test("story trigger uses formal source kind and leaves complete reasons to expanded evidence", () => {
  const source=(kind:string)=>({kind} as OrchestrationSourceFact);
  assert.match(sourceTriggerLabel(source("worker.outcome")),/工作结果/);
  assert.match(sourceTriggerLabel(source("observation.record")),/实际使用反馈/);
  assert.match(sourceTriggerLabel(source("dispatch.gap")),/缺少署名结果/);
  assert.match(sourceTriggerLabel(undefined),/尚未读回/);
  assert.doesNotMatch(sourceTriggerLabel(source("worker.outcome")),/[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("loaded chain uses formal parent, outcome and sealed observation edges before stable time ties", () => {
  const dispatch=(id:string,time:string,sourceEventId=id,parentDispatchId:string|null=null)=>
    ({id,taskId:id,sourceEventId,parentDispatchId,createdAtUtc:time} as OrchestrationDispatch);
  const first=dispatch("first","2026-10-23T09:00:00Z");
  const business=dispatch("business","2026-10-23T10:00:00Z","from-first");
  const feedback=dispatch("feedback","2026-10-23T08:00:00Z","use-report");
  const gap=dispatch("gap","2026-10-23T11:00:00Z","from-feedback");
  const unrelated=dispatch("unrelated","2026-10-23T09:30:00Z","shared-but-unverified");
  const sources=[{id:"from-first",kind:"worker.outcome",originDispatchId:"first"},
    {id:"use-report",kind:"observation.record",deliveryId:"fixed-delivery"},
    {id:"from-feedback",kind:"dispatch.gap",originDispatchId:"feedback"}] as OrchestrationSourceFact[];
  const submissions=[{dispatchId:"business",state:"sealed",deliveryId:"fixed-delivery"},
    {dispatchId:"unrelated",state:"submitted",deliveryId:"other-delivery"}] as OrchestrationSubmission[];
  const ordered=orderDispatches([gap,unrelated,feedback,business,first],sources,submissions);
  assert.deepEqual(ordered.ordered.map(item=>item.id),["first","unrelated","business","feedback","gap"]);
  assert.deepEqual([...ordered.hasLater].sort(),["business","feedback","first"]);
  assert.equal(hasUnreadChainPages([{nextCursor:null},{nextCursor:"next"}]),true);
  assert.equal(hasUnreadChainPages([{nextCursor:null},{nextCursor:null}]),false);
});

test("human cognition title requires this dispatch's exact projection and never promotes an event UUID", () => {
  const dispatch={id:"current",taskId:"task",purpose:"cognition"} as OrchestrationDispatch;
  const source={kind:"observation.record"} as OrchestrationSourceFact;
  const stale={dispatchId:"old",sourceTaskTitle:"Business report",sourceTaskId:"source"} as WorkTaskStatus;
  const sourceBusiness={cognition:false} as WorkTaskStatus;
  assert.doesNotMatch(storyTitle(dispatch,"Cognition: event 1234",source,stale,sourceBusiness,"固定报告目标"),/Business report|Cognition: event/);
  assert.match(storyTitle(dispatch,"Cognition: event 1234",source,{...stale,dispatchId:"current"},sourceBusiness,"固定报告目标"),/Business report/);
  assert.equal(storyTitle({...dispatch,purpose:"business"},"普通调研任务",source,undefined,undefined,"固定报告目标"),"普通调研任务");
  const longGoal="固定目标".repeat(30);
  const compact=storyTitle(dispatch,"Cognition: event 1234",source,undefined,undefined,longGoal);
  assert.ok(compact.length < longGoal.length);
  assert.ok(compact.endsWith("…"));
  assert.equal(decisionHeading(false),"派发决定");
  assert.equal(decisionHeading(true),"Worker 署名判定");
});

test("current chain summary separates signed stop, Agent use and unclosed business Task", () => {
  const loop={state:"stopped"} as OrchestrationLoop;
  const dispatch={id:"decision-dispatch",taskId:"business-task",purpose:"business",state:"completed",outcome:"no_action"} as OrchestrationDispatch;
  const decision={id:"decision",dispatchId:dispatch.id,kind:"stop",createdAtUtc:"2026-10-23T12:00:00Z"} as OrchestrationWorkerDecision;
  const submission={dispatchId:dispatch.id,state:"sealed",deliveryId:"delivery"} as OrchestrationSubmission;
  const task={task:{id:dispatch.taskId,state:"in_progress"},closures:[],observations:[{deliveryId:"delivery",result:"used",observerKind:"agent"}]} as TaskDetail;
  const lines=currentChainSummary(loop,[dispatch],[submission],[decision],[task],dispatch.taskId,true).join(" ");
  assert.match(lines,/署名停止决定/);assert.match(lines,/Agent 使用/);assert.match(lines,/尚未登记验收/);
  assert.doesNotMatch(lines,/人类使用记录/);
  assert.doesNotMatch(currentChainSummary(loop,[dispatch],[submission],[decision],[task],dispatch.taskId,false).join(" "),/已按署名停止决定/);
  assert.doesNotMatch(currentChainSummary(loop,[],[],[],[],dispatch.taskId).join(" "),/尚未登记验收|Agent 使用/);
});

test("task context and decision reads use scoped routes instead of scanning the first loop page", async () => {
  const paths:string[]=[];
  const fetch=mock.method(globalThis,"fetch",async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),"http://localhost");paths.push(url.pathname+url.search);
    return response(url.pathname.endsWith("/context") ? {items:[{loopId,sourceEventIds:[],dispatchIds:[],parentDispatchIds:[]}],nextCursor:null} : {id:loopId,reason:"signed decision"});
  });
  try {
    const client=orchestrationClient("private",projectId);
    assert.equal((await client.taskContext("task")).items[0]?.loopId,loopId);
    assert.equal((await client.decision("decision")).reason,"signed decision");
    assert.deepEqual(paths,[`/api/projects/${projectId}/orchestration/tasks/task/context?limit=50`,
      `/api/projects/${projectId}/orchestration/decisions/decision`]);
  } finally {fetch.mock.restore();}
});

test("loop labels read exact Goal and Stage rather than guessing from UUIDs", async () => {
  const paths:string[]=[];
  const fetch=mock.method(globalThis,"fetch",async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),"http://localhost");paths.push(url.pathname);
    return response(url.pathname.includes("/goals/") ? {id:loopId,outcome:"Readable Goal"} : {id:loopId,deliverable:"Readable Stage"});
  });
  try {
    const client=orchestrationClient("private",projectId);
    assert.equal((await client.goal(loopId)).outcome,"Readable Goal");
    assert.equal((await client.stage(loopId)).deliverable,"Readable Stage");
    assert.deepEqual(paths,[`/api/projects/${projectId}/goals/${loopId}`,`/api/projects/${projectId}/stages/${loopId}`]);
  } finally {fetch.mock.restore();}
});
