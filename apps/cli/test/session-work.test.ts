import assert from "node:assert/strict";
import test from "node:test";
import { sessionWorkPath } from "../src/session-work.ts";
import { runCli } from "../src/application.ts";
import { sessionStatus } from "../src/session-status.ts";
const id = "00000000-0000-4000-8000-000000000001";
const key = `external:${id}`;
test("named work reads preserve opaque cursors, real Session identity and project-scoped filters", () => {
  const path = sessionWorkPath(["history", key], new Map([["cursor", "opaque+cursor/=="], ["task", id], ["importance", "all"]]));
  const u = new URL(path, "http://local");
  assert.equal(decodeURIComponent(u.pathname), `/session-work/${key}/activities`);
  assert.equal(u.searchParams.get("cursor"), "opaque+cursor/==");
  assert.equal(u.searchParams.get("taskId"), id);
  assert.equal(u.searchParams.get("importance"), "all");
});
test("work reads reject path injection, unbounded pages and missing change positions", () => {
  assert.throws(() => sessionWorkPath(["snapshot", `${key}/../other`], new Map()));
  assert.throws(() => sessionWorkPath(["list"], new Map([["limit", "51"]])));
  assert.throws(() => sessionWorkPath(["changes"], new Map()));
  assert.throws(() => sessionWorkPath(["snapshot", key], new Map([["cursor", "unrelated"]])));
  assert.match(sessionWorkPath(["changes", key], new Map([["cursor", "position"]])), /^\/session-work\/changes\?key=/);
});
test("Leader work discovery has runnable bounded Task, Document and change commands", () => {
  assert.equal(sessionWorkPath(["leader"], new Map([["limit", "20"]])),
    "/work-management/index?view=tasks&limit=20");
  assert.equal(sessionWorkPath(["leader"], new Map([["documents", true], ["closed", true]])),
    "/work-management/index?view=documents&includeClosed=true");
  assert.equal(sessionWorkPath(["leader", "changes"], new Map([["cursor", "opaque"], ["limit", "100"]])),
    "/work-management/changes?cursor=opaque&limit=100");
  assert.equal(sessionWorkPath(["leader", "changes"], new Map()), "/work-management/changes");
  assert.equal(sessionWorkPath(["leader", "notices"], new Map([["task", id], ["limit", "25"]])),
    `/work-management/notices?taskId=${id}&limit=25`);
  assert.equal(sessionWorkPath(["task", id], new Map()), `/work-management/tasks/${id}`);
  assert.equal(sessionWorkPath(["connectors"], new Map([["limit", "20"], ["cursor", id]])),
    `/message-connectors/routes?limit=20&cursor=${id}`);
  assert.equal(sessionWorkPath(["connector", id], new Map()), `/message-connectors/routes/${id}`);
  assert.equal(sessionWorkPath(["connector-operation", id], new Map()), `/message-connectors/operations/${id}`);
  assert.throws(() => sessionWorkPath(["connector", "../other"], new Map()));
  assert.throws(() => sessionWorkPath(["task", `${id}/other`], new Map()));
  assert.throws(() => sessionWorkPath(["leader", "notices"], new Map([["task", "other"]])));
  assert.throws(() => sessionWorkPath(["leader", "notices"], new Map([["documents", true]])));
});
test("attention reads retain Task and item identity with bounded filters", () => {
  assert.equal(sessionWorkPath(["attention"], new Map([["task", id], ["state", "open"], ["limit", "100"]])),
    `/task-attention/items?taskId=${id}&state=open&limit=100`);
  assert.equal(sessionWorkPath(["attention"], new Map([["phase", "awaiting_publication"],
    ["signal", "stage_overdue"], ["waiting-on-kind", "publisher"], ["waiting-on-id", "release-team"]])),
    "/task-attention/items?phase=awaiting_publication&signal=stage_overdue&waitingOnKind=publisher&waitingOnId=release-team");
  assert.equal(sessionWorkPath(["attention", "task", id], new Map()), `/tasks/${id}/attention`);
  assert.equal(sessionWorkPath(["attention", "item", id], new Map()), `/task-attention/items/${id}`);
  assert.equal(sessionWorkPath(["attention", "thresholds"], new Map([["stage", id], ["phase", "awaiting_publication"]])),
    `/task-attention/thresholds?stageId=${id}&phase=awaiting_publication`);
  assert.throws(() => sessionWorkPath(["attention", "task", `${id}/other`], new Map()));
  assert.throws(() => sessionWorkPath(["attention"], new Map([["state", "other"]])));
  assert.throws(() => sessionWorkPath(["attention"], new Map([["limit", "101"]])));
});
test("Agent help and schemas expose common message/assignment operations without authentication", async () => {
  const run = async (args: string[]) => { let out = ""; const code = await runCli(args, {}, { stdout: s => { out += s; }, stderr: () => {} }); return { code, body: JSON.parse(out) }; };
  assert.equal((await run(["help"])).body.commands.some((x: string) => x.startsWith("work list ")), true);
  assert.equal((await run(["help"])).body.commands.some((x: string) => x.startsWith("work leader ")), true);
  assert.equal((await run(["help"])).body.commands.some((x: string) => x.startsWith("work status ")), true);
  for (const type of ["session.message.reconcile", "session.message.interrupt"]) {
    const schema = await run(["command", "schema", type]); assert.equal(schema.code, 0);
    assert.ok(schema.body.required.includes("expectedProcessingVersion"));
  }
  for (const name of ["work.plan.set", "work.dependencies.set", "work.review.set"]) {
    const schema = await run(["request", "schema", name]); assert.equal(schema.code, 0);
    assert.ok(schema.body.properties.operationId);
  }
  for (const type of ["session.message.post", "session.profile.set", "task.assignment.acknowledge"]) {
    const r = await run(["command", "schema", type]); assert.equal(r.code, 0); assert.ok(r.body.required.includes("operationId"));
  }
});

