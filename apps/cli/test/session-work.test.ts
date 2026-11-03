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
  assert.throws(() => sessionWorkPath(["leader", "notices"], new Map([["task", "other"]])));
  assert.throws(() => sessionWorkPath(["leader", "notices"], new Map([["documents", true]])));
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
  const value=sessionStatus(snapshot,detail,id) as {native:{freshness:string;lastEventAt:string};message:{state:string;processing:{state:string}}};
  assert.deepEqual([value.native.freshness,value.native.lastEventAt,value.message.state,value.message.processing.state],
    ["live","2026-11-03T00:54:15Z","processing","running"]);
  assert.throws(()=>sessionStatus(snapshot,{...detail,message:{...detail.message,target:{kind:"owned",sessionId:"another"}}},id),
    /target does not match/);
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
