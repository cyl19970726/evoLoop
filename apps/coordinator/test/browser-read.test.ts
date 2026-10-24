import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Task } from "@evoloop/contracts";
import type { DynamicToolCall } from "@evoloop/adapter-codex-app-server";
import { allowBrowserRequest, allowBrowserResponse, BrowserReadBridge, BROWSER_ORIGIN, isApprovedPageUrl, matchesBrowserRun, readerTokenForScope, sanitizeBrowserText, validPngBase64, type BrowserReadScope } from "../src/runtime/browser-read.js";

const projectId="11111111-1111-4111-8111-111111111111";
const taskId="22222222-2222-4222-8222-222222222222";
const sessionId="33333333-3333-4333-8333-333333333333";
const runId="44444444-4444-4444-8444-444444444444";
const scope:BrowserReadScope={enabled:true,projectId,taskId,contentRevisionId:"99999999-9999-4999-8999-999999999999",
  sessionId,runId,runOperationId:"66666666-6666-4666-8666-666666666666",roleId:"temporary-experience",
  authorizationScope:"temporary-experience",cwd:"/tmp/evoloop-fixture",authorizationKind:"dynamic",sandbox:"workspace-write",readerActorId:"reader-only",
  origin:BROWSER_ORIGIN,expiresAtUtc:"2030-01-01T00:00:00.000Z",entryRouteKey:"task",
  routes:[{key:"task",hash:`#/p/${projectId}/tasks/${taskId}`,
    apiPaths:[`/api/projects/${projectId}/tasks/${taskId}`]}]};
const spec:RuntimeSessionSpec={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
  cwd:scope.cwd,sandbox:scope.sandbox,approvalPolicy:"on-request"};
const binding:RuntimeBinding={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
  cwd:scope.cwd,nativeThreadId:"owned-thread",nativeSessionId:"owned-native-session",owner:"evoloop-codex-app-server"};
const call:DynamicToolCall={threadId:"owned-thread",turnId:"owned-turn",callId:"call-1",tool:"browser_navigate",arguments:{routeKey:"task"}};
const pngBase64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";

test("current authority requires the exact owned Thread, running Turn, Run, Task revision and owner",()=>{
  const session:RuntimeSessionRecord={projectId,id:sessionId,roleId:scope.roleId,cwd:scope.cwd,
    authorizationScope:scope.authorizationScope,model:null,sandbox:scope.sandbox,approvalPolicy:"on-request",
    state:"ready",version:2,nativeThreadId:binding.nativeThreadId,nativeSessionId:binding.nativeSessionId,
    operationId:"77777777-7777-4777-8777-777777777777",actorId:"worker",createdAt:"2028-01-01",updatedAt:"2028-01-01"};
  const run:RuntimeRunRecord={projectId,id:runId,taskId,taskRevisionId:"55555555-5555-4555-8555-555555555555",basisSetId:"88888888-8888-4888-8888-888888888888",
    sessionId,operationId:scope.runOperationId,input:"read",inputHash:"hash",state:"running",version:3,
    nativeTurnId:"owned-turn",interruptRequested:false,resultSummary:null,actorId:"worker",createdAt:"2028-01-01",updatedAt:"2028-01-01"};
  const task:Task={projectId,id:taskId,version:2,currentRevisionId:run.taskRevisionId,title:"Task",content:"Body",
    contentDocumentId:"",contentRevisionId:scope.contentRevisionId,kind:null,acceptance:"Read",owner:scope.roleId,state:"in_progress"};
  const revision={id:run.taskRevisionId,taskId,contentRevisionId:scope.contentRevisionId,basisSetId:run.basisSetId};
  assert.equal(matchesBrowserRun(scope,binding,call,session,run,task,revision),true);
  for (const [label,b,s,r,t,c] of [
    ["foreign Thread",{...binding,nativeThreadId:"foreign"},session,run,task,call],
    ["wrong Turn",binding,session,run,task,{...call,turnId:"foreign"}],
    ["unbound Turn",binding,session,{...run,nativeTurnId:null},task,call],
    ["terminal Run",binding,session,{...run,state:"completed"},task,call],
    ["interrupted Run",binding,session,{...run,interruptRequested:true},task,call],
    ["other Run",binding,session,{...run,id:sessionId},task,call],
    ["other operation",binding,session,{...run,operationId:sessionId},task,call],
    ["changed Task revision",binding,session,run,{...task,currentRevisionId:runId},call],
    ["other Task owner",binding,session,run,{...task,owner:"other"},call],
    ["other Task state",binding,session,run,{...task,state:"done"},call],
    ["other Session",binding,{...session,id:runId},run,task,call],
  ] as const) assert.equal(matchesBrowserRun(scope,b,c,s,r,t,revision),false,label);
  assert.equal(matchesBrowserRun(scope,binding,call,session,run,{...task,contentRevisionId:runId},revision),false);
  assert.equal(matchesBrowserRun(scope,binding,call,session,run,task,{...revision,basisSetId:runId}),false);
});

