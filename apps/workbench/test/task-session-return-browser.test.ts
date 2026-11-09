// Opt-in built-app regression for the Session -> Task -> Session route.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "96000001-0000-4000-8000-000000000001";
const taskId = "96000002-0000-4000-8000-000000000002";
const otherTaskId = "96000004-0000-4000-8000-000000000004";
const sessionId = "96000003-0000-4000-8000-000000000003";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-11-03T00:00:00.000Z";
const metadata = {generatedAt:stamp,sourceObservedAt:stamp,partial:false,limitations:[]};
const task = {projectId,id:taskId,version:1,currentRevisionId:taskId,title:"颜色与图标",content:"任务正文",
  contentDocumentId:taskId,contentRevisionId:taskId,kind:"implementation",acceptance:"返回原 Session",owner:"role",state:"in_progress"};
const observedTask={id:taskId,title:task.title,state:task.state,revisionId:taskId,owner:task.owner,
  relation:"accepted",source:{kind:"assignment",id:taskId,revision:null,evidence:"fixture",href:""}};
const timing={createdAt:stamp,publication:{at:null,source:"unknown"},
  current:{stage:"awaiting_publication",startedAt:stamp,endedAt:null,elapsedMs:null,source:null,
    waitingFor:{kind:"publisher",id:"发布维护者"}},rounds:[],latestEffectiveProgress:null,executionActivity:null,observedAt:stamp};
const session = {key:sessionKey,target:{kind:"owned",sessionId},aliases:[],title:"临时开发 Session",profile:null,
  kind:"owned",roles:[],membership:"current",membershipReason:"fixture",runtimeState:"ready",busy:false,
  currentTask:null,latestBusinessRun:null,lastProgressAt:null,
  capabilities:{observe:{available:false,reason:"fixture"},send:{available:false,reason:"fixture",mode:null},
    open:{available:false,reason:"fixture",ref:null},interrupt:{available:false,reason:"fixture"},close:{available:false,reason:"fixture"}},
  source:{kind:"session",id:sessionId,revision:null,evidence:"project-record",href:""},metadata};
const resources=Object.fromEntries(["configuredModel","actualModel","inputTokens","outputTokens","cost","processMemory"]
  .map(key => [key,{value:null,unit:"",source:null,scope:"session",observedAt:null,interval:null,unavailableReason:"fixture"}]));