test("work status keeps native connection, activity and persistent processing separate", () => {
  const snapshot={session:{key:`owned:${id}`,runtimeState:"ready",busy:true,lastProgressAt:null,aliases:[]},
    nativeObservation:{freshness:"live",status:"active",lastEventAt:"2026-11-03T00:54:15Z",
      observedAt:"2026-11-03T03:42:00Z",currentTurn:{id:"turn-1",status:"inProgress"}}};
  const detail={message:{id,target:{kind:"owned",sessionId:id},state:"processing",version:2,updatedAt:"2026-11-03T00:47:30Z"},
    processing:{id:"processing-1",messageId:id,sessionId:id,state:"running",version:2,nativeTurnId:"turn-1"}};
  const value=sessionStatus(snapshot,detail,id) as {native:{freshness:string;lastEventAt:string};
    writerControl:{state:string;source:string;freshness:string;observedAt:string};
    message:{state:string;processing:{state:string}}};
  assert.deepEqual([value.native.freshness,value.native.lastEventAt,value.message.state,value.message.processing.state],
    ["live","2026-11-03T00:54:15Z","processing","running"]);
  assert.deepEqual([value.writerControl.state,value.writerControl.source,value.writerControl.freshness,value.writerControl.observedAt],
    ["unknown","read_only_native_observation","live","2026-11-03T03:42:00Z"]);
  assert.throws(()=>sessionStatus(snapshot,{...detail,message:{...detail.message,target:{kind:"owned",sessionId:"another"}}},id),
    /target does not match/);
});