test("browser reader must be a single current same-project read-only identity",()=>{
  const reader={actorId:scope.readerActorId,projectIds:[projectId],permissions:["read"],token:"host-only-token"};
  assert.equal(readerTokenForScope(scope,[reader]),"host-only-token");
  assert.equal(readerTokenForScope(scope,[{...reader,projectIds:[runId]}]),null);
  assert.equal(readerTokenForScope(scope,[{...reader,projectIds:[projectId,runId]}]),null);
  assert.equal(readerTokenForScope(scope,[{...reader,permissions:["read","write"]}]),null);
  assert.equal(readerTokenForScope(scope,[reader,{...reader,token:"another"}]),null);
  assert.equal(readerTokenForScope(scope,[{...reader,actorId:"owner"}]),null);
});

test("snapshot text redacts the host token and common credential shapes",()=>{
  const raw="token-one Bearer abcdefghijklmnopqrstuvwxyz cookie=private-value authorization:some-secret sk-abcdefghijklmnopqrst";
  const safe=sanitizeBrowserText(raw,"token-one");
  for(const secret of ["token-one","abcdefghijklmnopqrstuvwxyz","private-value","some-secret","sk-abcdefghijklmnopqrst"])
    assert.equal(safe.includes(secret),false);
});

test("bridge is opt-in for one exact Session and rechecks Run authority for every call",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  let authorized=true,authorizations=0,opens=0,closes=0;
  const bridge=new BrowserReadBridge({scopePath,now:()=>Date.parse("2028-01-01T00:00:00Z"),
    authorize:async (_scope,_binding,value)=>{authorizations++;return authorized && value.turnId==="owned-turn"?"host-secret-token":null;},
    backend:async()=>{opens++;return {navigate:async()=>{},snapshot:async()=>"visible text",readMore:async()=>"more",
      expandDetails:async()=>"expanded",screenshot:async()=>"cG5n",close:async()=>{closes++;}};}});
  t.after(()=>bridge.close());
  assert.equal(await bridge.tools({...spec,sessionId:runId}),undefined);
  await writeFile(scopePath,JSON.stringify({...scope,roleId:"other"}));
  assert.equal(await bridge.tools(spec),undefined);
  await writeFile(scopePath,JSON.stringify(scope));
  assert.deepEqual((await bridge.tools(spec))?.map(tool=>tool.name),
    ["browser_navigate","browser_snapshot","browser_read_more","browser_expand_details","browser_screenshot"]);
  assert.equal((await bridge.call(call,{...binding,nativeThreadId:"foreign"})).success,false);
  assert.equal((await bridge.call({...call,turnId:"foreign"},binding)).success,false);
  assert.equal((await bridge.call({...call,arguments:{url:"https://evil.invalid"}},binding)).success,false);
  assert.equal((await bridge.call({...call,arguments:{routeKey:"task",script:"fetch('/')"}},binding)).success,false);
  assert.equal(authorizations,1);
  assert.equal((await bridge.call(call,binding)).success,true);
  assert.equal((await bridge.call({...call,tool:"browser_snapshot",arguments:{}},binding)).contentItems[0]?.type,"inputText");
  assert.equal(authorizations,5);
  authorized=false;
  const refused=await bridge.call({...call,tool:"browser_screenshot",arguments:{}},binding);
  assert.deepEqual(refused,{contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
  assert.equal(opens,1);assert.equal(closes,1);
  authorized=true;
  assert.equal((await bridge.call(call,binding)).success,true);
  assert.equal((await bridge.call({...call,tool:"browser_screenshot",arguments:{}},binding)).success,false);
  assert.equal(opens,2);assert.equal(closes,2);
  await chmod(scopePath,0o644);
  assert.equal(await bridge.tools(spec),undefined);
  await chmod(scopePath,0o600);
  await writeFile(scopePath,JSON.stringify({...scope,expiresAtUtc:"2020-01-01T00:00:00.000Z"}));
  assert.equal(await bridge.tools(spec),undefined);
  assert.equal((await bridge.call(call,binding)).success,false);
});

test("late authorization cannot open a browser after cancellation",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-cancel-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  let release:(token:string)=>void=()=>{};let opened=0;
  const bridge=new BrowserReadBridge({scopePath,backend:async()=>{opened++;throw new Error("must not open");},
    authorize:()=>new Promise(resolve=>{release=resolve;})});
  t.after(()=>bridge.close());
  const controller=new AbortController();
  const pending=bridge.call({...call,signal:controller.signal},binding);
  await new Promise(resolve=>setTimeout(resolve,10));
  controller.abort();await bridge.close();release("host-token");
  assert.equal((await pending).success,false);assert.equal(opened,0);
});

