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
const longDiagram = `\`\`\`mermaid
flowchart TD
A["方案文档说明当前目标和边界供负责人复核确认来源确认版本"] --> B["总任务记录范围和交付条件供实施任务追溯确认责任确认状态"]
B --> C["实施任务固定方案版本和责任人开始执行记录进度交付产物"]
C --> D["交付与使用记录技术检查和真实使用等待负责人决定核对证据核对观察"]
D --> E["完成决定检查末节点和最后箭头完整显示保存结论回到任务"]
\`\`\``;

/** The fixture coordinator and a browser: two task pages, two document pages, reverse references and switches. */
async function startFixture(t: { after(fn: () => unknown): void }) {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let title = "中文跨页实施任务", version = 1, failReverse = false, delivered = false, failTaskRead = false;
  let holdTaskPage = false, releaseTaskPage: (() => void) | null = null, taskPageRequests = 0, docPageRequests = 0, longPages = false, longReverse = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/change" && req.method === "POST") { title = "命令行已更新的实施任务"; version++; res.end("ok"); return; }
    if (url.pathname === "/__fixture/close" && req.method === "POST") { version++; delivered = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-task-read" && req.method === "POST") { failTaskRead = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/recover-task-read" && req.method === "POST") { failTaskRead = false; res.end("ok"); return; }
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
      else if (url.pathname === `${p}/tasks/${taskId}`) {
        if (failTaskRead) { res.writeHead(503,{"content-type":"application/json"}); res.end(JSON.stringify({message:"稍后重试"})); return; }
        value = {task:{...current,state:delivered ? "done" : "in_progress"},revision:{...current,taskId,id:taskId},basis:null,
          links:[{projectId,id:taskId,taskId,documentId,actorId:"developer",createdAt}],impacts:[],decisions:[],deliveries:delivered ? [{projectId,id:taskId,taskId,taskRevisionId:taskId,technicalResult:"passed",technicalEvidence:"夹具检查",createdAt,actorId:"developer",artifactRef:"fixture-report",artifactRevision:"r1",contentHash:"a".repeat(64)}] : [],observations:[],closures:[]};
      }
      else if (url.pathname.startsWith(`${p}/tasks/`)) {
        const id = url.pathname.slice(`${p}/tasks/`.length);
        const item = task(id,"占位任务");
        value = {task:item,revision:{...item,taskId:id,id},basis:null,links:[],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/documents/${documentId}`) value = {document:{projectId,id:documentId,version:1,currentRevisionId:documentId,adoptedRevisionId:documentId,title:"中文跨页方案文档",kind:"spec",status:"published",primaryTaskId:null},
        current:{projectId,id:documentId,documentId,version:1,body:`方案正文\n\n${longDiagram}`,format:"markdown",contentHash:"a".repeat(64),previousRevisionId:null,actorId:"developer",reason:"创建",createdAt},adopted:null};
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
      else if (url.pathname === `${p}/work-management/index`) value = {items:[],nextCursor:null,total:0,counts:{},changeSequence:0,observedAt:createdAt,partial:false};
      else if (url.pathname === `${p}/orchestration/work-status`) value = {items:url.searchParams.get("taskIds")?.split(",").map(taskId => ({taskId})) ?? []};
      else if (url.pathname === `${p}/runtime`) value = {available:false,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/runtime/runs` || url.pathname === `${p}/runtime/sessions`) value = [];
      else if (url.pathname.startsWith(`${p}/references/`)) value = [];
      else if (url.pathname === `${p}/runtime/sessions`) value = [];
      res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist,/^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"}); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  return { base, browser };
}

test("built workbench discovers later Chinese task and document pages, linked tasks, and external changes", { skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { base, browser } = await startFixture(t);
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  const main=page.getByRole("main");
  // In-app navigation, as a link click does: the page and its in-memory login stay.
  const go=(path: string) => page.evaluate(target => { const link=Object.assign(document.createElement("a"),{href:target}); document.body.append(link); link.click(); link.remove(); }, path);
  // At 390px the task list (with its search box) is in the navigation drawer; the table view fills the center.
  const openNavigation=async () => { await page.getByRole("button",{name:"打开项目导航"}).click(); };
  const closeNavigation=async () => { await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({state:"detached"}); };
  await main.getByRole("button",{name:"加载更多"}).waitFor();
  await fetch(`${base}/__fixture/hold-task-page`,{method:"POST"});
  await main.getByRole("button",{name:"加载更多"}).click();
  await openNavigation();
  const taskSearch=page.getByRole("searchbox",{name:"搜索任务"});
  await taskSearch.fill("中文跨页实施任务");
  await page.waitForTimeout(250);
  assert.equal(await (await fetch(`${base}/__fixture/task-page-count`)).text(),"1");
  await fetch(`${base}/__fixture/release-task-page`,{method:"POST"});
  await page.getByRole("dialog").getByRole("link",{name:/中文跨页实施任务/}).waitFor();
  await closeNavigation();
  await main.getByRole("button",{name:"中文跨页实施任务",exact:true}).waitFor();
  assert.equal(await main.getByRole("button",{name:"中文跨页实施任务",exact:true}).count(),1);
  await openNavigation(); await taskSearch.fill(""); await closeNavigation();
  await main.getByText(/已载入 51 项/).waitFor();
  await openNavigation(); await taskSearch.fill("中文跨页实施任务"); await closeNavigation();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // Open the task from the table; Back returns to the same searched list (the search is in the address).
  await main.getByRole("link",{name:"打开任务：中文跨页实施任务"}).click();
  await page.getByRole("heading",{level:1,name:"中文跨页实施任务"}).waitFor();
  await page.goBack();
  await main.getByRole("button",{name:"中文跨页实施任务",exact:true}).waitFor();
  assert.match(page.url(),/[?&]q=/);
  await openNavigation();
  assert.equal(await taskSearch.inputValue(),"中文跨页实施任务");
  await closeNavigation();
  await main.getByRole("link",{name:"打开任务：中文跨页实施任务"}).click();
  await page.getByRole("heading",{level:1,name:"中文跨页实施任务"}).waitFor();
  assert.equal(await main.locator("[data-task-acceptance]").evaluate(el => el.scrollWidth <= el.clientWidth),true);
  // Related documents are listed in the task's right column (a sheet from the bottom at 390px). The document opens
  // beside the task, and 在中间打开 goes to the document's own page; the sheet closes on the way.
  await main.getByRole("button",{name:"任务信息"}).click();
  const sheet=page.getByRole("dialog");
  await sheet.getByRole("button",{name:/中文跨页方案文档/}).click();
  await sheet.getByRole("tab",{name:"中文跨页方案文档"}).waitFor();
  await sheet.getByRole("link",{name:"在中间打开"}).click();
  await page.getByRole("heading",{name:"中文跨页方案文档",level:1}).waitFor();
  await sheet.waitFor({state:"detached"});
  await page.goBack();
  await page.getByRole("heading",{level:1,name:"中文跨页实施任务"}).waitFor();
  await fetch(`${base}/__fixture/close`,{method:"POST"});
  await go(`/p/${projectId}/documents`);
  await page.getByRole("button",{name:"载入更多"}).waitFor();
  await go(`/p/${projectId}/tasks/${taskId}`);
  // Coming back to the task rereads it: the header shows the new version, the right column the new delivery.
  const header=page.locator(`[data-page-key="task:${taskId}:::"] [data-task-header]`);
  await header.getByText(/第 2 版/).waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Task return did not refresh: ${await page.locator('.task-page').innerText()}`);
  });
  // The delivery's technical check, read in the task's 交付与使用 layer.
  const deliveryChecked=async () => {
    const page_=page.locator(`[data-page-key="task:${taskId}:::"]`);
    await page_.getByRole("tab",{name:"交付与使用"}).click();
    await page_.getByText(/技术检查通过/).first().waitFor();
    await page_.getByRole("tab",{name:"当前工作"}).click();
  };
  await deliveryChecked();
  await fetch(`${base}/__fixture/fail-task-read`,{method:"POST"});
  await go(`/p/${projectId}/documents`);
  await page.getByRole("button",{name:"载入更多"}).waitFor();
  await go(`/p/${projectId}/tasks/${taskId}`);
  await page.getByText(/当前任务回读失败.*不能视为当前状态/).waitFor();
  await fetch(`${base}/__fixture/recover-task-read`,{method:"POST"});
  await page.getByRole("button",{name:"重新读取当前任务"}).click();
  await deliveryChecked();
  await fetch(`${base}/__fixture/change`,{method:"POST"});
  await page.getByRole("button",{name:"重新读取当前任务"}).click();
  await page.getByRole("heading",{name:"命令行已更新的实施任务"}).waitFor();
  await fetch(`${base}/__fixture/long-pages`,{method:"POST"});
  await go(`/p/${projectId}/work`);
  await page.getByRole("main").getByRole("button",{name:"重新读取列表"}).click();
  await page.getByRole("button",{name:"打开项目导航"}).click();
  await page.getByRole("searchbox",{name:"搜索任务"}).fill("不存在的中文任务");
  await page.getByRole("dialog").getByText(/自动搜索已达 10 页或 500 项上限；结果未完整/).waitFor();
  assert.equal(await page.getByText("没有匹配项").count(),0);
});

test("built documents list finds a later page by search, reads Markdown in full with its referencing tasks, and keeps partial reads partial", { skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { base, browser } = await startFixture(t);
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/documents`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  // At 390px the inner rail is a closed drawer, so the table carries the search and filters.
  await page.getByRole("button",{name:"载入更多"}).waitFor();
  const search = page.getByRole("searchbox",{name:"搜索文档"});
  assert.equal(await search.count(), 1, "one search box on the page");
  await search.fill("中文跨页方案文档");
  await page.waitForTimeout(700); assert.equal(await (await fetch(`${base}/__fixture/doc-page-count`)).text(),"1", "the search reads the later page once");
  const row = page.getByRole("table").getByRole("link",{name:"中文跨页方案文档"});
  await row.waitFor();
  await page.getByText("已载入 51 项 · 匹配 1 项 · 已读完").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await row.click();
  await page.getByRole("heading",{name:"中文跨页方案文档",level:1}).waitFor();
  // Markdown keeps the long Mermaid diagram whole in its sandboxed frame.
  const iframe = page.locator('iframe[title="静态 Mermaid 图"]');
  await iframe.waitFor();
  const diagram = await iframe.contentFrame().locator("svg").evaluate(svg => {
    const nodes = [...svg.querySelectorAll("g.node")];
    const links = [...svg.querySelectorAll("path.flowchart-link")];
    return {nodeCount:nodes.length, linkCount:links.length, naturalHeight:(svg as SVGSVGElement).viewBox.baseVal.height,
      frameHeight:document.documentElement.clientHeight, svgBottom:svg.getBoundingClientRect().bottom,
      lastNodeBottom:nodes.at(-1)?.getBoundingClientRect().bottom ?? 0,
      lastLinkBottom:links.at(-1)?.getBoundingClientRect().bottom ?? 0};
  });
  assert.equal(diagram.nodeCount,5);
  assert.ok(diagram.naturalHeight > 760, JSON.stringify(diagram));
  assert.ok(diagram.linkCount >= 4, JSON.stringify(diagram));
  assert.ok(diagram.svgBottom <= diagram.frameHeight - 8, JSON.stringify(diagram));
  assert.ok(diagram.lastNodeBottom <= diagram.frameHeight - 8, JSON.stringify(diagram));
  assert.ok(diagram.lastLinkBottom <= diagram.frameHeight - 8, JSON.stringify(diagram));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.EVOLOOP_DIAGRAM_SCREENSHOT) {
    await page.addStyleTag({content:"[data-shell=mobile-header]{position:static!important}"});
    await page.locator(".markdown-diagram").screenshot({path:process.env.EVOLOOP_DIAGRAM_SCREENSHOT});
  }
  // Referencing tasks are read across pages; one opens beside the text in the right column.
  await page.getByRole("button",{name:"版本与来源"}).click();
  const facts = page.getByRole("dialog").getByRole("region",{name:"文档版本、来源与关联"});
  await facts.getByRole("link",{name:/中文跨页实施任务/}).waitFor();
  assert.equal(await facts.evaluate(el => el.scrollWidth <= el.clientWidth), true, "the right column does not scroll sideways");
  await facts.getByRole("link",{name:/中文跨页实施任务/}).click();
  await page.getByRole("tab",{name:"中文跨页实施任务"}).waitFor();
  await page.getByRole("dialog").getByText("完成条件").waitFor();
  assert.match(await page.evaluate(() => location.pathname), /\/documents\//, "opening a referencing task keeps the document in the center");
  await page.getByRole("tab",{name:"信息"}).click();
  await page.getByRole("button",{name:"关闭右栏"}).click();
  // A failed or capped reverse read stays partial and never says there are no references.
  const reread = () => page.getByRole("button",{name:"重新读取当前文档"}).click();
  await fetch(`${base}/__fixture/fail-reverse`,{method:"POST"});
  await reread();
  await page.getByRole("button",{name:"版本与来源"}).click();
  await page.getByText(/引用它的任务这次没有读完整/).waitFor({timeout:10000});
  assert.equal(await page.getByText("目前没有任务引用这份文档。").count(),0);
  await page.getByRole("button",{name:"关闭右栏"}).click();
  await fetch(`${base}/__fixture/long-reverse`,{method:"POST"});
  await reread();
  await page.getByRole("button",{name:"版本与来源"}).click();
  await page.getByText(/已读到 20 页或 1000 项的上限/).waitFor();
  await page.getByRole("button",{name:"关闭右栏"}).click();
  // Back to the list: the same search, range and row, with focus on the document just read.
  await page.locator(".document-reading-backlinks").getByRole("link",{name:/^返回文档列表/}).click();
  await row.waitFor();
  assert.equal(await search.inputValue(),"中文跨页方案文档");
  await page.waitForFunction("document.activeElement?.textContent === '中文跨页方案文档'");
  assert.deepEqual(errors, []);
});
