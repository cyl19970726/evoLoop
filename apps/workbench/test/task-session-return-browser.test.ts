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
const sessionId = "96000003-0000-4000-8000-000000000003";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-11-03T00:00:00.000Z";
const metadata = {generatedAt:stamp,sourceObservedAt:stamp,partial:false,limitations:[]};
const task = {projectId,id:taskId,version:1,currentRevisionId:taskId,title:"颜色与图标",content:"任务正文",
  contentDocumentId:taskId,contentRevisionId:taskId,kind:"implementation",acceptance:"返回原 Session",owner:"role",state:"in_progress"};
const session = {key:sessionKey,target:{kind:"owned",sessionId},aliases:[],title:"临时开发 Session",profile:null,
  kind:"owned",roles:[],membership:"current",membershipReason:"fixture",runtimeState:"ready",busy:false,
  currentTask:null,latestBusinessRun:null,lastProgressAt:null,
  capabilities:{observe:{available:false,reason:"fixture"},send:{available:false,reason:"fixture",mode:null},
    open:{available:false,reason:"fixture",ref:null},interrupt:{available:false,reason:"fixture"},close:{available:false,reason:"fixture"}},
  source:{kind:"session",id:sessionId,revision:null,evidence:"project-record",href:""},metadata};

test("Task tabs and refresh retain the verified Session return; ordinary and wrong-actor entries do not", {
  skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
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
    else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value={session,observationCursor:"0",currentWork:null,
      assignments:[],roleTasks:[],queue:[],results:[],questions:[],activity:[],resources:{},metadata};
    else if (url.pathname === `${root}/references/tasks/${taskId}`) value=[];
    else if (url.pathname.startsWith(`${root}/work-management/tasks/`)) {status=404;value={message:"fixture"};}
    await route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  });
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const returnRoute=`#/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=queue&filter=all`;
  const taskRoute=`#/p/${projectId}/tasks/${taskId}`;
  await page.goto(`${base}/${taskRoute}?${new URLSearchParams({return:returnRoute,actor:"reader",returnTitle:"临时开发 Session"})}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  const back=page.getByRole("link",{name:"← 返回【临时开发 Session】"});
  await back.waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Task return missing: url=${page.url()}, body=${(await page.locator("body").innerText()).slice(0,1100)}, errors=${errors.join(" | ")}`);
  });
  await page.getByRole("tab",{name:"运行与关联"}).click({timeout:5000}).catch(async () => {
    assert.fail(`Task tab missing: url=${page.url()}, body=${(await page.locator("body").innerText()).slice(0,1100)}, errors=${errors.join(" | ")}`);
  });
  const query=new URLSearchParams((await page.evaluate(() => location.hash)).split("?")[1]);
  assert.equal(query.get("return"),returnRoute);
  assert.equal(query.get("actor"),"reader");
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await back.waitFor();
  assert.equal(await page.getByRole("tab",{name:"运行与关联"}).getAttribute("aria-selected"),"true");
  await back.click();
  assert.equal(await page.evaluate(() => location.hash),returnRoute);
  await page.goto(`${base}/?fresh=1${taskRoute}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.getByRole("tab",{name:"运行与关联"}).click();
  assert.equal(await page.evaluate(() => location.hash),`${taskRoute}?tab=runtime`);
  await page.evaluate(({taskRoute,returnRoute}) => {location.hash=`${taskRoute}?${new URLSearchParams({return:returnRoute,actor:"other",returnTitle:"冒名 Session"})}`;},
    {taskRoute,returnRoute});
  await page.getByRole("tab",{name:"运行与关联"}).click();
  assert.equal(await page.evaluate(() => location.hash),`${taskRoute}?tab=runtime`);
});
