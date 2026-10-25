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
const stamp = "2026-10-25T00:00:00.000Z";
const page = {items:[],nextCursor:null};

test("Task owner resolves one real Role and only verified bound Session links at 390px", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(playwrightModule!).href)).default;
  let roleFailure = false, roleReads = 0, roleListReads = 0;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/fail-role") { roleFailure = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reads") { res.end(JSON.stringify({roleReads,roleListReads})); return; }
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
        if (roleFailure) { status=503; value={message:"职责暂不可读"}; }
        else value={projectId,id:roleId,version:2,currentRevisionId:roleId,state:"active",proposal:{title:"开发流程职责"},proposedBy:"reader",createdAtUtc:stamp,trialStartedAtUtc:stamp,reviewAtUtc:stamp,mergeTargetRoleId:null};
      }
      else if (url.pathname === `${p}/roles/${unknownOwner}`) { roleReads++; status=404; value={message:"Role not found"}; }
      else if (url.pathname === `${p}/roles/${roleId}/bindings`) value = [
        {projectId,id:sessionId,roleId,sessionId,roleRevisionId:roleId,actorId:"reader",note:"已绑定",createdAtUtc:stamp},
        {projectId,id:mismatchedSessionId,roleId,sessionId:mismatchedSessionId,roleRevisionId:roleId,actorId:"reader",note:"旧关联",createdAtUtc:stamp},
      ];
      else if (url.pathname === `${p}/runtime/sessions`) value = [
        {projectId,id:sessionId,roleId,state:"ready"},
        {projectId,id:mismatchedSessionId,roleId:unknownOwner,state:"ready"},
      ];
      else if (url.pathname === `${p}/runtime/runs`) value = [];
      else if (url.pathname === `${p}/runtime`) value = {available:false,error:"夹具未接执行服务",allowedCwds:[],grants:[]};
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
  await fetch(`${base}/__fixture/fail-role`);
  await pageBrowser.getByRole("button",{name:"重新读取当前任务"}).click();
  await owner.getByText(/职责暂不可核对：职责暂不可读/).waitFor();
  assert.equal(await owner.getByRole("link",{name:"开发流程职责"}).count(),0);
  await pageBrowser.evaluate(({projectId,otherTaskId})=>{location.hash=`#/p/${projectId}/tasks/${otherTaskId}`;},{projectId,otherTaskId});
  const unknown=pageBrowser.locator(`[data-page-key="task:${otherTaskId}::"] .task-owner-meta`);
  await unknown.getByText(/未找到已登记职责/).waitFor();
  assert.match(await unknown.innerText(),new RegExp(unknownOwner));
});
