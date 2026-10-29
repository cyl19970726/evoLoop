// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const a = "30000001-0000-4000-8000-000000000001", b = "30000002-0000-4000-8000-000000000002";
const role = "30000003-0000-4000-8000-000000000003", session = "30000004-0000-4000-8000-000000000004";
const current = "30000005-0000-4000-8000-000000000005", next = "30000006-0000-4000-8000-000000000006";
const held = "30000007-0000-4000-8000-000000000007", queueId = "30000008-0000-4000-8000-000000000008";
const outside = "30000009-0000-4000-8000-000000000009";
const stamp = "2026-10-25T00:00:00.000Z";
function item(projectId: string, id: string, position: number, state: string, holdCode: string | null = null) {
  return { projectId, queueId, id, taskId:id, taskRevisionId:id, sourceInputJson:"{}", sessionId:session, roleId:role, position,
    dependsOn:[], consumerId:"acceptance-owner", useRequired:true, releaseRule:"accepted", state, holdCode,
    holdReason:holdCode ? "等待原任务验收" : null, claimId:state === "claimed" ? id : null, version:1 };
}
function queues(projectId: string) { return [{projectId,id:queueId,version:2,adoptedVersion:2,maxRuns:6,reason:"先验收当前项",actorId:"lead",entries:[
  item(projectId,current,0,"claimed"), item(projectId,next,1,"queued"), item(projectId,held,2,"held","awaiting_acceptance"),
]}]; }
function crowdedQueues(projectId: string) { return [{projectId,id:queueId,version:2,adoptedVersion:2,maxRuns:6,reason:"先验收当前项",actorId:"lead",entries:[
  ...Array.from({length:12},(_,index)=>({ ...item(projectId,`30000020-0000-4000-8000-${String(index+20).padStart(12,"0")}`,index,"claimed"),sessionId:`30000030-0000-4000-8000-${String(index+30).padStart(12,"0")}` })),
  {...item(projectId,held,12,"held","manual_review"),sessionId:"30000040-0000-4000-8000-000000000040"},
  {...item(projectId,next,13,"queued"),sessionId:"30000041-0000-4000-8000-000000000041"},
]}]; }
function listedTask(projectId:string,id:string,title:string,owner:string,state:"todo"|"in_progress") {
  return {projectId,id,version:1,currentRevisionId:id,title,content:"正文",contentDocumentId:id,contentRevisionId:id,
    kind:"implementation",acceptance:"验收",owner,state};
}