test("work status labels the latest PG Run as history and keeps a stale or unbound Turn separate", () => {
  const recentRun = { id: "run-old", taskId: id, state: "running", updatedAt: "2026-11-03T00:47:30Z" };
  const snapshot = { session: { key: `owned:${id}`, runtimeState: "ready", busy: true,
    latestBusinessRun: recentRun, lastProgressAt: recentRun.updatedAt },
    nativeObservation: { freshness: "stale", staleReason: "disconnected", status: "active",
      observedAt: "2026-11-03T03:42:00Z", lastEventAt: "2026-11-03T00:54:15Z",
      currentTurn: { id: "turn-old", status: "inProgress", source: { kind: "run", runId: "run-old", taskId: id } } } };
  const stale = sessionStatus(snapshot, undefined, undefined, { state: "ok", value: { available: true, error: null } }) as {
    session: { latestBusinessRun: { id: string; scope: string } };
    native: { freshness: string; staleReason: string; turnSource: { id: string } };
    runtime: { available: boolean; readStatus: string }; guidance: string };
  assert.deepEqual(stale.session.latestBusinessRun, { ...recentRun, scope: "latest_persisted_run" });
  assert.equal(stale.native.staleReason, "disconnected");
  assert.equal(stale.native.turnSource.id, "run-old");
  assert.deepEqual(stale.runtime, { available: true, readStatus: "confirmed", latestChildDiagnostic: null });
  assert.match(stale.guidance, /do not prove current execution/);
  const disconnected = sessionStatus(snapshot, undefined, undefined, { state: "ok", value: { available: false } }) as {
    runtime: { available: boolean; readStatus: string }; guidance: string };
  assert.equal(disconnected.runtime.available, false);
  assert.match(disconnected.guidance, /HTTP Session snapshot is readable, but native runtime reports unavailable/);
  const failedRead = sessionStatus(snapshot, undefined, undefined, { state: "failed" }) as {
    runtime: { available: null; readStatus: string }; guidance: string };
  assert.equal(failedRead.runtime.available, null);
  assert.equal(failedRead.runtime.readStatus, "failed");
  assert.match(failedRead.guidance, /availability is unknown/);
  const invalidRead = sessionStatus(snapshot, undefined, undefined, { state: "ok", value: { available: "false" } }) as {
    runtime: { available: null; readStatus: string } };
  assert.equal(invalidRead.runtime.available, null);
  assert.equal(invalidRead.runtime.readStatus, "invalid");
  const unbound = sessionStatus({ ...snapshot, session: { ...snapshot.session, latestBusinessRun: null },
    nativeObservation: { ...snapshot.nativeObservation, freshness: "live",
      currentTurn: { id: "turn-new", status: "inProgress", source: null } } }, undefined, undefined,
    { state: "ok", value: { available: true } }) as {
      session: { latestBusinessRun: null }; native: { turnSource: null }; guidance: string };
  assert.equal(unbound.session.latestBusinessRun, null);
  assert.equal(unbound.native.turnSource, null);
  assert.match(unbound.guidance, /latest Run is historical/);
});

