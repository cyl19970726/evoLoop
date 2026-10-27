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
  {id:"40000009-0000-4000-8000-000000000009",roleId,state:"ready"},
].map((item,index)=>({...item,projectId,actorId:"original-actor",authorizationScope:"固定任务",cwd:"/tmp/fixture",model:"gpt-6-sol",sandbox:"read-only",approvalPolicy:"on-request",nativeThreadId:null,version:1,
  ...(index===0?{model:null,executionProfile:{revision:{revisionId:"40000008-0000-4000-8000-000000000008",version:1,model:null,
    sandbox:"read-only",approvalPolicy:"on-request",createdAt:"2026-10-25T00:00:00.000Z"},activationState:"active",
    activeRevisionId:"40000008-0000-4000-8000-000000000008"}}:{}),
  ...(index===4?{sandbox:"danger-full-access",approvalPolicy:"never",executionProfile:{revision:{
    revisionId:"40000010-0000-4000-8000-000000000010",version:2,model:"gpt-6-sol",sandbox:"danger-full-access",
    approvalPolicy:"never",createdAt:"2026-10-25T00:00:00.000Z"},activationState:"pending",
    activeRevisionId:"40000011-0000-4000-8000-000000000011"}}:{})}));
const grants=[
  {projectId,actorId:"reader",roleId,authorizationScope:"旧授权",cwd:"/tmp/legacy",sandbox:"read-only",approvalPolicy:"on-request",networkAccess:false},
  {projectId,actorId:"reader",roleId,authorizationScope:"固定任务",cwd:"/tmp/fixture",sandbox:"danger-full-access",approvalPolicy:"never",networkAccess:true,model:"gpt-6-sol"},
];

test("runtime Session cards preserve Role history, full grants, and activation state", {skip:!modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(modulePath!).href)).default;
  let fail=false, hold=false, held=0, hideGrants=false, release:(()=>void)|null=null;
  let reservedCommand:Record<string,unknown>|null=null;
  const reads:string[]=[];
  const server=createServer(async (req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");
    if (url.pathname==="/__fixture/fail") {fail=url.searchParams.get("value")==="1";res.end("ok");return;}
    if (url.pathname==="/__fixture/hide-grants") {hideGrants=true;res.end("ok");return;}
    if (url.pathname==="/__fixture/hold") {hold=true;res.end("ok");return;}
    if (url.pathname==="/__fixture/held") {res.end(String(held));return;}
    if (url.pathname==="/__fixture/release") {release?.();res.end("ok");return;}
    if (url.pathname==="/__fixture/reads") {res.end(JSON.stringify(reads));return;}
    if (url.pathname.startsWith("/api/")) {
      const p=`/api/projects/${projectId}`;let value:unknown={items:[],nextCursor:null},status=200;
      if (url.pathname==="/api/session") value={principal:{actorId:"reader",projectIds:[projectId],permissions:["read","write","review"]},capabilities:{}};
      else if (url.pathname==="/api/commands" && req.method==="POST") {
        let body="";for await(const chunk of req)body+=String(chunk);
        reservedCommand=JSON.parse(body) as Record<string,unknown>;
        value={status:"applied",operationId:reservedCommand.operationId,entityId:reservedCommand.sessionId,version:1};
      }
      else if (url.pathname===p) value={id:projectId,title:"夹具项目",createdAt:"2026-10-25T00:00:00.000Z"};
      else if (url.pathname===`${p}/runtime`) value={available:true,error:null,allowedCwds:[],grants:hideGrants?[]:grants};
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
  const browser=await chromium.launch({headless:true,...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? {executablePath:process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH} : {})});t.after(()=>browser.close());
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
  await page.getByText("创建授权范围内的新会话").click();
  const grantOptions=await page.getByLabel("已配置的完整权限授权").locator("option").allTextContents();
  assert.equal(grantOptions.some(text=>text.includes("旧授权")),false);
  assert.equal(grantOptions.some(text=>text.includes("gpt-6-sol")),true);
  await page.locator(".command-disclosure > summary").filter({hasText:"登记并创建会话"}).click();
  const fullGrantValue=await page.getByLabel("已配置的完整权限授权").locator("option").filter({hasText:"gpt-6-sol"}).getAttribute("value");
  await page.getByLabel("已配置的完整权限授权").selectOption(fullGrantValue!);
  await page.getByRole("button",{name:"登记并创建会话"}).click();
  await page.getByText("已保存，正在读取持久记录。").waitFor();
  assert.equal(reservedCommand?.sandbox,"danger-full-access");
  assert.equal(reservedCommand?.approvalPolicy,"never");
  assert.equal(reservedCommand?.model,"gpt-6-sol");
  await fetch(`${base}/__fixture/hide-grants`);
  await page.getByRole("button",{name:"读取运行状态"}).click();
  await page.getByText("创建授权范围内的新会话").waitFor({state:"hidden"});
  await first.locator(":scope > summary").click();
  assert.match(await first.innerText(),/当前登记权限.*read-only.*on-request.*目标执行配置 v1.*已登记激活/s);
  assert.equal(await first.getByText("将原会话登记为完整权限").count(),1);
  await first.getByText("将原会话登记为完整权限").click();
  const upgrade=first.locator(".command-disclosure").filter({hasText:"升级原会话执行配置"});
  await upgrade.locator(":scope > summary").click();
  await upgrade.getByLabel("原创建者精确授权的目标模型").fill("gpt-6-sol");
  await upgrade.getByLabel("本次授权依据").fill("fixture://approved-full-grant");
  await upgrade.getByLabel("理由与依据").fill("旧会话升级，保留原 Session 和 Thread");
  await upgrade.getByRole("button",{name:"升级原会话执行配置"}).click();
  await page.waitForTimeout(200);
  assert.equal(reservedCommand?.type,"runtime.session.executionProfile.revise");
  assert.equal(reservedCommand?.model,"gpt-6-sol");
  assert.equal(reservedCommand?.sessionId,sessions[0]!.id);
  await second.locator(":scope > summary").click();
  assert.match(await second.innerText(),/未读到执行配置修订/);
  const pending=page.locator(`#runtime-session-${sessions[4]!.id}`);
  await pending.locator(":scope > summary").click();
  assert.match(await pending.innerText(),/目标执行配置 v2.*待激活.*目标修订尚未确认激活/s);
  assert.doesNotMatch(await pending.innerText(),/此修订已登记激活/);
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
