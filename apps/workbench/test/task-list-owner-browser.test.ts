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
const timing = {createdAt:stamp,publication:{at:null,source:"unknown"},
  current:{stage:"awaiting_publication",startedAt:stamp,endedAt:null,elapsedMs:null,source:null,
    waitingFor:{kind:"publisher",id:null}},
  rounds:[{number:1,startedAt:stamp,endedAt:null,elapsedMs:null,intervals:[{stage:"awaiting_publication",startedAt:stamp,endedAt:null,source:null,waitingFor:{kind:"publisher",id:null}}]}],
  latestEffectiveProgress:null,executionActivity:null,observedAt:stamp};
const attentionId="30000040-0000-4000-8000-000000000040";
const oldRevision="30000041-0000-4000-8000-000000000041";
const oldAttentionId="30000042-0000-4000-8000-000000000042";

test("Task list resolves only displayed Role owners and rejects stale or failed names", {skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  let currentOwner = roleA, fail = false, holdA = false, releaseA:(()=>void)|null = null, held = 0;
  let followUp:Record<string,unknown>|null={taskId,taskRevisionId:oldRevision,version:1,waitingOn:{kind:"leader",id:null},
    decision:"waiting",actionTaken:"旧修订待核",evidenceRef:null,nextCheckAt:stamp,releaseHandoff:null,publication:null,
    actorId:"reader",reason:"历史安排",updatedAt:stamp};
  const followUpHistory:Record<string,unknown>[]=[{...followUp}];
  let attentionState:"open"|"resolved"="open", attentionVersion=1;
  const item=()=>({id:attentionId,taskId,taskRevisionId:taskId,stageId:null,phase:"awaiting_publication",signal:"stage_overdue",
    waitingOn:{kind:"publisher",id:null},state:attentionState,severity:"watch",version:attentionVersion,
    firstDetectedAt:stamp,lastDetectedAt:stamp,sourceObservedAt:stamp,evidence:{stage:"awaiting_publication",elapsedMs:null},
    noticeId:null,resolvedAt:attentionState==="resolved"?stamp:null,resolutionReason:null});
  const oldItem=()=>({...item(),id:oldAttentionId,taskRevisionId:oldRevision,waitingOn:{kind:"consumer",id:"历史消费者"},
    state:"open",version:1});
  const reads:string[] = [];
  const attentionReads:string[]=[];
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/owner") {currentOwner=url.searchParams.get("id")!;res.end("ok");return;}
    if (url.pathname === "/__fixture/fail") {fail=url.searchParams.get("value")==="1";res.end("ok");return;}
    if (url.pathname === "/__fixture/hold") {holdA=true;res.end("ok");return;}
    if (url.pathname === "/__fixture/held") {res.end(String(held));return;}
    if (url.pathname === "/__fixture/release") {releaseA?.();res.end("ok");return;}
    if (url.pathname === "/__fixture/reads") {res.end(JSON.stringify(reads));return;}
    if (url.pathname === "/__fixture/reset-attention") {followUp={...followUpHistory[0]};followUpHistory.splice(1);
      attentionState="open";attentionVersion=1;res.end("ok");return;}
    if (url.pathname.startsWith("/api/")) {
      const p=`/api/projects/${projectId}`; let value:unknown={items:[],nextCursor:null}, status=200;
      if (url.pathname === "/api/session") value={principal:{actorId:"reader",projectIds:[projectId],permissions:["read","review","write"]},capabilities:{}};
      else if (url.pathname === p) value={id:projectId,title:"夹具项目",createdAt:stamp};
      else if (url.pathname === `${p}/tasks`) value=url.searchParams.has("cursor")
        ? {items:[task("30000009-0000-4000-8000-000000000009",offPageRole,"跨页任务")],nextCursor:null}
        : {items:[task(taskId,currentOwner,"澄清分工页待办"),task("30000006-0000-4000-8000-000000000006","acceptance-owner","逻辑责任者"),task("30000007-0000-4000-8000-000000000007",unknown,"未知职责")],nextCursor:"next"};
      else if (url.pathname === `${p}/tasks/${taskId}`) {
        const currentTask=task(taskId,currentOwner,"澄清分工页待办");
        value={task:currentTask,revision:{...currentTask,taskId,id:taskId,actorId:"reader",reason:"fixture",createdAt:stamp},
          basis:null,links:[],impacts:[],decisions:[],proposal:null,judgements:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/tasks/${taskId}/attention`) value={followUp,followUpHistory:[...followUpHistory].reverse(),
        items:[...(attentionState==="open"?[item()]:[]),oldItem()],itemsNextCursor:null};
      else if (url.pathname === `${p}/task-attention/items`) {attentionReads.push(url.search);value={items:[...(attentionState==="open"?[item()]:[]),oldItem()],nextCursor:null};}
      else if (url.pathname === `${p}/task-attention/items/${attentionId}`) value={item:item(),events:[]};
      else if (url.pathname === `${p}/references/tasks/${taskId}`) value=[];
      else if (url.pathname === "/api/commands" && req.method==="POST") {
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
        const command=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
        if(command.type==="task.attention.followUp.set") followUp={...followUp,...command,
          taskRevisionId:taskId,version:Number(followUp?.version??0)+1,actorId:"reader",updatedAt:stamp,publication:null};
        if(command.type==="task.attention.publication.record") followUp={...followUp,
          publication:{publishedAt:command.publishedAt,publicationRef:command.publicationRef},version:Number(followUp?.version??0)+1};
        if(command.type==="task.attention.resolve") {attentionState="resolved";attentionVersion++;}
        if(command.type==="task.attention.followUp.set"||command.type==="task.attention.publication.record") followUpHistory.push({...followUp});
        value={operationId:command.operationId,status:"applied",entityId:command.taskId??command.itemId,version:followUp?.version??attentionVersion};
      }
      else if (url.pathname === `${p}/impacts`) value=[];
      else if (url.pathname === `${p}/orchestration/work-status`) value={items:(url.searchParams.get("taskIds")??"").split(",").filter(Boolean).map(taskId=>({taskId,cognition:false,hasClosure:false,readyForAcceptance:false}))};
      else if (url.pathname === `${p}/work-management/index`) value={items:[{kind:"task",taskId,version:1,
        currentRevisionId:taskId,workChangeSequence:4,title:"澄清分工页待办",taskKind:"implementation",taskState:"todo",phase:"ready",
        nextAction:"核对当前版本后按既有 assignment/queue 规则安排执行",
        responsible:{kind:"role",id:roleA,label:`负责 Role ${roleA}`},assignment:null,latestRun:null,delivery:null,
        pendingImpactCount:0,queueHold:null,goal:null,stage:null,
        plan:{plannedStartAt:null,dueAt:null,priority:null,version:1,actorId:roleA,updatedAt:stamp},dependencies:[],
        dependencyVersion:0,
        review:{reviewId:"30000030-0000-4000-8000-000000000030",decision:"deferred",actorId:"acceptance-owner",
          reason:"Wait for the prerequisite",operationId:"30000031-0000-4000-8000-000000000031",
          reviewedChangeSequence:3,at:stamp},
        dates:{createdAt:stamp,businessChangedAt:stamp,startedAt:null,completedAt:null,observedAt:stamp},
        latestProgress:{sequence:4,entityKind:"delivery",entityId:"30000032-0000-4000-8000-000000000032",
          eventName:"交付已登记",changedAt:stamp},
        timing,actionKey:`task:${taskId}:v1:ready:4`}],nextCursor:null,total:1,counts:{ready:1,review_deferred:1},changeSequence:4,observedAt:stamp,partial:false};
      else if (url.pathname === `${p}/work-management/tasks/${taskId}`) value={kind:"task",taskId,version:1,currentRevisionId:taskId,
        workChangeSequence:4,title:"澄清分工页待办",taskKind:"implementation",taskState:"todo",phase:"ready",nextAction:"等待维护者发布",
        responsible:{kind:"role",id:roleA,label:"负责职责"},assignment:null,latestRun:null,delivery:null,pendingImpactCount:0,queueHold:null,
        goal:null,stage:null,plan:null,dependencies:[],dependencyVersion:0,review:null,
        dates:{createdAt:stamp,businessChangedAt:stamp,startedAt:null,completedAt:null,observedAt:stamp},timing,
        actionKey:`task:${taskId}:v1:ready:4`};
      else if (url.pathname.startsWith(`${p}/roles/`)) {
        const id=url.pathname.slice(`${p}/roles/`.length);reads.push(id);
        if (id===roleA && holdA) {holdA=false;held++;await new Promise<void>(resolve=>{releaseA=resolve;});}
        if (fail || id===unknown) {status=id===unknown?404:503;value={message:"职责暂不可读"};}
        else value={projectId,id,proposal:{title:id===roleA?"开发流程与规范负责人":id===offPageRole?"跨页职责":"新职责负责人"}};
      }
      res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    try {const body=await readFile(join(dist,/^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html":url.pathname));res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(/^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html":url.pathname)]??"application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true,...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? {executablePath:process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH}:{})});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const pageErrors:string[]=[];
  page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${base}/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  // 全项目统筹对账 under the table view.
  await page.getByRole("button",{name:/查看全项目统筹对账/}).click();
  const overview=page.locator("[data-leader-overview]");
  await overview.getByText(/可开始/).first().waitFor();
  assert.match(await overview.innerText(),/变更序号 4/);
  assert.match(await overview.innerText(),/统筹已暂缓/);
  await page.setViewportSize({ width: 1280, height: 900 });
  const main=page.getByRole("main");
  const row=main.getByRole("row").filter({hasText:"澄清分工页待办"});
  for (const name of ["任务","工作类型","当前进展","承接者","创建时间","最近进展"]) {
    await main.getByRole("columnheader",{name,exact:true}).waitFor();
  }
  assert.match(await row.innerText(),/实施/);
  assert.match(await row.innerText(),/2026/);
  assert.match(await row.innerText(),/交付已登记/);
  assert.match(await row.locator("[data-stage-time]").innerText(),/本阶段 未知 · 等待维护者/);
  // The selected row's facts sit in the right column. Below 1440px the shell starts it closed; once opened it stays.
  await page.getByRole("button",{name:"展开右栏"}).click();
  const panel=page.getByRole("complementary",{name:"右栏"});
  const facts=panel.locator("[data-task-facts]");
  await facts.getByText("具备发布条件，等待维护者").waitFor();
  assert.doesNotMatch(await facts.locator('[aria-label="状态与下一步"]').innerText(),/已发布|已历时 0/);
  await row.getByText(/负责职责 · 开发流程与规范负责人/).waitFor({timeout:5000}).catch(async()=>{
    assert.fail(`Task owner label missing: ${await row.innerText()} reads=${JSON.stringify(reads)}`);
  });
  await overview.getByText(/负责 开发流程与规范负责人/).waitFor();
  assert.match(await row.locator("[data-owner-cell]").innerText(),/开发流程与规范负责人/);
  assert.match(await main.getByRole("row").filter({hasText:"逻辑责任者"}).innerText(),/负责职责待核对/);
  assert.match(await main.getByRole("row").filter({hasText:"未知职责"}).innerText(),/未找到已登记职责|负责职责待核对/);
  const initialReads:string[]=await (await fetch(`${base}/__fixture/reads`)).json();
  assert.equal(initialReads.includes("acceptance-owner"),false);
  assert.equal(initialReads.includes(offPageRole),false);
  // Search lives in the inner rail; the table follows it.
  const search=page.getByRole("searchbox",{name:"搜索任务"});
  await search.fill("跨页任务");
  await main.getByRole("row").filter({hasText:"跨页任务"}).getByText("跨页职责",{exact:false}).waitFor();
  assert.equal(await facts.count(),1,"the selected task's facts survive filtering");
  await main.getByRole("button",{name:"跨页任务",exact:true}).click();
  await panel.locator('[data-task-facts="30000009-0000-4000-8000-000000000009"]').waitFor();
  await search.fill("澄清分工页待办");
  await row.getByText("开发流程与规范负责人",{exact:false}).waitFor();
  assert.match(await facts.innerText(),/不在当前筛选结果中/);
  await row.getByRole("button",{name:"澄清分工页待办",exact:true}).click();
  await facts.getByText("具备发布条件，等待维护者").waitFor();
  // 390px: the table scrolls inside its own region; the facts open as a drawer from the page.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390),"the page itself never scrolls sideways");
  await main.getByRole("button",{name:"所选任务信息"}).click();
  await page.getByRole("dialog").locator("[data-task-facts]").getByText("具备发布条件，等待维护者").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({state:"detached"});
  const reread=main.getByRole("button",{name:"重新读取列表"});
  await fetch(`${base}/__fixture/hold`);
  await reread.click();
  for (let i=0;i<30 && await (await fetch(`${base}/__fixture/held`)).text()!=="1";i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await (await fetch(`${base}/__fixture/held`)).text(),"1");
  await fetch(`${base}/__fixture/owner?id=${roleB}`);
  await reread.click();
  await row.getByText("新职责负责人",{exact:false}).waitFor();
  await fetch(`${base}/__fixture/release`);
  await page.waitForTimeout(100);
  assert.equal(await row.getByText("开发流程与规范负责人",{exact:false}).count(),0);
  await fetch(`${base}/__fixture/fail?value=1`);
  await reread.click();
  await row.getByText(/职责暂不可核对/).waitFor();
  assert.equal(await row.getByText("新职责负责人",{exact:false}).count(),0);
  await fetch(`${base}/__fixture/fail?value=0`);
  await reread.click();
  await row.getByText("新职责负责人",{exact:false}).waitFor();
  if (process.env.EVOLOOP_TASK_LIST_OWNER_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_LIST_OWNER_SCREENSHOT,fullPage:false});
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await row.locator("[data-owner-cell]").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.equal(await main.locator("[data-task-table]").evaluate(el=>el.scrollWidth>el.clientWidth),true,
    "six-column task table scrolls independently");
  const mainBox=await main.boundingBox();
  const panelBox=await panel.boundingBox();
  assert.ok(mainBox && panelBox && panelBox.x>=mainBox.x+mainBox.width-1,"desktop facts stay to the right");
  await main.locator('summary[aria-label="列设置"]').click();
  await page.getByLabel("固定成果",{exact:true}).check();
  await main.getByRole("columnheader",{name:"固定成果",exact:true}).waitFor();
  await page.setViewportSize({width:1171,height:635});
  await page.evaluate(()=>scrollTo(0,0));
  // 1171px keeps both rails (the inner one collapses below 1100px); the work panel stays beside them.
  await page.locator("[data-shell=frame][data-rail=shown]").waitFor();
  const collapsedBody=await main.boundingBox();
  const collapsedPanel=await panel.boundingBox();
  assert.ok(collapsedBody && collapsedBody.y<70 && collapsedBody.width>450,"the table keeps a usable width beside the rails");
  assert.ok(collapsedBody && collapsedPanel && collapsedPanel.x>=collapsedBody.x+collapsedBody.width-1,
    "1171px keeps the task facts beside the table");
  await page.setViewportSize({width:1920,height:1080});
  await page.locator("[data-shell=frame][data-rail=shown]").waitFor();
  const wideBody=await main.boundingBox();
  assert.ok(wideBody && wideBody.y<70 && wideBody.width>1100);
  if (process.env.EVOLOOP_TASK_LIST_OWNER_DESKTOP_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_LIST_OWNER_DESKTOP_SCREENSHOT,fullPage:false});
  await page.setViewportSize({width:1280,height:900});
  await row.getByRole("button",{name:"澄清分工页待办",exact:true}).click();
  await facts.getByText("具备发布条件，等待维护者").waitFor();
  await row.getByRole("link",{name:"1 项待关注"}).click({timeout:5000}).catch(async () => {
    assert.fail(`attention discovery missing: row=${await row.innerText()} reads=${attentionReads.join(" | ")} errors=${pageErrors.join(" | ")}`);
  });
  const detailTiming=page.locator("#task-timing");
  await detailTiming.locator(":scope > summary").click();
  await detailTiming.getByText("发布证据").waitFor({timeout:5000}).catch(async () => {
    assert.fail(`timing detail missing: route=${await page.evaluate(() => (location.pathname + location.search))} detail=${await detailTiming.innerText({timeout:1000}).catch(() => "absent")} body=${(await page.locator("body").innerText()).slice(0,1200)} errors=${pageErrors.join(" | ")}`);
  });
  assert.match(await detailTiming.innerText(),/未知；具备发布条件不代表已发布/);
  assert.match(await detailTiming.innerText(),/来源未知/);
  assert.doesNotMatch(await detailTiming.innerText(),/已发布 · 2026|历时 0/);
  const attention=page.locator(".task-attention-panel");
  await attention.getByText(/旧跟进属于历史 Task 修订/).waitFor();
  assert.match(await attention.innerText(),/2 项已关注/);
  assert.match(await attention.innerText(),/等待方 消费者 · 历史消费者/);
  assert.match(await attention.innerText(),/等待方 维护者/);
  await attention.getByLabel("已做什么").fill("核对固定产物与发布责任");
  await attention.getByLabel("跟进理由").fill("当前修订已具备交接条件");
  await attention.getByLabel("登记具备发布条件，交给维护者").check();
  await attention.getByLabel("维护者或接收方").fill("发布维护者");
  await attention.getByLabel("待发布固定产物引用").fill("artifact:fixed-42");
  await attention.getByLabel("交接说明").fill("核对固定产物后发布");
  await attention.getByLabel("具备发布条件时间").fill("2026-10-25T01:00");
  await attention.getByRole("button",{name:"保存跟进安排"}).click();
  await attention.getByText(/具备发布条件，等待维护者/).waitFor();
  assert.doesNotMatch(await attention.innerText(),/旧跟进属于历史 Task 修订/);
  const desktopMetrics=await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
    documentWidth:document.documentElement.scrollWidth}));
  assert.equal(desktopMetrics.width,1280);assert.ok(desktopMetrics.documentWidth<=1280,JSON.stringify(desktopMetrics));
  await attention.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
  if (process.env.EVOLOOP_TASK_ATTENTION_DESKTOP_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_ATTENTION_DESKTOP_SCREENSHOT,fullPage:false});
  if (process.env.EVOLOOP_TASK_ATTENTION_DESKTOP_FULL_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_ATTENTION_DESKTOP_FULL_SCREENSHOT,fullPage:true});
  console.log(`Task attention desktop viewport: ${JSON.stringify(desktopMetrics)}`);
  await page.setViewportSize({width:390,height:844});
  await attention.getByLabel("实际发布时间").fill("2026-10-25T02:00");
  await attention.getByLabel("发布证据引用").fill("release:fixed-43");
  await attention.getByLabel("记录理由").fill("维护者已发布固定版本");
  await attention.getByRole("button",{name:"记录已发布"}).click();
  await attention.getByText(/已发布且有固定证据/).waitFor();
  await attention.getByLabel("解决依据").waitFor();
  assert.equal(await attention.getByLabel("解决依据").count(),1,"historical item cannot use the current Task resolve form");
  await attention.getByLabel("解决依据").fill("发布证据已核对");
  await attention.getByRole("button",{name:"记录已解决"}).click();
  await attention.getByText("1 项已关注").waitFor();
  assert.match(await attention.innerText(),/等待方 消费者 · 历史消费者/);
  await fetch(`${base}/__fixture/reset-attention`);
  await page.goto(`${base}/p/${projectId}/work?fresh=attention-narrow`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.getByRole("main").getByRole("row").filter({hasText:"澄清分工页待办"}).getByRole("link",{name:"1 项待关注"}).click({timeout:5000}).catch(async () => {
    assert.fail(`narrow discovery missing: hash=${await page.evaluate(() => (location.pathname + location.search))} state=${attentionState} reads=${attentionReads.length} link=${JSON.stringify(await row.getByRole("link").evaluateAll(els=>els.map(el=>({html:el.outerHTML,parent:getComputedStyle(el.parentElement!).display}))))} row=${await row.innerText()} body=${(await page.locator("body").innerText()).slice(0,500)} errors=${pageErrors.join(" | ")}`);
  });
  await attention.getByText(/旧跟进属于历史 Task 修订/).waitFor();
  await attention.getByLabel("已做什么").fill("窄屏核对当前修订");
  await attention.getByLabel("跟进理由").fill("安排下一检查点");
  await attention.getByLabel("下一检查时间").fill("2026-10-26T09:30");
  await attention.getByRole("button",{name:"保存跟进安排"}).click();
  await attention.getByText(/下一检查点.*2026\/10\/26/).waitFor();
  await attention.getByLabel("解决依据").fill("当前关注已核对");
  await attention.getByRole("button",{name:"记录已解决"}).click();
  await attention.getByText("1 项已关注").waitFor();
  const metrics=await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
    documentWidth:document.documentElement.scrollWidth}));
  assert.equal(metrics.width,390);assert.ok(metrics.documentWidth<=390,JSON.stringify(metrics));
  await attention.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 65));
  if (process.env.EVOLOOP_TASK_ATTENTION_NARROW_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_ATTENTION_NARROW_SCREENSHOT,fullPage:false});
  if (process.env.EVOLOOP_TASK_ATTENTION_NARROW_FULL_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_TASK_ATTENTION_NARROW_FULL_SCREENSHOT,fullPage:true});
  console.log(`Task attention narrow viewport: ${JSON.stringify(metrics)}`);
});