test("authority revoked during a backend read denies the old result before return",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-revoke-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  let authorized=true,closes=0;
  const bridge=new BrowserReadBridge({scopePath,now:()=>Date.parse("2028-01-01T00:00:00Z"),
    authorize:async()=>authorized?"host-token":null,
    backend:async()=>({navigate:async()=>{},snapshot:async()=>{authorized=false;return "stale result";},
      readMore:async()=>"",expandDetails:async()=>"",screenshot:async()=>"",
      close:async()=>{closes++;}})});
  t.after(()=>bridge.close());
  assert.equal((await bridge.call(call,binding)).success,true);
  const stale=await bridge.call({...call,tool:"browser_snapshot",arguments:{}},binding);
  assert.deepEqual(stale,{contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
  assert.equal(closes,1);
});

test("image result requires bounded canonical PNG bytes",()=>{
  assert.equal(validPngBase64("cG5n"),false);
  assert.equal(validPngBase64("not-base64?"),false);
  const header=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(4),Buffer.from("IHDR"),Buffer.alloc(8)]);
  assert.equal(validPngBase64(header.toString("base64")),false);
});

test("screenshot persists an immutable private PNG and minimal provenance next to trusted scope",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-receipt-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  let image=pngBase64;
  const bridge=new BrowserReadBridge({scopePath,now:()=>Date.parse("2028-01-01T00:00:00Z"),
    authorize:async()=>"host-reader-token-sentinel",
    backend:async()=>({navigate:async()=>{},snapshot:async()=>"",readMore:async()=>"",
      expandDetails:async()=>"",screenshot:async()=>image,close:async()=>{}})});
  t.after(()=>bridge.close());
  assert.equal((await bridge.call(call,binding)).success,true);
  const shotCall={...call,callId:"shot-call",tool:"browser_screenshot",arguments:{}};
  const first=await bridge.call(shotCall,binding);
  assert.equal(first.success,true);
  assert.equal(first.contentItems[0]?.type,"inputImage");
  const receiptDir=join(dir,"receipts");
  const stem=`${runId}-${createHash("sha256").update("shot-call").digest("hex")}`;
  const pngPath=join(receiptDir,`${stem}.png`),jsonPath=join(receiptDir,`${stem}.json`);
  assert.ok(pngPath.startsWith(dir) && !pngPath.startsWith(process.cwd()));
  const bytes=await readFile(pngPath),provenance=await readFile(jsonPath,"utf8");
  const hash=createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(bytes,Buffer.from(pngBase64,"base64"));
  assert.equal((await lstat(receiptDir)).mode&0o777,0o700);
  assert.equal((await lstat(pngPath)).mode&0o777,0o600);
  assert.equal((await lstat(jsonPath)).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(provenance),{
    projectId,taskId,contentRevisionId:scope.contentRevisionId,sessionId,runId,runOperationId:scope.runOperationId,
    nativeThreadId:binding.nativeThreadId,turnId:call.turnId,callId:"shot-call",routeKey:"task",pageHash:scope.routes[0]!.hash,
    sha256:hash,bytes:bytes.length,capture:"viewport",atUtc:"2028-01-01T00:00:00.000Z"});
  const resultText=first.contentItems[1]?.type==="inputText"?first.contentItems[1].text:"";
  assert.match(resultText,/Viewport screenshot/);
  assert.ok(resultText.includes(pngPath) && resultText.includes(jsonPath) && resultText.includes(hash));
  assert.equal((resultText+provenance).includes("host-reader-token-sentinel"),false);
  assert.deepEqual((await readdir(receiptDir)).sort(),[`${stem}.json`,`${stem}.png`]);
  assert.equal((await bridge.call(shotCall,binding)).success,true);
  assert.equal(await readFile(jsonPath,"utf8"),provenance);
  const different=Buffer.from(pngBase64,"base64");different[42]^=1;image=different.toString("base64");
  assert.equal(validPngBase64(image),true);
  assert.equal((await bridge.call(shotCall,binding)).success,false);
  assert.deepEqual(await readFile(pngPath),bytes);
  await rm(jsonPath);await symlink(scopePath,jsonPath);
  assert.equal((await bridge.call(call,binding)).success,true);
  image=pngBase64;
  assert.equal((await bridge.call(shotCall,binding)).success,false);
  assert.equal((await lstat(jsonPath)).isSymbolicLink(),true);
});

