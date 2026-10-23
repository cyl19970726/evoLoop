import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ApiError } from "../src/api.ts";
import { mergePage, orchestrationClient } from "../src/orchestration/client.ts";
import { deliveryMeaning, dispatchStateLabel, inboxStateLabel, sealReasonLabel, submissionStateLabel } from "../src/orchestration/presentation.ts";
import { inTaskContext, nextAction, readableOutcome, relatedDispatches } from "../src/orchestration/summary.ts";
import { taskSectionFromHash, taskSectionHref } from "../src/orchestration/navigation.ts";
import type { OrchestrationDispatch, OrchestrationInbox, OrchestrationSubmission } from "@evoloop/contracts/orchestration";
import type { TaskDetail } from "@evoloop/contracts";

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

test("task chain relation includes same source and direct parent, but excludes unrelated loop tasks", () => {
  const direct={id:"a",taskId:"task",sourceEventId:"source",parentDispatchId:null} as OrchestrationDispatch;
  const sameSource={id:"b",taskId:"other",sourceEventId:"source",parentDispatchId:null} as OrchestrationDispatch;
  const child={id:"c",taskId:"third",sourceEventId:"later",parentDispatchId:"a"} as OrchestrationDispatch;
  const unrelated={id:"d",taskId:"unrelated",sourceEventId:"unrelated",parentDispatchId:null} as OrchestrationDispatch;
  assert.deepEqual(relatedDispatches([direct,sameSource,child,unrelated],"task").map(item=>item.id),["a","b","c"]);
  const context={loopId,sourceEventIds:["source"],dispatchIds:["a"],parentDispatchIds:[]};
  assert.equal(inTaskContext(direct,context),true);
  assert.equal(inTaskContext(sameSource,context),true);
  assert.equal(inTaskContext(unrelated,context),false);
  const feedback={...unrelated,id:"next-cognition",sourceEventId:"outcome-event",parentDispatchId:null};
  assert.equal(inTaskContext(feedback,{...context,sourceEventIds:["source","outcome-event"]}),true);
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
