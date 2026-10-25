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
const documentId = "ffffffff-0000-4000-8000-000000000003";
const taskId = "ffffffff-0000-4000-8000-000000000001";
const createdAt = "2026-10-25T00:00:00.000Z";
const ids = Array.from({ length: 50 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`);
const task = (id: string, title: string, version = 1) => ({ projectId, id, version, currentRevisionId:id, title, content:"正文", contentDocumentId:id, contentRevisionId:id,
  kind:"implementation", acceptance:"有证据", owner:"developer", state:"in_progress", basisSetId:null, actorId:"developer", reason:"创建", createdAt });

test("built workbench discovers later Chinese task and document pages, linked tasks, and external changes", { skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let title = "中文跨页实施任务", version = 1, failReverse = false;
  let holdTaskPage = false, releaseTaskPage: (() => void) | null = null, taskPageRequests = 0, docPageRequests = 0, longPages = false, longReverse = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/change" && req.method === "POST") { title = "命令行已更新的实施任务"; version++; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-reverse" && req.method === "POST") { failReverse = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-task-page" && req.method === "POST") { holdTaskPage = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/release-task-page" && req.method === "POST") { holdTaskPage = false; releaseTaskPage?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/task-page-count") { res.end(String(taskPageRequests)); return; }
    if (url.pathname === "/__fixture/doc-page-count") { res.end(String(docPageRequests)); return; }
    if (url.pathname === "/__fixture/long-pages" && req.method === "POST") { longPages = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/long-reverse" && req.method === "POST") { failReverse = false; longReverse = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      const current = task(taskId, title, version);
      let value: unknown = {items:[],nextCursor:null};
      if (url.pathname === "/api/session") value = {principal:{actorId:"developer",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"项目",createdAt};
      else if (url.pathname === `${p}/tasks`) {
        const cursor = url.searchParams.get("cursor");
        if (cursor) {
          taskPageRequests++;
          if (holdTaskPage) await new Promise<void>(resolve => { releaseTaskPage = resolve; });
        }
        value = longPages ? {items:Array.from({length:50}, (_, n) => task(`00000000-0000-4000-8001-${String(Number(cursor ?? 0) * 50 + n).padStart(12,"0")}`,"其他任务")),nextCursor:Number(cursor ?? 0) < 12 ? String(Number(cursor ?? 0) + 1) : null}
          : cursor ? {items:[task(ids[0],"占位任务"),current],nextCursor:null} : {items:ids.map(id => task(id,"占位任务")),nextCursor:"task-next"};
      }
      else if (url.pathname === `${p}/documents`) { if (url.searchParams.has("cursor")) docPageRequests++; value = url.searchParams.has("cursor")
        ? {items:[{projectId,id:documentId,version:1,currentRevisionId:documentId,adoptedRevisionId:documentId,title:"中文跨页方案文档",kind:"spec",status:"published",primaryTaskId:null}],nextCursor:null}
        : {items:ids.map(id => ({projectId,id,version:1,currentRevisionId:id,adoptedRevisionId:null,title:"其他文档",kind:"spec",status:"draft",primaryTaskId:null})),nextCursor:"doc-next"}; }
      else if (url.pathname === `${p}/tasks/${taskId}`) value = {task:current,revision:{...current,taskId,id:taskId},basis:null,
        links:[{projectId,id:taskId,taskId,documentId,actorId:"developer",createdAt}],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      else if (url.pathname.startsWith(`${p}/tasks/`)) {
        const id = url.pathname.slice(`${p}/tasks/`.length);
        const item = task(id,"占位任务");
        value = {task:item,revision:{...item,taskId:id,id},basis:null,links:[],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/documents/${documentId}`) value = {document:{projectId,id:documentId,version:1,currentRevisionId:documentId,adoptedRevisionId:documentId,title:"中文跨页方案文档",kind:"spec",status:"published",primaryTaskId:null},
        current:{projectId,id:documentId,documentId,version:1,body:"方案正文",format:"markdown",contentHash:"a".repeat(64),previousRevisionId:null,actorId:"developer",reason:"创建",createdAt},adopted:null};
      else if (url.pathname === `${p}/documents/${documentId}/tasks`) {
        if (failReverse) { res.writeHead(503,{"content-type":"application/json"}); res.end(JSON.stringify({message:"稍后重试"})); return; }
        value = longReverse ? {items:Array.from({length:50},(_,n) => {
          const id = `00000000-0000-4000-8002-${String(Number(url.searchParams.get("cursor") ?? 0) * 50 + n).padStart(12,"0")}`;
          return {projectId,id,title:"关联任务",owner:"developer",state:"in_progress",kind:"implementation",version:1,currentRevisionId:id,relations:["link"]};
        }),nextCursor:String(Number(url.searchParams.get("cursor") ?? 0) + 1)} : url.searchParams.has("cursor")
          ? {items:[{projectId,id:taskId,title,owner:"developer",state:"in_progress",kind:"implementation",version,currentRevisionId:taskId,relations:["link"]}],nextCursor:null}
          : {items:ids.map(id => ({projectId,id,title:"占位任务",owner:"developer",state:"in_progress",kind:"implementation",version:1,currentRevisionId:id,relations:["basis"]})),nextCursor:"reverse-next"};
      }
      else if (url.pathname === `${p}/impacts`) value = [];
      else if (url.pathname === `${p}/orchestration/work-status`) value = {items:url.searchParams.get("taskIds")?.split(",").map(taskId => ({taskId})) ?? []};
      else if (url.pathname === `${p}/runtime`) value = {available:false,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/runtime/runs` || url.pathname === `${p}/runtime/sessions`) value = [];
      else if (url.pathname.startsWith(`${p}/references/`)) value = [];
      else if (url.pathname === `${p}/runtime/sessions`) value = [];
      res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"}); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser = await chromium.launch({headless:true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/#/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.getByRole("button",{name:"加载更多"}).waitFor();
  await fetch(`${base}/__fixture/hold-task-page`,{method:"POST"});
  await page.getByRole("button",{name:"加载更多"}).click();
  await page.getByPlaceholder(/查找任务/).fill("中文跨页实施任务");
  await page.waitForTimeout(250);
  assert.equal(await (await fetch(`${base}/__fixture/task-page-count`)).text(),"1");
  await fetch(`${base}/__fixture/release-task-page`,{method:"POST"});
  await page.getByRole("link",{name:"中文跨页实施任务"}).waitFor();
  assert.equal(await page.getByRole("link",{name:"中文跨页实施任务"}).count(),1);
  await page.getByPlaceholder(/查找任务/).fill("");
  await page.locator(".list-footer").getByText(/已载入 51 项/).waitFor();
  await page.getByPlaceholder(/查找任务/).fill("中文跨页实施任务");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("link",{name:"中文跨页实施任务"}).click();
  await page.getByRole("heading",{name:"关联过程文档"}).waitFor();
  assert.equal(await page.locator(".task-overview-grid").evaluate(el => el.scrollWidth <= el.clientWidth),true);
  await page.getByRole("link",{name:"中文跨页方案文档"}).click();
  await page.getByRole("heading",{name:"引用此文档的任务"}).waitFor();
  await page.getByRole("link",{name:"中文跨页实施任务"}).waitFor();
  assert.equal(await page.locator(".doc-related-tasks").evaluate(el => el.scrollWidth <= el.clientWidth),true);
  await page.getByRole("link",{name:"中文跨页实施任务"}).click();
  await fetch(`${base}/__fixture/change`,{method:"POST"});
  await page.getByRole("button",{name:"重新读取当前任务"}).click();
  await page.getByRole("heading",{name:"命令行已更新的实施任务"}).waitFor();
  await page.evaluate(projectId => { location.hash = `#/p/${projectId}/documents`; }, projectId);
  await page.getByRole("button",{name:"加载更多"}).waitFor();
  await page.getByPlaceholder("查找文档…").fill("中文跨页方案文档");
  await page.waitForTimeout(700); assert.equal(await (await fetch(`${base}/__fixture/doc-page-count`)).text(),"1");
  await page.getByRole("link",{name:"中文跨页方案文档"}).waitFor();
  await fetch(`${base}/__fixture/fail-reverse`,{method:"POST"});
  await page.getByRole("link",{name:"中文跨页方案文档"}).click();
  await page.getByRole("button",{name:"重新读取当前文档"}).click();
  await page.getByText(/任务关联未读完整/).waitFor();
  assert.equal(await page.getByText("当前没有任务引用此文档。").count(),0);
  await fetch(`${base}/__fixture/long-reverse`,{method:"POST"});
  await page.getByRole("button",{name:"重新读取当前文档"}).click();
  await page.getByText(/已达 20 页或 1000 项读取上限/).waitFor();
  await fetch(`${base}/__fixture/long-pages`,{method:"POST"});
  await page.evaluate(projectId => { location.hash = `#/p/${projectId}/work`; }, projectId);
  await page.getByRole("button",{name:"重新读取列表"}).click();
  await page.getByPlaceholder(/查找任务/).fill("不存在的中文任务");
  await page.getByText(/自动搜索已达 10 页或 500 项上限；结果未完整/).waitFor();
  assert.equal(await page.getByText("没有匹配项").count(),0);
});
