// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001";
const roleA = "30000002-0000-4000-8000-000000000002";
const roleB = "30000003-0000-4000-8000-000000000003";
const unknown = "30000004-0000-4000-8000-000000000004";
const offPageRole = "30000008-0000-4000-8000-000000000008";
const taskId = "30000005-0000-4000-8000-000000000005";
const stamp = "2026-10-25T00:00:00.000Z";
const task = (id:string, owner:string, title:string) => ({projectId,id,version:1,currentRevisionId:id,title,content:"正文",contentDocumentId:id,contentRevisionId:id,kind:"implementation",acceptance:"确认",owner,state:"todo",createdAt:stamp});

test("Task list resolves only displayed Role owners and rejects stale or failed names", {skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  let currentOwner = roleA, fail = false, holdA = false, releaseA:(()=>void)|null = null, held = 0;
  const reads:string[] = [];
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/owner") {currentOwner=url.searchParams.get("id")!;res.end("ok");return;}
    if (url.pathname === "/__fixture/fail") {fail=url.searchParams.get("value")==="1";res.end("ok");return;}
    if (url.pathname === "/__fixture/hold") {holdA=true;res.end("ok");return;}
    if (url.pathname === "/__fixture/held") {res.end(String(held));return;}
    if (url.pathname === "/__fixture/release") {releaseA?.();res.end("ok");return;}
    if (url.pathname === "/__fixture/reads") {res.end(JSON.stringify(reads));return;}
    if (url.pathname.startsWith("/api/")) {
      const p=`/api/projects/${projectId}`; let value:unknown={items:[],nextCursor:null}, status=200;
      if (url.pathname === "/api/session") value={principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value={id:projectId,title:"夹具项目",createdAt:stamp};
      else if (url.pathname === `${p}/tasks`) value=url.searchParams.has("cursor")
        ? {items:[task("30000009-0000-4000-8000-000000000009",offPageRole,"跨页任务")],nextCursor:null}
        : {items:[task(taskId,currentOwner,"澄清分工页待办"),task("30000006-0000-4000-8000-000000000006","acceptance-owner","逻辑责任者"),task("30000007-0000-4000-8000-000000000007",unknown,"未知职责")],nextCursor:"next"};
      else if (url.pathname === `${p}/impacts`) value=[];
      else if (url.pathname === `${p}/orchestration/work-status`) value={items:[]};
      else if (url.pathname === `${p}/work-management/index`) value={items:[{kind:"task",taskId,version:1,
        currentRevisionId:taskId,title:"澄清分工页待办",taskKind:"implementation",taskState:"todo",phase:"ready",
        nextAction:"核对当前版本后按既有 assignment/queue 规则安排执行",
        responsible:{kind:"role",id:roleA,label:`负责 Role ${roleA}`},assignment:null,latestRun:null,delivery:null,
        pendingImpactCount:0,queueHold:null,goal:null,stage:null,
        plan:{plannedStartAt:null,dueAt:null,priority:null,version:1,actorId:roleA,updatedAt:stamp},dependencies:[],
        dates:{createdAt:stamp,businessChangedAt:stamp,startedAt:null,completedAt:null,observedAt:stamp},
        actionKey:`task:${taskId}:v1:ready`}],nextCursor:null,total:1,counts:{ready:1},changeSequence:4,observedAt:stamp,partial:false};
      else if (url.pathname.startsWith(`${p}/roles/`)) {
        const id=url.pathname.slice(`${p}/roles/`.length);reads.push(id);
        if (id===roleA && holdA) {holdA=false;held++;await new Promise<void>(resolve=>{releaseA=resolve;});}
        if (fail || id===unknown) {status=id===unknown?404:503;value={message:"职责暂不可读"};}
        else value={projectId,id,proposal:{title:id===roleA?"开发流程与规范负责人":id===offPageRole?"跨页职责":"新职责负责人"}};
      }
      res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    try {const body=await readFile(join(dist,url.pathname==="/"?"index.html":url.pathname));res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(url.pathname==="/"?"index.html":url.pathname)]??"application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/#/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.getByRole("heading",{name:"现在需要处理什么"}).waitFor();
  assert.match(await page.locator(".leader-work").innerText(),/可开始/);
  assert.match(await page.locator(".leader-work").innerText(),/变更序号 4/);
  const row=page.getByRole("row").filter({hasText:"澄清分工页待办"});
  await row.getByRole("link",{name:"开发流程与规范负责人"}).waitFor();
  await page.locator(".leader-work").getByText(/负责 开发流程与规范负责人/).waitFor();
  assert.match(await row.locator(".task-list-owner").innerText(),/30000002/);
  assert.match(await row.getByRole("link",{name:"开发流程与规范负责人"}).getAttribute("href")??"",/\/roles$/);
  assert.match(await page.getByRole("row").filter({hasText:"逻辑责任者"}).innerText(),/acceptance-owner/);
  assert.match(await page.getByRole("row").filter({hasText:"未知职责"}).innerText(),new RegExp(unknown));
  const initialReads:string[]=await (await fetch(`${base}/__fixture/reads`)).json();
  assert.equal(initialReads.includes("acceptance-owner"),false);
  assert.equal(initialReads.includes(offPageRole),false);
  await page.getByRole("textbox",{name:"搜索全部任务"}).fill("跨页任务");
  await page.getByRole("row").filter({hasText:"跨页任务"}).getByRole("link",{name:"跨页职责"}).waitFor();
  await page.getByRole("textbox",{name:"搜索全部任务"}).fill("");
  await row.getByRole("link",{name:"开发流程与规范负责人"}).waitFor();
  assert.equal(await page.locator(".task-list-table").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await fetch(`${base}/__fixture/hold`);
  await page.getByRole("button",{name:"重新读取列表"}).click();
  for (let i=0;i<30 && await (await fetch(`${base}/__fixture/held`)).text()!=="1";i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await (await fetch(`${base}/__fixture/held`)).text(),"1");
  await fetch(`${base}/__fixture/owner?id=${roleB}`);
  await page.getByRole("button",{name:"重新读取列表"}).click();
  await row.getByRole("link",{name:"新职责负责人"}).waitFor();
  await fetch(`${base}/__fixture/release`);
  await page.waitForTimeout(100);
  assert.equal(await row.getByRole("link",{name:"开发流程与规范负责人"}).count(),0);
  await fetch(`${base}/__fixture/fail?value=1`);
  await page.getByRole("button",{name:"重新读取列表"}).click();
  await row.getByText(/职责暂不可核对/).waitFor();
  assert.equal(await row.getByRole("link",{name:"新职责负责人"}).count(),0);
  await fetch(`${base}/__fixture/fail?value=0`);
  await page.getByRole("button",{name:"重新读取列表"}).click();
  await row.getByRole("link",{name:"新职责负责人"}).waitFor();
  if (process.env.EVOLOOP_TASK_LIST_OWNER_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_LIST_OWNER_SCREENSHOT,fullPage:false});
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await row.locator(".task-list-owner").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if (process.env.EVOLOOP_TASK_LIST_OWNER_DESKTOP_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_LIST_OWNER_DESKTOP_SCREENSHOT,fullPage:false});
});