test("screenshot receipt cannot turn a final authority failure into success",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-revoke-shot-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  let screenshotChecks=0;
  const bridge=new BrowserReadBridge({scopePath,now:()=>Date.parse("2028-01-01T00:00:00Z"),
    authorize:async(_scope,_binding,value)=>value.tool==="browser_screenshot" && ++screenshotChecks===3?null:"reader-token",
    backend:async()=>({navigate:async()=>{},snapshot:async()=>"",readMore:async()=>"",
      expandDetails:async()=>"",screenshot:async()=>pngBase64,close:async()=>{}})});
  t.after(()=>bridge.close());
  assert.equal((await bridge.call(call,binding)).success,true);
  assert.equal((await bridge.call({...call,callId:"revoked-shot",tool:"browser_screenshot",arguments:{}},binding)).success,false);
  assert.equal(screenshotChecks,3);
  assert.equal((await readdir(join(dir,"receipts"))).length,2);
});

test("browser request guard rejects arbitrary origins, methods, WebSocket, redirects and downloads",()=>{
  const taskPath=`/api/projects/${projectId}/tasks/${taskId}`;
  assert.equal(allowBrowserRequest(scope,BROWSER_ORIGIN+taskPath,"GET","fetch"),true);
  assert.equal(allowBrowserRequest(scope,BROWSER_ORIGIN+"/assets/index.js","GET","script"),true);
  for(const [url,method,kind] of [
    ["https://evil.invalid/","GET","document"],
    [BROWSER_ORIGIN+taskPath,"POST","fetch"],
    [BROWSER_ORIGIN+taskPath,"GET","websocket"],
    [BROWSER_ORIGIN+`/api/projects/${projectId}/commands`,"GET","fetch"],
    [BROWSER_ORIGIN+`/api/projects/${runId}/tasks/${taskId}`,"GET","fetch"],
    [BROWSER_ORIGIN+"/asset.js","GET","script"],
  ]) assert.equal(allowBrowserRequest(scope,url!,method!,kind!),false,url);
  assert.equal(allowBrowserResponse(302,0,null),false);
  assert.equal(allowBrowserResponse(200,42,"attachment; filename=secret.txt"),false);
  assert.equal(allowBrowserResponse(200,5_000_001,null),false);
  assert.equal(allowBrowserResponse(200,42,null),true);
  assert.equal(allowBrowserResponse(403,42,null),true);
  assert.equal(isApprovedPageUrl(scope,`${BROWSER_ORIGIN}/${scope.routes[0]!.hash}`,scope.routes[0]!.hash),true);
  assert.equal(isApprovedPageUrl(scope,`${BROWSER_ORIGIN}/#/p/${projectId}/runtime`,scope.routes[0]!.hash),false);
  assert.equal(isApprovedPageUrl(scope,`https://evil.invalid/${scope.routes[0]!.hash}`,scope.routes[0]!.hash),false);
});

test("exact project GET paths can include encoded Git names and cursor punctuation",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-browser-path-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourcePath=`/api/projects/${projectId}/knowledge/pages?limit=50&cursor=docs%2FREADME.md_1`;
  const namedScope:BrowserReadScope={...scope,entryRouteKey:"knowledge",
    routes:[{key:"knowledge",hash:`#/p/${projectId}/knowledge`,apiPaths:[sourcePath]}]};
  const scopePath=join(dir,"scope.json");await writeFile(scopePath,JSON.stringify(namedScope),{mode:0o600});
  const bridge=new BrowserReadBridge({scopePath,now:()=>Date.parse("2028-01-01T00:00:00Z"),
    authorize:async()=>null,backend:async()=>{throw new Error("not called");}});
  t.after(()=>bridge.close());
  assert.ok(await bridge.tools(spec));
  assert.equal(allowBrowserRequest(namedScope,BROWSER_ORIGIN+sourcePath,"GET","fetch"),true);
  assert.equal(allowBrowserRequest(namedScope,BROWSER_ORIGIN+sourcePath.replace("README","OTHER"),"GET","fetch"),false);
});