test("work status reads runtime availability and keeps a failed status request unknown", async () => {
  const { mock } = await import("node:test");
  let statusFails = false;
  const paths: string[] = [];
  const diagnostic = { startId: id, pid: 1234, startedAtUtc: "2026-11-03T00:00:00.000Z",
    observedAtUtc: "2026-11-03T00:54:15.000Z", firstLossAtUtc: "2026-11-03T00:54:10.000Z",
    firstLossReason: "stdout_closed", stopReason: "process_exited", exitObserved: true,
    exitedAtUtc: "2026-11-03T00:54:15.000Z", exitCode: 23, exitSignal: null,
    nativeTurnOutcome: "unknown", stderr: "private fixture credential", message: "private native text" };
  const intercepted = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path.endsWith("/runtime")) return new Response(JSON.stringify(statusFails
      ? { code: "RUNTIME_STATUS_UNAVAILABLE" } : { available: false, error: "native child disconnected",
        nativeChildDiagnostics: [diagnostic, { ...diagnostic, startId: "00000000-0000-4000-8000-000000000002" }] }),
    { status: statusFails ? 503 : 200 });
    if (path.includes("/session-work/")) return new Response(JSON.stringify({ session: {
      key: `owned:${id}`, runtimeState: "ready", busy: true,
      latestBusinessRun: { id: "run-old", taskId: id, state: "running" } },
      nativeObservation: { freshness: "stale", currentTurn: { id: "turn-old", status: "inProgress" } } }),
    { status: 200 });
    return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
  });
  const env = { EVOLOOP_TOKEN: "fixture-token", EVOLOOP_PROJECT: id, EVOLOOP_API_URL: "http://127.0.0.1:4318" };
  const run = async () => { let stdout = "", stderr = "";
    const code = await runCli(["work", "status", `owned:${id}`], env,
      { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, value: JSON.parse(stdout), stderr }; };
  try {
    const down = await run();
    assert.equal(down.code, 0);
    assert.deepEqual(down.value.runtime, { available: false, readStatus: "confirmed",
      latestChildDiagnostic: { scope: "last_recorded_child_loss", startId: id, pid: 1234,
        startedAtUtc: diagnostic.startedAtUtc, observedAtUtc: diagnostic.observedAtUtc,
        firstLossAtUtc: diagnostic.firstLossAtUtc, firstLossReason: "stdout_closed",
        stopReason: "process_exited", exitObserved: true, exitedAtUtc: diagnostic.exitedAtUtc,
        exitCode: 23, exitSignal: null, nativeTurnOutcome: "unknown" } });
    assert.doesNotMatch(JSON.stringify(down.value), /private fixture credential|private native text/);
    assert.match(down.value.guidance, /native runtime reports unavailable/);
    statusFails = true;
    const unknown = await run();
    assert.equal(unknown.code, 0);
    assert.deepEqual(unknown.value.runtime, { available: null, readStatus: "failed", latestChildDiagnostic: null });
    assert.deepEqual(paths, Array.from({ length: 2 }, () => [
      `/api/projects/${id}/session-work/owned%3A${id}`, `/api/projects/${id}/runtime`,
    ]).flat());
  } finally { intercepted.mock.restore(); }
});

test('timeline, selected Item and live update paths encode independent positions and native IDs', () => {
  const timeline=new URL(sessionWorkPath(['timeline',key],new Map([
    ['source','native'],['cursor','native+/='],['messages-cursor','messages?&='],['limit','25'],
  ])),'http://local');
  assert.equal(timeline.pathname,`/session-work/${encodeURIComponent(key)}/timeline`);
  assert.deepEqual(Object.fromEntries(timeline.searchParams),{source:'native',cursor:'native+/=',messagesCursor:'messages?&=',limit:'25'});
  const item=new URL(sessionWorkPath(['item',key,'item/1 ?#'],new Map([['turn-id','turn/1 ?#']])),'http://local');
  assert.equal(item.pathname,`/session-work/${encodeURIComponent(key)}/timeline/items/item%2F1%20%3F%23`);
  assert.equal(item.searchParams.get('turnId'),'turn/1 ?#');
  const updates=new URL(sessionWorkPath(['updates',key],new Map([['after','live+/=']])),'http://local');
  assert.equal(updates.pathname,`/session-work/${encodeURIComponent(key)}/timeline/updates`);
  assert.equal(updates.searchParams.get('after'),'live+/=');
  assert.equal(updates.searchParams.get('waitMs'),'0');
  const waited=new URL(sessionWorkPath(['updates',key],new Map([['wait-ms','10000'],['after','live ?&=']])),'http://local');
  assert.equal(waited.searchParams.get('waitMs'),'10000');
  assert.equal(waited.searchParams.get('after'),'live ?&=');
});

test('timeline options reject invalid source, misplaced cursors and ambiguous item paths', () => {
  assert.throws(()=>sessionWorkPath(['timeline',key],new Map([['source','all']])));
  assert.throws(()=>sessionWorkPath(['timeline',key],new Map([['limit','51']])));
  assert.throws(()=>sessionWorkPath(['item',key,'item'],new Map()),/turn-id/);
  assert.throws(()=>sessionWorkPath(['item',key,'..'],new Map([['turn-id','turn']])));
  assert.throws(()=>sessionWorkPath(['updates',key],new Map([['cursor','native']])));
  for(const invalid of ['-1','10001','1.5','oops'])
    assert.throws(()=>sessionWorkPath(['updates',key],new Map([['wait-ms',invalid]])));
  assert.throws(()=>sessionWorkPath(['timeline',key],new Map([['wait-ms','0']])));
  assert.throws(()=>sessionWorkPath(['timeline',`${key}/other`],new Map()));
});