test("Task tabs and refresh retain the verified Session return; ordinary and wrong-actor entries do not", {
  skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    const file = join(dist,/^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    if (!file.startsWith(dist+"/")) {res.writeHead(404);res.end();return;}
    try {const body=await readFile(file);res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({headless:true,...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? {executablePath:process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1213,height:831}});
  let leaderTaskMatches=true;
  const leaderReads:string[]=[];
  const errors:string[]=[];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.route("**/api/**",async route => {
    const url = new URL(route.request().url());
    const root = `/api/projects/${projectId}`;
    let status=200, value:unknown={items:[],nextCursor:null,metadata};
    if (url.pathname === "/api/session") value={principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]},capabilities:{}};
    else if (url.pathname === root) value={id:projectId,title:"夹具项目",createdAt:stamp};
    else if (url.pathname === `${root}/tasks/${taskId}`) value={task,revision:{...task,taskId,id:taskId,actorId:"reader",reason:"fixture",createdAt:stamp},
      basis:null,links:[],impacts:[],decisions:[],proposal:null,judgements:[],deliveries:[],observations:[],closures:[]};
    else if (url.pathname === `${root}/session-work`) value={items:[session],nextCursor:null,observationCursor:"0",metadata,
      totals:{current:1,historical:0,unclassified:0},attention:{unansweredQuestions:0,pendingMessages:0,pendingAcceptance:null,unclassifiedSessions:0}};
    else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value={session,observationCursor:"0",currentWork:observedTask,
      assignments:[],roleTasks:[],queue:[],results:[],questions:[],activity:[],resources,metadata};
    else if (url.pathname === `${root}/references/tasks/${taskId}`) value=[];
    else if (url.pathname === `${root}/work-management/tasks/${taskId}`) {
      leaderReads.push(url.pathname);
      value={kind:"task",taskId:leaderTaskMatches?taskId:otherTaskId,version:1,currentRevisionId:taskId,
        workChangeSequence:1,title:task.title,taskKind:"implementation",taskState:"in_progress",phase:"running",
        nextAction:"等待维护者",responsible:{kind:"session",id:sessionId,label:"Session"},assignment:null,latestRun:null,
        delivery:null,pendingImpactCount:0,queueHold:null,goal:null,stage:null,plan:null,dependencies:[],dependencyVersion:0,
        review:null,dates:{createdAt:stamp,businessChangedAt:stamp,startedAt:stamp,completedAt:null,observedAt:stamp},
        timing,actionKey:`task:${taskId}:v1:running:1`};
    }
    await route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  });
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const returnRoute=`/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=queue&filter=all`;
  const taskRoute=`/p/${projectId}/tasks/${taskId}`;
  await page.goto(`${base}${taskRoute}?${new URLSearchParams({return:returnRoute,actor:"reader",returnTitle:"临时开发 Session"})}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  const back=page.getByRole("link",{name:"← 返回【临时开发 Session】"});
  await back.waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Task return missing: url=${page.url()}, body=${(await page.locator("body").innerText()).slice(0,1100)}, errors=${errors.join(" | ")}`);
  });
  await page.getByRole("tab",{name:"运行与关联"}).click({timeout:5000}).catch(async () => {
    assert.fail(`Task tab missing: url=${page.url()}, body=${(await page.locator("body").innerText()).slice(0,1100)}, errors=${errors.join(" | ")}`);
  });
  const query=new URLSearchParams((await page.evaluate(() => (location.pathname + location.search))).split("?")[1]);
  assert.equal(query.get("return"),returnRoute);
  assert.equal(query.get("actor"),"reader");
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await back.waitFor();
  assert.equal(await page.getByRole("tab",{name:"运行与关联"}).getAttribute("aria-selected"),"true");
  await back.click();
  assert.equal(await page.evaluate(() => (location.pathname + location.search)),returnRoute);
  await page.getByRole("heading",{name:"临时开发 Session"}).waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Session view missing after return: body=${(await page.locator("body").innerText()).slice(0,900)}, errors=${errors.join(" | ")}`);
  });
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click(); // current task and timing live in the right column
  leaderTaskMatches=false;
  await page.getByRole("button",{name:"重新读取",exact:true}).click();
  await page.locator(".session-current-task-timing").getByText(/阶段时间暂不可读/).waitFor();
  assert.doesNotMatch(await page.locator(".session-current-task-timing").innerText(),/发布维护者/);
  leaderTaskMatches=true;
  await page.getByRole("button",{name:"重新读取",exact:true}).click();
  await page.locator(".session-current-task-timing").getByText(/等待 发布维护者 · 发布维护者/).waitFor({timeout:5000}).catch(async()=>{
    assert.fail(`exact Task timing missing: ${await page.locator(".session-current-task-timing").innerText()} reads=${leaderReads.length} errors=${errors.join(" | ")}`);
  });
  assert.ok(leaderReads.length>=2 && leaderReads.every(path=>path.endsWith(taskId)));
  await page.goto(`${base}${taskRoute}?fresh=1`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.getByRole("tab",{name:"运行与关联"}).click();
  assert.equal(await page.evaluate(() => (location.pathname + location.search)),`${taskRoute}?tab=runtime`);
  await page.evaluate(({taskRoute,returnRoute}) => {location.hash=`${taskRoute}?${new URLSearchParams({return:returnRoute,actor:"other",returnTitle:"冒名 Session"})}`;},
    {taskRoute,returnRoute});
  await page.getByRole("tab",{name:"运行与关联"}).click();
  assert.equal(await page.evaluate(() => (location.pathname + location.search)),`${taskRoute}?tab=runtime`);
});
