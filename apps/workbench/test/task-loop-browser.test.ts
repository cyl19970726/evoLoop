// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const otherTaskId = "00000000-0000-4000-8000-000000000008";
const oldId = "11111111-0000-4000-8000-000000000003";
const newId = "22222222-0000-4000-8000-000000000004";
const runId = "33333333-0000-4000-8000-000000000005";
const otherRunId = "44444444-0000-4000-8000-000000000009";
const goalId = "00000000-0000-4000-8000-000000000006";
const stageId = "00000000-0000-4000-8000-000000000007";
const createdAt = "2026-10-25T00:00:00.000Z";
const page = (items: unknown[]) => ({ items, nextCursor: null });
const long = "夹具范围说明".repeat(24);
const task = { projectId, id:taskId, version:8, currentRevisionId:taskId, title:"同一任务续跑", content:"任务正文", contentDocumentId:taskId,
  contentRevisionId:taskId, kind:"validation", acceptance:"有证据", owner:"owner", state:"in_progress" };
const context = (loopId: string, dispatchId: string) => ({ loopId, dispatchIds:[dispatchId],parentDispatchIds:[],sourceEventIds:[] });
const loop = (id: string, state: string) => ({projectId,id,version:1,goalId,stageId,bootstrapEventId:taskId,cognitiveRoleId:"owner",
  allowedBusinessRoleIds:["owner"],sourceAfter:{createdAtUtc:createdAt,eventId:null},maxRuns:6,maxConcurrent:1,dispatchCount:state === "stopped" ? 4 : 1,
  state,enrolledBy:"owner",createdAtUtc:createdAt,updatedAtUtc:createdAt});