test("overview shows scoped queue evidence, preserves stale read and refreshes on return", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let mode: "normal" | "empty" | "fail" | "crowded" | "released" = "normal";
  let taskMode: "none" | "active" | "later" | "logical" | "truncated" | "pagefail" = "none";
  let reads = 0, roleReads = 0, holdB = false, releaseB: (()=>void) | null = null;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/mode") { mode = url.searchParams.get("value") as typeof mode; res.end("ok"); return; }
    if (url.pathname === "/__fixture/task-mode") { taskMode = url.searchParams.get("value") as typeof taskMode; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reads") { res.end(String(reads)); return; }
    if (url.pathname === "/__fixture/role-reads") { res.end(String(roleReads)); return; }
    if (url.pathname === "/__fixture/hold-b") { holdB = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/release-b") { releaseB?.(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const projectId = url.pathname.includes(`/projects/${b}`) ? b : a;
      const base = `/api/projects/${projectId}`;
      let value:unknown = {items:[],nextCursor:null}, status=200;
      if (url.pathname === "/api/session") value={principal:{actorId:"reader",projectIds:[a,b],permissions:["read"]},capabilities:{}};
      else if (url.pathname === base) value={id:projectId,title:projectId === a ? "项目甲" : "项目乙",createdAt:stamp};
      else if (url.pathname === `${base}/impacts`) value=[];
      else if (url.pathname === `${base}/resident-queues`) {
        reads++;
        if (projectId === b && holdB) await new Promise<void>(resolve => { releaseB = resolve; });
        if (mode === "fail" && projectId === a) { status=503; value={message:"队列暂不可读"}; }
        else value=mode === "empty" && projectId === a ? [] : mode === "crowded" && projectId === a ? crowdedQueues(projectId)
          : mode === "released" && projectId === a ? queues(projectId).map(queue=>({...queue,entries:queue.entries.map(entry=>({...entry,state:"released",holdCode:null,holdReason:null}))})) : queues(projectId);
      }
      else if (url.pathname === `${base}/tasks`) {
        const cursor=url.searchParams.get("cursor");
        const todos=Array.from({length:50},(_,index)=>listedTask(projectId,`30000100-0000-4000-8000-${String(index).padStart(12,"0")}`,`待办 ${index}`,role,"todo"));
        if (projectId === b || taskMode === "none") value={items:[],nextCursor:null};
        else if (taskMode === "active") value={items:[listedTask(projectId,outside,"P1a 持续改进",role,"in_progress")],nextCursor:null};
        else if (taskMode === "logical") value={items:[listedTask(projectId,held,"外部人工任务","logicalactor:lead","in_progress")],nextCursor:null};
        else if (taskMode === "later") value=cursor ? {items:[listedTask(projectId,next,"后页进行中",role,"in_progress")],nextCursor:null} : {items:todos,nextCursor:"page-2"};
        else if (taskMode === "pagefail") {
          if (cursor) { status=503; value={message:"后页暂不可读"}; }
          else value={items:todos,nextCursor:"page-2"};
        } else {
          const pageIndex=cursor ? Number(cursor.replace("page-","")) : 1;
          value={items:todos.map((task,index)=>({...task,id:`300001${String(pageIndex).padStart(2,"0")}-0000-4000-8000-${String(index).padStart(12,"0")}`})),nextCursor:`page-${pageIndex+1}`};
        }
      }
      else if (url.pathname === `${base}/orchestration/work-status`) value={items:(url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId=>({taskId,cognition:false,dispatchId:null,dispatchState:null,outcome:null,runId:null,runState:null,unsettledRunState:null,
        loopState:null,goalOutcome:null,stageDeliverable:null,sourceKind:null,sourceTaskId:null,sourceTaskTitle:null,decisionKind:null,decisionReason:null,
        useRequired:null,deliveryId:null,technicalResult:null,observationResult:null,observerKind:null,hasClosure:false,readyForAcceptance:false}))};
      else if (url.pathname.startsWith(`${base}/tasks/`)) {
        const id = url.pathname.split("/").at(-1)!;
        const task={projectId,id,version:1,currentRevisionId:id,title: projectId === b ? "乙项目任务" : id===current ? "当前任务" : id===next ? "下一任务" : "待验任务",
          content:"正文",contentDocumentId:id,contentRevisionId:id,kind:"implementation",acceptance:"验收",owner:role,state:"in_progress"};
        value={task,revision:{...task,taskId:id,actorId:"reader",reason:"夹具",createdAt:stamp},basis:null,links:[],impacts:[],decisions:[]};
      }
      else if (url.pathname === `${base}/roles/${role}`) { roleReads++;value={projectId,id:role,version:1,currentRevisionId:role,state:"active",proposal:{title:"开发职责"},proposedBy:"reader",createdAtUtc:stamp,trialStartedAtUtc:stamp,reviewAtUtc:stamp,mergeTargetRoleId:null}; }
      res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    const file=join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    try { const body=await readFile(file); res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"});res.end(body); }
    catch { res.writeHead(404);res.end(); }
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await fetch(`${base}/__fixture/mode?value=fail`);
  await page.goto(`${base}/#/p/${a}/overview`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.locator("#workspace-main:focus").waitFor();
  await page.getByText(/摘要读取失败：队列暂不可读/).waitFor();
  assert.match(await page.locator("body").innerText(),/尚未读回项目摘要/);
  assert.equal(await page.getByText("已读队列范围内没有确认的领取占用。").count(),0);
  await fetch(`${base}/__fixture/mode?value=normal`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.locator(".overview-queue-details > summary").click();
  await page.getByRole("link",{name:"当前任务"}).waitFor();
  await page.getByRole("link",{name:"下一任务"}).waitFor();
  await page.getByText(/等待消费者使用与验收/).first().waitFor();
  assert.match(await page.locator("body").innerText(),/观察于/);
  assert.equal(await page.getByRole("heading",{name:"项目总览",exact:true}).locator("..").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.equal(errors.length,0,errors.join(" | "));
  await fetch(`${base}/__fixture/mode?value=fail`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.getByText(/摘要读取失败：队列暂不可读/).waitFor();
  assert.equal(await page.getByRole("link",{name:"当前任务"}).count(),1);
  assert.match(await page.locator("body").innerText(),/上次读回，不能视为当前状态/);
  await fetch(`${base}/__fixture/mode?value=empty`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.getByText("已读队列范围内没有确认的领取占用。").waitFor();
  await fetch(`${base}/__fixture/mode?value=normal`);
  const before=Number(await (await fetch(`${base}/__fixture/reads`)).text());
  await page.evaluate(projectId=>{location.hash=`#/p/${projectId}/work`;},a);
  await page.getByRole("heading",{name:"任务",exact:true}).waitFor();
  await page.locator("#workspace-main:focus").waitFor();
  await page.evaluate(projectId=>{location.hash=`#/p/${projectId}/overview`;},a);
  await page.getByRole("link",{name:"当前任务"}).waitFor({timeout:5000}).catch(async ()=>{
    assert.fail(`Return did not refresh. Reads ${await (await fetch(`${base}/__fixture/reads`)).text()} Body ${await page.locator("body").innerText()} Errors ${errors.join(" | ")}`);
  });
  assert.ok(Number(await (await fetch(`${base}/__fixture/reads`)).text())>before);
  const focused=Number(await (await fetch(`${base}/__fixture/reads`)).text());
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(async ({base,count})=>Number(await (await fetch(`${base}/__fixture/reads`)).text())>count,{base,count:focused});
  await fetch(`${base}/__fixture/mode?value=crowded`);
  await page.getByRole("button",{name:"重新读取"}).click();
  const nextSection=page.getByRole("heading",{name:"下一项"}).locator("..");
  const heldSection=page.getByRole("heading",{name:"待处理"}).locator("..");
  await nextSection.getByText(/另有 1 项下一顺位未展开/).waitFor();
  await heldSection.getByText(/另有 1 项未展开/).waitFor();
  assert.equal(await nextSection.getByText("已采纳队列中没有读到下一顺位。").count(),0);
  assert.equal(await heldSection.getByText("已读队列中没有暂停项。").count(),0);
  assert.equal(await nextSection.getByRole("link",{name:"完整队列"}).count(),1);
  await fetch(`${base}/__fixture/mode?value=normal`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.getByRole("link",{name:"当前任务"}).waitFor();
  await fetch(`${base}/__fixture/mode?value=released`);
  await fetch(`${base}/__fixture/task-mode?value=active`);
  await page.getByRole("button",{name:"重新读取"}).click();
  const activeSection=page.getByRole("heading",{name:"当前业务任务"}).locator("..");
  await activeSection.getByRole("link",{name:"P1a 持续改进"}).waitFor();
  assert.equal(await activeSection.getByRole("link",{name:"P1a 持续改进"}).getAttribute("href"),`#/p/${a}/tasks/${outside}`);
  assert.match(await activeSection.innerText(),/负责人 开发职责/);
  assert.equal(await activeSection.getByRole("link",{name:/Session/}).count(),0);
  assert.equal(await page.getByRole("heading",{name:"现在由谁承接"}).locator("..").getByText("已读队列范围内没有确认的领取占用。").count(),1);
  await fetch(`${base}/__fixture/task-mode?value=later`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await activeSection.getByRole("link",{name:"后页进行中"}).waitFor();
  assert.match(await activeSection.innerText(),/已读 2 页/);
  await fetch(`${base}/__fixture/mode?value=empty`);
  await fetch(`${base}/__fixture/task-mode?value=logical`);
  const rolesBefore=Number(await (await fetch(`${base}/__fixture/role-reads`)).text());
  await page.getByRole("button",{name:"重新读取"}).click();
  await activeSection.getByRole("link",{name:"外部人工任务"}).waitFor();
  assert.match(await activeSection.innerText(),/负责人 logicalactor:lead/);
  assert.equal(Number(await (await fetch(`${base}/__fixture/role-reads`)).text()),rolesBefore);
  await fetch(`${base}/__fixture/task-mode?value=truncated`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await activeSection.getByText(/后续任务尚未读完/).waitFor();
  assert.equal(await activeSection.getByText("已读任务中没有可确认的进行中业务任务").count(),0);
  await fetch(`${base}/__fixture/task-mode?value=later`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await activeSection.getByRole("link",{name:"后页进行中"}).waitFor();
  await fetch(`${base}/__fixture/task-mode?value=pagefail`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.getByText(/摘要读取失败：后页暂不可读/).waitFor();
  assert.equal(await activeSection.getByRole("link",{name:"后页进行中"}).count(),1);
  assert.match(await page.locator("body").innerText(),/上次读回，不能视为当前状态/);
  await fetch(`${base}/__fixture/mode?value=normal`);
  await fetch(`${base}/__fixture/task-mode?value=none`);
  await page.getByRole("button",{name:"重新读取"}).click();
  await page.getByRole("link",{name:"当前任务"}).waitFor();
  await fetch(`${base}/__fixture/hold-b`);
  await page.evaluate(projectId=>{location.hash=`#/p/${projectId}/overview`;},b);
  await page.getByText(/正在读取项目摘要/).waitFor();
  await page.evaluate(projectId=>{location.hash=`#/p/${projectId}/overview`;},a);
  await fetch(`${base}/__fixture/release-b`);
  await page.getByRole("link",{name:"当前任务"}).waitFor();
  assert.equal(await page.getByRole("link",{name:"乙项目任务"}).count(),0);
  await page.getByLabel("打开项目导航", {exact:true}).click();
  await page.getByRole("link", {name:"文档与知识",exact:true}).press("Enter");
  await page.getByRole("heading", {name:"过程文档",exact:true}).waitFor();
  await page.locator("#workspace-main:focus").waitFor();
  await page.getByLabel("打开项目导航", {exact:true}).click();
  await page.getByRole("button", {name:"关闭导航",exact:true}).click();
  await page.locator('button[aria-label="打开项目导航"]:focus').waitFor();
  assert.equal(errors.length,0,errors.join(" | "));
});