test('work timeline CLI passes service JSON, cursor positions and errors without local mutation',async()=>{
  const {mock}=await import('node:test');
  const requests:Array<{url:URL;method:string;authorization:string|null}>=[];
  const page={sessionKey:key,entries:[{id:'native-item',kind:'message',body:'public'}],
    nextCursor:'native-next',messagesCursor:'pg-next',partial:true,limitations:['older page available'],unsupportedKinds:['newKind']};
  const selected={id:'native-item',kind:'message',body:'full public text'};
  const live={cursor:'live-next',resetRequired:false,entries:[],turns:[],freshness:'live',limitations:[]};
  const intercepted=mock.method(globalThis,'fetch',async (url:string|URL|Request,init?:RequestInit)=>{
    const target=new URL(String(url));requests.push({url:target,method:init?.method??'',authorization:new Headers(init?.headers).get('Authorization')});
    if(target.pathname.endsWith('/timeline/updates'))return new Response(JSON.stringify(live),{status:200});
    if(target.pathname.includes('/timeline/items/'))return new Response(JSON.stringify(selected),{status:200});
    if(target.searchParams.get('source')==='messages')return new Response(JSON.stringify({code:'FORBIDDEN',reason:'exact service rejection'}),{status:403});
    return new Response(JSON.stringify(page),{status:200});
  });
  const env={EVOLOOP_TOKEN:'fixture-token',EVOLOOP_PROJECT:id,EVOLOOP_API_URL:'http://127.0.0.1:4318'};
  const run=async(args:string[])=>{let stdout='',stderr='';const code=await runCli(args,env,{stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;}});return{code,stdout,stderr};};
  try{
    const history=await run(['work','timeline',key,'--source','both','--cursor','native+/=','--messages-cursor','pg?&=','--limit','25']);
    assert.equal(history.code,0);assert.deepEqual(JSON.parse(history.stdout),page);
    const item=await run(['work','item',key,'item/1','--turn-id','turn/1']);
    assert.equal(item.code,0);assert.deepEqual(JSON.parse(item.stdout),selected);
    const updates=await run(['work','updates',key,'--after','live+/=']);
    assert.equal(updates.code,0);assert.deepEqual(JSON.parse(updates.stdout),live);
    const waited=await run(['work','updates',key,'--wait-ms','10000']);
    assert.equal(waited.code,0);assert.deepEqual(JSON.parse(waited.stdout),live);
    assert.equal(requests.length,4);
    assert.equal(requests[0]?.url.searchParams.get('messagesCursor'),'pg?&=');
    assert.equal(requests[0]?.url.searchParams.get('cursor'),'native+/=');
    assert.equal(requests[1]?.url.pathname.endsWith('/timeline/items/item%2F1'),true);
    assert.equal(requests[1]?.url.searchParams.get('turnId'),'turn/1');
    assert.equal(requests[2]?.url.searchParams.get('after'),'live+/=');
    assert.equal(requests[2]?.url.searchParams.get('waitMs'),'0');
    assert.equal(requests[3]?.url.searchParams.get('waitMs'),'10000');
    assert.ok(requests.every(request=>request.method==='GET'&&request.authorization==='Bearer fixture-token'));
    const rejected=await run(['work','timeline',key,'--source','messages']);
    assert.equal(rejected.code,1);assert.equal(rejected.stdout,'');
    assert.deepEqual(JSON.parse(rejected.stderr).error.data,{code:'FORBIDDEN',reason:'exact service rejection'});
    const invalid=await run(['work','item',key,'item/1']);
    assert.equal(invalid.code,2);assert.equal(requests.length,5);
  }finally{intercepted.mock.restore();}
});