test("built Task page selects the current Loop, preserves manual history and fits 390px", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let failWorkStatus = false, failRunList = false, failSessionList = false, exactRunReads = 0, runState = "running", workRunState = "running";
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/fail-status" && req.method === "POST") { failWorkStatus = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/run-completed" && req.method === "POST") { runState = "completed"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/status-completed" && req.method === "POST") { workRunState = "completed"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/status-ready" && req.method === "POST") { failWorkStatus = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-run-list") { failRunList = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/restore-run-list") { failRunList = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-session-list") { failSessionList = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/exact-run-reads") { res.end(String(exactRunReads)); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value: unknown = page([]), status = 200;
      if (url.pathname === "/api/session") value = {principal:{actorId:"owner",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"夹具项目",createdAt};
      else if (url.pathname === `${p}/tasks/${taskId}` || url.pathname === `${p}/tasks/${otherTaskId}`) {
        const currentTask = url.pathname.endsWith(otherTaskId) ? {...task,id:otherTaskId,currentRevisionId:otherTaskId,title:"另一项任务"} : task;
        value = {task:currentTask,revision:{...currentTask,taskId:currentTask.id,id:currentTask.id,actorId:"owner",reason:"夹具",createdAt},basis:null,
        links:[],impacts:[],decisions:[],proposal:{stageId},judgements:[],deliveries:currentTask.id === taskId ? [{
          projectId,id:"55555555-0000-4000-8000-000000000010",taskId,taskRevisionId:taskId,runId,
          technicalResult:"passed",technicalEvidence:"已核对",actorId:"owner",createdAt,
          artifactRef:"https://example.test/report",artifactRevision:"v1",contentHash:"a".repeat(64),
        }] : [],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/runtime`) value = {available:true,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/tasks/${taskId}/revisions/${taskId}`) value = {
        revision:{...task,taskId,id:taskId,actorId:"owner",reason:"固定历史夹具",createdAt},basis:null,
      };
      else if (url.pathname === `${p}/runtime/sessions`) { if (failSessionList) { status=413; value={message:"RESULT_TOO_LARGE"}; } else value=[]; }
      else if (url.pathname === `${p}/references/tasks/${taskId}` || url.pathname === `${p}/references/tasks/${otherTaskId}`) value = [];
      else if (url.pathname === `${p}/runtime/runs`) {
        if (failRunList) { status = 413; value = {message:"RESULT_TOO_LARGE"}; }
        else {
        const second = url.searchParams.get("taskId") === otherTaskId;
        value = [{projectId,id:second ? otherRunId : runId,taskId:second ? otherTaskId : taskId,taskRevisionId:second ? otherTaskId : taskId,basisSetId:taskId,sessionId:taskId,
          operationId:taskId,input:"",inputHash:"",state:second ? "running" : runState,version:1,nativeTurnId:null,interruptRequested:false,resultSummary:"list version one",actorId:"owner",createdAt,updatedAt:createdAt}];
        }
      }
      else if (url.pathname === `${p}/runtime/runs/${runId}`) { exactRunReads++; value = {projectId,id:runId,taskId,taskRevisionId:taskId,basisSetId:taskId,sessionId:taskId,
        operationId:taskId,input:"",inputHash:"",state:"completed",version:2,nativeTurnId:null,interruptRequested:false,resultSummary:"exact version two",actorId:"owner",createdAt,updatedAt:createdAt};
      }
      else if (url.pathname === `${p}/orchestration/status`) value = {state:"active",running:true,busy:false,faults:[],lastError:null};
      else if (url.pathname === `${p}/orchestration/tasks/${taskId}/context` || url.pathname === `${p}/orchestration/tasks/${otherTaskId}/context`) value = page([context(oldId,"old-dispatch"),context(newId,"new-dispatch")]);
      else if (url.pathname === `${p}/orchestration/work-status`) {
        if (failWorkStatus) { status=503; value={message:"正式派发读取失败"}; }
        else value = {items:[{taskId:url.searchParams.get("taskIds"),dispatchId:"new-dispatch",runId:url.searchParams.get("taskIds") === otherTaskId ? otherRunId : runId,
          runState:url.searchParams.get("taskIds") === otherTaskId ? "running" : workRunState}]};
      }
      else if (url.pathname.startsWith(`${p}/work-management/tasks/`)) { status=404; value={message:"Leader 投影未登记"}; }
      else if (url.pathname === `${p}/orchestration/loops/${oldId}`) value = loop(oldId,"stopped");
      else if (url.pathname === `${p}/orchestration/loops/${newId}`) value = loop(newId,"active");
      else if (url.pathname === `${p}/goals/${goalId}`) value = {id:goalId,outcome:long};
      else if (url.pathname === `${p}/stages/${stageId}`) value = {id:stageId,deliverable:long};
      else if (url.pathname.startsWith(`${p}/orchestration/loops/`)) value = page([]);
      res.writeHead(status,{"content-type":"application/json"}); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(dist+"/")) { res.writeHead(404); res.end(); return; }
    try { const body=await readFile(file); res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"}); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser = await chromium.launch({headless:true,...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? {executablePath:process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH} : {})}); t.after(() => browser.close());
  const pageBrowser = await browser.newPage({viewport:{width:1280,height:720}});
  await pageBrowser.clock.install();
  await pageBrowser.goto(`${base}/#/p/${projectId}/tasks/${taskId}?revision=${taskId}`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button",{name:"进入",exact:true}).click();
  const historicalPage = pageBrowser.locator(`[data-page-key="task:${taskId}:${taskId}::"]`);
  await historicalPage.getByRole("heading",{name:"固定历史任务修订"}).waitFor();
  await pageBrowser.evaluate(({projectId,taskId}) => { location.hash = `#/p/${projectId}/tasks/${taskId}?tab=runtime`; },{projectId,taskId});
  await pageBrowser.getByRole("tab",{name:"运行与关联"}).waitFor();
  const panel = pageBrowser.getByRole("region",{name:"自动循环观察"});
  await panel.getByText(/当前运行 33333333 关联循环 22222222/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/22222222/);
  assert.match(await panel.getByRole("button",{name:/循环 11111111/}).innerText(),/创建.*2026/);
  assert.equal((await panel.locator(".orch-loop-picker button").allInnerTexts()).every(text => text.length < 70),true);
  await fetch(`${base}/__fixture/run-completed`,{method:"POST"});
  await pageBrowser.clock.fastForward(5000);
  await panel.getByText(/当前循环未确认/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/22222222/);
  await fetch(`${base}/__fixture/status-completed`,{method:"POST"});
  await pageBrowser.clock.fastForward(5000);
  await panel.getByText(/最近正式派发关联循环 22222222/).waitFor();
  await panel.getByRole("button",{name:/循环 11111111/}).click();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/11111111/);
  await panel.getByRole("button",{name:"重新读取"}).click();
  await panel.getByText(/手动查看历史循环 11111111/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/11111111/);
  await pageBrowser.setViewportSize({width:390,height:844});
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth),true);
  await fetch(`${base}/__fixture/fail-status`,{method:"POST"});
  await panel.getByRole("button",{name:"重新读取"}).click();
  await panel.getByText(/自动循环读取未完成/).waitFor();
  assert.equal(await panel.getByText(/当前运行 33333333/).count(),0);
  await panel.getByText(/显示上次读回的循环 11111111/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/11111111/);
  await fetch(`${base}/__fixture/status-ready`,{method:"POST"});
  await pageBrowser.evaluate(({projectId,otherTaskId}) => { location.hash = `#/p/${projectId}/tasks/${otherTaskId}?tab=runtime`; },{projectId,otherTaskId});
  const nextPanel = pageBrowser.locator(`[data-page-key="task:${otherTaskId}:::"]`).getByRole("region",{name:"自动循环观察"});
  await nextPanel.getByText(/当前运行 44444444 关联循环 22222222/).waitFor();
  assert.match(await nextPanel.locator(".orch-loop-head h3").innerText(),/22222222/);
  assert.equal(await (await fetch(`${base}/__fixture/exact-run-reads`)).text(),"0", "hidden Delivery tab must not prefetch historical Runs");
  await pageBrowser.evaluate(({projectId,taskId}) => { location.hash = `#/p/${projectId}/tasks/${taskId}?tab=delivery`; },{projectId,taskId});
  const currentTaskPage = pageBrowser.locator(`[data-page-key="task:${taskId}:::"]`);
  const currentRun = currentTaskPage.locator(`#runtime-run-${taskId}-${runId}`);
  const currentOpenRun = currentTaskPage.locator(`#runtime-run-${taskId}-${runId}[open]`);
  const runTitleClearsHeader = ({taskId,runId}:{taskId:string;runId:string}) => {
    const run=document.querySelector(`[data-page-key="task:${taskId}:::"] #runtime-run-${taskId}-${runId}`);
    const title=run?.querySelector(":scope > summary");
    const header=document.querySelector(".workspace-header");
    if (!title || !header) return false;
    const titleRect=title.getBoundingClientRect(), headerRect=header.getBoundingClientRect();
    return titleRect.top>=headerRect.bottom+8 && titleRect.bottom<window.innerHeight;
  };
  const exactRunLink = currentTaskPage.getByRole("link",{name:"核对这次 Run →"});
  await exactRunLink.waitFor();
  assert.equal(await exactRunLink.getAttribute("href"),`#/p/${projectId}/tasks/${taskId}?tab=runtime&run=${runId}`);
  assert.equal(await currentTaskPage.getByRole("link",{name:"查看对应 Session →"}).getAttribute("href"),
    `#/p/${projectId}/runtime?session=${encodeURIComponent(`owned:${taskId}`)}`);
  await exactRunLink.focus();
  await exactRunLink.press("Enter");
  await currentOpenRun.waitFor();
  assert.equal(await historicalPage.evaluate(el => el.getClientRects().length),0,"historical Task page stays mounted but hidden");
  await currentRun.getByText(/exact version two/).waitFor();
  await pageBrowser.waitForFunction(runTitleClearsHeader,{taskId,runId});
  await pageBrowser.evaluate(() => window.scrollTo(0,0));
  await pageBrowser.waitForTimeout(5500);
  assert.equal(await pageBrowser.evaluate(() => window.scrollY),0,"polling must not reclaim manual scrolling");
  assert.equal(await currentRun.getByText(/list version one/).count(),0);
  await pageBrowser.setViewportSize({width:1280,height:720});
  await pageBrowser.evaluate(({projectId,taskId}) => { location.hash = `#/p/${projectId}/tasks/${taskId}?tab=delivery`; },{projectId,taskId});
  await fetch(`${base}/__fixture/fail-run-list`);
  await fetch(`${base}/__fixture/fail-session-list`);
  await currentTaskPage.getByRole("link",{name:"核对这次 Run →"}).click();
  await currentOpenRun.waitFor();
  await pageBrowser.waitForFunction(runTitleClearsHeader,{taskId,runId});
  await currentTaskPage.getByText(/运行列表暂不可读取/).waitFor();
  await currentTaskPage.getByText(/会话列表暂不可读取/).waitFor();
});
