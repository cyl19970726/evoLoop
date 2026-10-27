// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname,"../dist");
const projectId = "40000001-0000-4000-8000-000000000001";
const roleId = "40000002-0000-4000-8000-000000000002";
const unknownId = "40000003-0000-4000-8000-000000000003";
const sessions = [
  {id:"40000004-0000-4000-8000-000000000004",roleId,state:"ready"},
  {id:"40000005-0000-4000-8000-000000000005",roleId,state:"closed"},
  {id:"40000006-0000-4000-8000-000000000006",roleId:"acceptance-owner",state:"ready"},
  {id:"40000007-0000-4000-8000-000000000007",roleId:unknownId,state:"unknown"},
].map(item=>({...item,projectId,authorizationScope:"固定任务",cwd:"/tmp/fixture",sandbox:"read-only",nativeThreadId:null}));

test("ordinary runtime Session cards verify distinct Role names and keep failures scoped", {skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  let fail=false, hold=false, held=0, release:(()=>void)|null=null;
  const reads:string[]=[];
  const server=createServer(async (req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");
    if (url.pathname==="/__fixture/fail") {fail=url.searchParams.get("value")==="1";res.end("ok");return;}
    if (url.pathname==="/__fixture/hold") {hold=true;res.end("ok");return;}
    if (url.pathname==="/__fixture/held") {res.end(String(held));return;}
    if (url.pathname==="/__fixture/release") {release?.();res.end("ok");return;}
    if (url.pathname==="/__fixture/reads") {res.end(JSON.stringify(reads));return;}
    if (url.pathname.startsWith("/api/")) {
      const p=`/api/projects/${projectId}`;let value:unknown={items:[],nextCursor:null},status=200;
      if (url.pathname==="/api/session") value={principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname===p) value={id:projectId,title:"夹具项目",createdAt:"2026-10-25T00:00:00.000Z"};
      else if (url.pathname===`${p}/runtime`) value={available:true,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname===`${p}/runtime/sessions`) value=sessions;
      else if (url.pathname===`${p}/runtime/runs`) value=[];
      else if (url.pathname===`${p}/resident-queues`) value=[];
      else if (url.pathname===`${p}/orchestration/status`) value={state:"active",running:false,busy:false,faults:[],lastError:null};
      else if (url.pathname===`${p}/orchestration/loops`) value={items:[],nextCursor:null};
      else if (url.pathname.startsWith(`${p}/roles/`)) {
        const id=url.pathname.slice(`${p}/roles/`.length);reads.push(id);
        if (id===roleId && hold) {hold=false;held++;await new Promise<void>(resolve=>{release=resolve;});}
        if (fail || id===unknownId) {status=id===unknownId?404:503;value={message:"职责暂不可读"};}
        else value={projectId,id,proposal:{title:"开发流程与规范负责人"}};
      }
      res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    try {const file=url.pathname==="/"?"index.html":url.pathname;const body=await readFile(join(dist,file));res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)]??"application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/#/p/${projectId}/runtime?view=execution`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  const first=page.locator(`#runtime-session-${sessions[0]!.id}`);
  const second=page.locator(`#runtime-session-${sessions[1]!.id}`);
  await first.locator(":scope > summary").getByRole("link",{name:"开发流程与规范负责人"}).waitFor();
  assert.match(await first.locator(":scope > summary").innerText(),/40000002.*就绪.*Session 40000004/);
  assert.match(await second.locator(":scope > summary").innerText(),/开发流程与规范负责人.*已关闭/);
  assert.match(await first.locator(":scope > summary a").getAttribute("href")??"",/\/roles$/);
  assert.match(await page.locator(`#runtime-session-${sessions[2]!.id} > summary`).innerText(),/acceptance-owner/);
  assert.match(await page.locator(`#runtime-session-${sessions[3]!.id} > summary`).innerText(),new RegExp(unknownId));
  const initialReads:string[]=await (await fetch(`${base}/__fixture/reads`)).json();
  assert.equal(initialReads.filter(id=>id===roleId).length,1);
  assert.equal(initialReads.includes("acceptance-owner"),false);
  assert.equal(await first.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await fetch(`${base}/__fixture/hold`);
  await page.getByRole("button",{name:"读取运行状态"}).click();
  for(let i=0;i<30 && await (await fetch(`${base}/__fixture/held`)).text()!=="1";i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await (await fetch(`${base}/__fixture/held`)).text(),"1");
  await fetch(`${base}/__fixture/fail?value=1`);
  await page.getByRole("button",{name:"读取运行状态"}).click();
  await first.locator(":scope > summary").getByText(/名称暂不可核对/).waitFor();
  assert.equal(await first.locator(":scope > summary").getByRole("link",{name:"开发流程与规范负责人"}).count(),0);
  await fetch(`${base}/__fixture/release`);
  await page.waitForTimeout(100);
  assert.equal(await first.locator(":scope > summary").getByRole("link",{name:"开发流程与规范负责人"}).count(),0);
  await fetch(`${base}/__fixture/fail?value=0`);
  await page.getByRole("button",{name:"读取运行状态"}).click();
  await first.locator(":scope > summary").getByRole("link",{name:"开发流程与规范负责人"}).waitFor();
  if (process.env.EVOLOOP_RUNTIME_ROLE_SCREENSHOT) await page.screenshot({path:process.env.EVOLOOP_RUNTIME_ROLE_SCREENSHOT,fullPage:false});
});
