// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "20000001-0000-4000-8000-000000000001";
const roleId = "20000002-0000-4000-8000-000000000002";
const unknownOwner = "20000003-0000-4000-8000-000000000003";
const taskId = "20000004-0000-4000-8000-000000000004";
const otherTaskId = "20000005-0000-4000-8000-000000000005";
const sessionId = "20000006-0000-4000-8000-000000000006";
const mismatchedSessionId = "20000007-0000-4000-8000-000000000007";
const queueId = "20000008-0000-4000-8000-000000000008";
const stamp = "2026-10-25T00:00:00.000Z";
const page = {items:[],nextCursor:null};

test("Task owner resolves one real Role and only verified bound Session links at 390px", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(playwrightModule!).href)).default;
  let roleFailure = false, roleReads = 0, roleListReads = 0;
  let holdNextRole = false, heldRoles = 0, releaseHeldRole: (()=>void)|null = null;
  let includeForeignSession = false;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/fail-role") { roleFailure = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reads") { res.end(JSON.stringify({roleReads,roleListReads})); return; }
    if (url.pathname === "/__fixture/hold-role") { holdNextRole = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/held-role-count") { res.end(String(heldRoles)); return; }
    if (url.pathname === "/__fixture/release-held-role") { releaseHeldRole?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/foreign-session") { includeForeignSession = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value:unknown = page, status = 200;
      if (url.pathname === "/api/session") value = {principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"夹具项目",createdAt:stamp};
      else if (url.pathname === `${p}/tasks/${taskId}` || url.pathname === `${p}/tasks/${otherTaskId}`) {
        const id = url.pathname.endsWith(otherTaskId) ? otherTaskId : taskId;
        const owner = id === taskId ? roleId : unknownOwner;
        const task = {projectId,id,version:2,currentRevisionId:id,title:id === taskId ? "负责人可读" : "未知负责人",content:"正文",contentDocumentId:id,
          contentRevisionId:id,kind:"implementation",acceptance:"已核对",owner,state:"in_progress",createdAt:stamp};
        value = {task,revision:{...task,id,taskId:id,actorId:"reader",reason:"夹具",createdAt:stamp},basis:null,links:[],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/roles`) { roleListReads++; value = page; }
      else if (url.pathname === `${p}/roles/${roleId}`) {
        roleReads++;
        if (holdNextRole) { holdNextRole = false; heldRoles++; await new Promise<void>(resolve=>{releaseHeldRole=resolve;}); }
        if (roleFailure) { status=503; value={message:"职责暂不可读"}; }
        else value={projectId,id:roleId,version:2,currentRevisionId:roleId,state:"active",proposal:{title:"开发流程职责"},proposedBy:"reader",createdAtUtc:stamp,trialStartedAtUtc:stamp,reviewAtUtc:stamp,mergeTargetRoleId:null};
      }
      else if (url.pathname === `${p}/roles/${unknownOwner}`) { roleReads++; status=404; value={message:"Role not found"}; }
      else if (url.pathname === `${p}/roles/${roleId}/bindings`) value = [
        {projectId,id:sessionId,roleId,sessionId,roleRevisionId:roleId,actorId:"reader",note:"已绑定",createdAtUtc:stamp},
        {projectId,id:mismatchedSessionId,roleId,sessionId:mismatchedSessionId,roleRevisionId:roleId,actorId:"reader",note:"旧关联",createdAtUtc:stamp},
      ];
      else if (url.pathname === `${p}/runtime/sessions`) value = [
        {projectId,id:sessionId,roleId,state:"ready",authorizationScope:"固定开发任务",cwd:"/tmp/session-a",sandbox:"workspace-write",nativeThreadId:"native-a"},
        {projectId,id:mismatchedSessionId,roleId:unknownOwner,state:"ready",authorizationScope:"其他任务",cwd:"/tmp/session-b",sandbox:"workspace-write",nativeThreadId:"native-b"},
        ...(includeForeignSession ? [{projectId:"20000099-0000-4000-8000-000000000099",id:"20000009-0000-4000-8000-000000000009",roleId,state:"ready"}] : []),
      ];
      else if (url.pathname === `${p}/runtime/runs`) value = [];
      else if (url.pathname === `${p}/runtime`) value = {available:true,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/resident-queues`) value = [{projectId,id:queueId,version:2,adoptedVersion:2,maxRuns:6,reason:"先验收当前任务",actorId:"reader",entries:[
        {projectId,queueId,id:taskId,taskId,taskRevisionId:taskId,sourceInputJson:"{}",sessionId,roleId,position:0,dependsOn:[],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"claimed",holdCode:null,holdReason:null,claimId:taskId,version:2},
        {projectId,queueId,id:otherTaskId,taskId:otherTaskId,taskRevisionId:otherTaskId,sourceInputJson:"{}",sessionId:mismatchedSessionId,roleId:unknownOwner,position:1,dependsOn:[],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"queued",holdCode:null,holdReason:null,claimId:null,version:1},
      ]}];
      else if (url.pathname === `${p}/resident-queues/${queueId}`) value = {projectId,id:queueId,version:2,adoptedVersion:2,maxRuns:6,reason:"先验收当前任务",actorId:"reader",entries:[
        {projectId,queueId,id:taskId,taskId,taskRevisionId:taskId,sourceInputJson:"{}",sessionId,roleId,position:0,dependsOn:[],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"claimed",holdCode:null,holdReason:null,claimId:taskId,version:2},
      ]};
      else if (url.pathname === `${p}/resident-queues/${queueId}/attempts`) value = [{entryId:taskId,claimId:taskId,attempts:[]}];
      else if (url.pathname === `${p}/orchestration/status`) value = {state:"active",running:false,busy:false,faults:[],lastError:null};
      else if (url.pathname === `${p}/orchestration/loops`) value = {items:Array.from({length:9},(_,index)=>({projectId,id:`20000010-0000-4000-8000-${String(index+10).padStart(12,"0")}`,goalId:taskId,stageId:null,cognitiveRoleId:roleId,allowedBusinessRoleIds:[roleId],state:"stopped",createdAtUtc:stamp,
        sourceAfter:{createdAtUtc:stamp,eventId:null},enrolledBy:"reader",bootstrapEventId:taskId,maxRuns:6,maxConcurrent:1,dispatchCount:1})),nextCursor:null};
      else if (url.pathname.startsWith(`${p}/references/tasks/`)) value = [];
      res.writeHead(status,{"content-type":"application/json"}); res.end(JSON.stringify(value)); return;
    }
    const file=join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    try {const body=await readFile(file);res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const pageBrowser=await browser.newPage({viewport:{width:390,height:844}});
  const pageErrors:string[]=[]; pageBrowser.on("pageerror",error=>pageErrors.push(error.stack ?? error.message));
  await pageBrowser.goto(`${base}/#/p/${projectId}/tasks/${taskId}`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button",{name:"进入",exact:true}).click();
  const owner=pageBrowser.locator(`[data-page-key="task:${taskId}::"] .task-owner-meta`);
  await owner.getByRole("link",{name:"开发流程职责"}).waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Role label missing: ${await pageBrowser.locator("body").innerText()} ${pageErrors.join(" | ")}`);
  });
  await owner.getByRole("link",{name:/已登记 Session 20000006（就绪）/}).waitFor();
  assert.match(await owner.innerText(),/职责绑定不表示此任务正在该会话运行/);
  assert.match(await owner.innerText(),/部分绑定记录未能核对/);
  assert.equal(await owner.getByRole("link",{name:/20000007/}).count(),0);
  assert.equal(await owner.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  assert.equal(await pageBrowser.locator(".task-page-header").evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  if (process.env.EVOLOOP_TASK_OWNER_SCREENSHOT)
    await pageBrowser.locator(".task-page-header").screenshot({path:process.env.EVOLOOP_TASK_OWNER_SCREENSHOT});
  assert.equal(await (await fetch(`${base}/__fixture/reads`)).json().then(value=>value.roleListReads),0);
  await fetch(`${base}/__fixture/foreign-session`);
  await owner.getByRole("link",{name:/已登记 Session 20000006/}).click();
  const focus=pageBrowser.getByRole("region",{name:"目标 Session"});
  await focus.getByText(/开发流程职责 · 就绪 · Session 20000006/).waitFor({timeout:5000}).catch(async()=>{
    assert.fail(`target session missing: ${await pageBrowser.locator("body").innerText()} ${pageErrors.join(" | ")}`);
  });
  await focus.locator(`#runtime-session-${sessionId}[open]`).waitFor();
  await focus.getByText(`稳定会话 ID${sessionId}`).waitFor();
  await focus.getByText(/队列 20000008/).waitFor();
  await focus.getByText(/第 1 项 · 已领取／占用/).waitFor();
  await pageBrowser.getByRole("group",{name:"选择循环"}).getByRole("button").nth(8).waitFor();
  const queueBox=await focus.locator(".resident-queues").boundingBox();
  assert.ok(queueBox && queueBox.y >= 0 && queueBox.y < 844,`target queue outside first viewport: ${JSON.stringify(queueBox)}`);
  assert.equal(await focus.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  if (process.env.EVOLOOP_SESSION_FOCUS_SCREENSHOT)
    await pageBrowser.screenshot({path:process.env.EVOLOOP_SESSION_FOCUS_SCREENSHOT,fullPage:false});
  await pageBrowser.setViewportSize({width:1280,height:900});
  const desktopQueue=await focus.locator(".resident-queues").boundingBox();
  assert.ok(desktopQueue && desktopQueue.y >= 0 && desktopQueue.y < 900,`target queue outside desktop first viewport: ${JSON.stringify(desktopQueue)}`);
  if (process.env.EVOLOOP_SESSION_FOCUS_DESKTOP_SCREENSHOT)
    await pageBrowser.screenshot({path:process.env.EVOLOOP_SESSION_FOCUS_DESKTOP_SCREENSHOT,fullPage:false});
  await pageBrowser.evaluate(({projectId,mismatchedSessionId})=>{location.hash=`#/p/${projectId}/runtime?session=${mismatchedSessionId}`;},{projectId,mismatchedSessionId});
  await focus.getByText(/Session 20000007/).first().waitFor();
  assert.equal(await focus.getByText(/开发流程职责/).count(),0);
  await fetch(`${base}/__fixture/hold-role`);
  await pageBrowser.evaluate(({projectId,sessionId})=>{location.hash=`#/p/${projectId}/runtime?session=${sessionId}`;},{projectId,sessionId});
  for(let attempt=0;attempt<20 && await (await fetch(`${base}/__fixture/held-role-count`)).text()!=="1";attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-role-count`)).text(),"1");
  await pageBrowser.evaluate(({projectId,mismatchedSessionId})=>{location.hash=`#/p/${projectId}/runtime?session=${mismatchedSessionId}`;},{projectId,mismatchedSessionId});
  await focus.getByText(/Session 20000007/).first().waitFor();
  await fetch(`${base}/__fixture/release-held-role`);
  await pageBrowser.waitForTimeout(100);
  assert.equal(await focus.getByText(/开发流程职责/).count(),0);
  await pageBrowser.evaluate(({projectId})=>{location.hash=`#/p/${projectId}/runtime?session=invalid`;},{projectId});
  await focus.getByText(/Session ID 无效/).waitFor();
  await pageBrowser.evaluate(({projectId})=>{location.hash=`#/p/${projectId}/runtime?session=20000009-0000-4000-8000-000000000009`;},{projectId});
  await focus.getByText(/当前项目未读到目标 Session/).waitFor();
  assert.equal(await focus.getByText(/开发流程职责/).count(),0);
  await pageBrowser.evaluate(({projectId,taskId})=>{location.hash=`#/p/${projectId}/tasks/${taskId}`;},{projectId,taskId});
  await fetch(`${base}/__fixture/fail-role`);
  await pageBrowser.getByRole("button",{name:"重新读取当前任务"}).click();
  await owner.getByText(/职责暂不可核对：职责暂不可读/).waitFor();
  assert.equal(await owner.getByRole("link",{name:"开发流程职责"}).count(),0);
  await pageBrowser.evaluate(({projectId,otherTaskId})=>{location.hash=`#/p/${projectId}/tasks/${otherTaskId}`;},{projectId,otherTaskId});
  const unknown=pageBrowser.locator(`[data-page-key="task:${otherTaskId}::"] .task-owner-meta`);
  await unknown.getByText(/未找到已登记职责/).waitFor();
  assert.match(await unknown.innerText(),new RegExp(unknownOwner));
});
