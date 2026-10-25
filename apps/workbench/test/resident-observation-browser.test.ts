// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "10000001-0000-4000-8000-000000000001";
const roleId = "10000002-0000-4000-8000-000000000002";
const sessionId = "10000003-0000-4000-8000-000000000003";
const taskA = "10000004-0000-4000-8000-000000000004";
const taskB = "10000005-0000-4000-8000-000000000005";
const taskC = "10000010-0000-4000-8000-000000000016";
const queueId = "10000006-0000-4000-8000-000000000006";
const runA = "10000007-0000-4000-8000-000000000007";
const runB = "10000017-0000-4000-8000-000000000023";
const discussionId = "10000008-0000-4000-8000-000000000008";
const domainId = "10000009-0000-4000-8000-000000000009";
const documentId = "1000000a-0000-4000-8000-000000000010";
const externalId = "1000000b-0000-4000-8000-000000000011";
const questionId = "1000000c-0000-4000-8000-000000000012";
const answerId = "1000000d-0000-4000-8000-000000000013";
const stamp = "2026-10-25T00:00:00.000Z";
const page = (items: unknown[]) => ({ items, nextCursor: null });
const proposal = { title:"实际开发流程",roleClass:"business",templateKey:"development-workflow",goal:"维护项目交付",independentResponsibility:"持续判断任务边界",ownerScope:"有界开发",
  inputs:["已采纳任务"],writableAssets:[],deliverables:["固定报告"],triggers:["任务入队"],workflow:"检查、实施、交付",handoffBoundary:"交付消费者",
  firstTaskId:taskA,trialDays:14,baseline:"人工领取",expectedEffect:"稳定协作",costLimit:"两次",reviewAtUtc:stamp,exitCriteria:"回看",
  evidence:[],alternatives:[] };
const role = {projectId,id:roleId,version:2,currentRevisionId:roleId,state:"active",proposal,proposedBy:"lead",createdAtUtc:stamp,
  trialStartedAtUtc:stamp,reviewAtUtc:stamp,mergeTargetRoleId:null};
const systemRoleId = "10000014-0000-4000-8000-000000000020";
const legacyRoleId = "10000015-0000-4000-8000-000000000021";
const systemRole = {...role,id:systemRoleId,currentRevisionId:systemRoleId,proposal:{...proposal,title:"Lead",roleClass:"system",templateKey:"lead"}};
const legacyRole = {...role,id:legacyRoleId,currentRevisionId:legacyRoleId,proposal:{...proposal,title:"旧职责",roleClass:undefined,templateKey:undefined}};
const task = (id:string,title:string) => ({projectId,id,title,version:2,currentRevisionId:id,content:"固定任务正文",contentDocumentId:id,
  contentRevisionId:id,kind:"implementation",acceptance:"消费者实际使用后验收",owner:"worker",state:"in_progress",createdAt:stamp});
const session = {projectId,id:sessionId,roleId:"worker",state:"ready",authorizationScope:"项目工作树",cwd:"/tmp/worktree",sandbox:"workspace-write",nativeThreadId:"native-thread",createdAt:stamp};
const run = {projectId,id:runA,taskId:taskA,taskRevisionId:taskA,basisSetId:taskA,sessionId,operationId:runA,input:"固定输入",inputHash:"a".repeat(64),
  state:"completed",version:2,nativeTurnId:"native-turn",interruptRequested:false,resultSummary:"已完成原生运行",actorId:"worker",createdAt:stamp,updatedAt:stamp};
const entries = [
  {projectId,queueId,id:taskA,taskId:taskA,taskRevisionId:taskA,sourceInputJson:"{}",sessionId,roleId,position:0,dependsOn:[],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"claimed",holdCode:"awaiting_acceptance",holdReason:"等待实际使用与验收",claimId:taskA,version:2},
  {projectId,queueId,id:taskB,taskId:taskB,taskRevisionId:taskB,sourceInputJson:"{}",sessionId,roleId,position:1,dependsOn:[taskA],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"queued",holdCode:null,holdReason:null,claimId:null,version:1},
  {projectId,queueId,id:taskC,taskId:taskC,taskRevisionId:taskC,sourceInputJson:"{}",sessionId,roleId,position:2,dependsOn:[taskB],consumerId:"consumer",useRequired:true,releaseRule:"accepted",state:"held",holdCode:"unknown",holdReason:"原操作 ID 尚待核对",claimId:null,version:1},
];
const queue = {projectId,id:queueId,version:2,adoptedVersion:2,maxRuns:6,reason:"A 使用验收后再启动 B",actorId:"lead",entries};
const domain = {projectId,id:domainId,version:1,currentRevisionId:domainId,title:"功能开发",roleId,routingReason:"实际开发流程负责",authorizationEvidence:"负责人确认",state:"active",actorId:"lead",createdAtUtc:stamp};
const external = {projectId,id:externalId,roleId,version:2,host:{kind:"external",provider:"codex-desktop",ref:"Desktop 人工会话"},
  claimedCapabilities:["open","read","start","send"],verifiedCapabilities:["open","read","manual-claim"],evidence:"人工核实",observer:"lead",observedAtUtc:stamp,state:"verified",actorId:"lead",createdAtUtc:stamp};
const owned = {...external,id:sessionId,host:{kind:"owned",sessionId},verifiedCapabilities:["open","read","start","send"],claimedCapabilities:["open","read","start","send"]};
const discussion = {projectId,id:discussionId,version:6,kind:"task_collaboration",status:"prepared",documentId,preparedDocumentRevisionId:documentId,
  currentDocumentRevisionId:documentId,latestDecisionEventId:null,goal:null,stage:null,task:{id:taskA,revisionId:taskA},adoptedDocuments:[],
  question:"实现前的有界疑问",options:[],authorizationBoundary:"固定任务",targetSessionLabel:"原会话",targetSessionRef:null,
  actorId:"worker",createdAt:stamp,updatedAt:stamp,collaboration:{runId:runA,sessionId,issuerActorId:"lead",recipientActorId:"worker"}};
const event = (id:string,version:number,actorId:string,kind:string,collaborationPayload:unknown) => ({projectId,id,discussionId,version,kind,documentRevisionId:null,
  actorId,createdAt:stamp,evidence:null,reason:null,choice:null,unresolved:null,relookCondition:null,supersedesDecisionEventId:null,decisionEventId:null,target:null,collaborationPayload});
const events = [
  event(questionId,1,"worker","message",{type:"message",kind:"question",recipientActorId:"lead",body:{documentId,revisionId:documentId},replyToEventId:null}),
  event(answerId,2,"lead","message",{type:"message",kind:"answer",recipientActorId:"worker",body:{documentId,revisionId:documentId},replyToEventId:questionId}),
  event("1000000e-0000-4000-8000-000000000014",3,"worker","receipt",{type:"receipt",messageEventId:answerId,stage:"adopted",evidence:{documentId,revisionId:documentId},continuation:{runId:runA,taskRevisionId:taskA}}),
  event("1000000f-0000-4000-8000-000000000015",4,"worker","action_request",{type:"action_request",requestId:runA,executorActorId:"lead",actionType:"pr.merge",scope:{repository:"evoLoop",worktree:"/tmp/worktree",paths:["apps/workbench"]},inputHash:"a".repeat(64),reason:"合并需授权",authorityEvidence:"明确决定",expiresAt:stamp,acceptance:"当前头部",detail:{documentId,revisionId:documentId}}),
  event("10000011-0000-4000-8000-000000000017",5,"lead","action_decision",{type:"action_decision",requestEventId:"1000000f-0000-4000-8000-000000000015",decision:"approved",evidence:{documentId,revisionId:documentId}}),
  event("10000012-0000-4000-8000-000000000018",6,"worker","action_execution",{type:"action_execution",requestEventId:"1000000f-0000-4000-8000-000000000015",decisionEventId:"10000011-0000-4000-8000-000000000017",state:"unknown",externalOperationId:"10000013-0000-4000-8000-000000000019",artifact:{documentId,revisionId:documentId}}),
];

test("resident observation keeps acceptance, host authority and task replies distinct at 390px", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const {chromium} = (await import(pathToFileURL(playwrightModule!).href)).default;
  let failDiscussions = false, longDiscussions = false;
  let currentQueue = queue;
  let taskReads: string[] = [];
  const oldEntries = Array.from({length:24},(_,index) => {
    const id = `30000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
    return {...entries[0],id,taskId:id,taskRevisionId:id,position:index,state:"released",claimId:null,holdCode:null,holdReason:null};
  });
  let currentRun = {...run,state:"running"};
  let currentRoleTitle = "实际开发流程";
  let holdNextRole = false, heldRoleReads = 0, releaseHeldRole: (() => void) | null = null, failRoleReads = 0;
  let currentAttempts = [{entryId:taskA,claimId:taskA,attempts:[{projectId,claimId:taskA,sequence:1,runId:runA,operationId:runA,taskRevisionId:taskA,actualRunTaskRevisionId:taskA,reservedAt:stamp}]},{entryId:taskB,claimId:null,attempts:[]},{entryId:taskC,claimId:null,attempts:[]}];
  let holdNextDetail = false, heldDetails = 0, releaseHeldDetail: (() => void) | null = null;
  let priorityDetail: typeof queue | null = null, heldPriorityDetails = 0, releasePriorityDetail: (() => void) | null = null;
  let currentHosts = [external,owned];
  let currentRoute = {domain,role,status:"external-manual",link:external,session:null,automaticStart:false};
  let holdNextRoute = false, heldRoutes = 0, releaseHeldRoute: (() => void) | null = null, failPresenceList = false;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/fail-discussions") { failDiscussions = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/long-discussions") { failDiscussions = false; longDiscussions = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-next-detail") { holdNextDetail = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-next-role") { holdNextRole = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/held-role-count") { res.end(String(heldRoleReads)); return; }
    if (url.pathname === "/__fixture/release-held-role") { releaseHeldRole?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/rename-role") { currentRoleTitle = "已更新的承接职责"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-next-role") { failRoleReads = 3; res.end("ok"); return; }
    if (url.pathname === "/__fixture/restore-role") { failRoleReads = 0; res.end("ok"); return; }
    if (url.pathname === "/__fixture/terminal-run") { currentRun = {...run,state:"completed"}; res.end("ok"); return; }
    if (url.pathname === "/__fixture/deep-queue") {
      currentQueue = {...queue,entries:[...oldEntries,...entries.map((entry,index) => ({...entry,position:index+24}))]};
      taskReads = []; res.end("ok"); return;
    }
    if (url.pathname === "/__fixture/task-reads") { res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(taskReads));return; }
    if (url.pathname === "/__fixture/reset-task-reads") { taskReads = []; res.end("ok"); return; }
    if (url.pathname === "/__fixture/priority-detail") {
      priorityDetail = {...currentQueue,entries:currentQueue.entries.map(entry => entry.id === taskA ? {...entry,state:"released",holdCode:null,holdReason:null}
        : entry.id === taskB ? {...entry,state:"claimed",claimId:taskB} : entry.id === taskC ? {...entry,state:"queued",holdCode:null,holdReason:null} : entry)};
      res.end("ok"); return;
    }
    if (url.pathname === "/__fixture/held-priority-detail-count") { res.end(String(heldPriorityDetails)); return; }
    if (url.pathname === "/__fixture/release-priority-detail") { releasePriorityDetail?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/restore-queue") { currentQueue = queue; priorityDetail = null; res.end("ok"); return; }
    if (url.pathname === "/__fixture/held-detail-count") { res.end(String(heldDetails)); return; }
    if (url.pathname === "/__fixture/release-held-detail") { releaseHeldDetail?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/advance-queue") {
      currentQueue = {...queue,entries:queue.entries.map(entry => entry.id === taskA ? {...entry,state:"released",holdCode:null,holdReason:null}
        : entry.id === taskB ? {...entry,state:"claimed",claimId:taskB} : entry)};
      currentAttempts = [{...currentAttempts[0]},{entryId:taskB,claimId:taskB,attempts:[{projectId,claimId:taskB,sequence:1,runId:runB,operationId:runB,taskRevisionId:taskB,actualRunTaskRevisionId:taskB,reservedAt:stamp}]},{...currentAttempts[2]}];
      res.end("ok"); return;
    }
    if (url.pathname === "/__fixture/hold-next-route") { holdNextRoute = true; currentRoute = {...currentRoute,status:"owned-ready",link:owned,session,automaticStart:true}; res.end("ok"); return; }
    if (url.pathname === "/__fixture/held-route-count") { res.end(String(heldRoutes)); return; }
    if (url.pathname === "/__fixture/release-held-route") { releaseHeldRoute?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/revoke-route") { currentHosts = [{...external,state:"revoked"},{...owned,state:"revoked"}]; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-presence-list") { failPresenceList = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value:unknown = page([]);
      if (url.pathname === "/api/session") value = {principal:{actorId:"lead",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"夹具项目",createdAt:stamp};
      else if (url.pathname === `${p}/roles`) value = page([role,systemRole,legacyRole]);
      else if (url.pathname === `${p}/roles/${roleId}`) {
        value = {...role,proposal:{...proposal,title:currentRoleTitle}};
        if (failRoleReads > 0) { failRoleReads--; res.writeHead(503,{"content-type":"application/json"}); res.end(JSON.stringify({message:"职责名称暂不可读"})); return; }
        if (holdNextRole) { holdNextRole = false; heldRoleReads++;
          await new Promise<void>(resolve => { releaseHeldRole = resolve; }); }
      }
      else if (url.pathname === `${p}/roles/${roleId}/hosts`) {
        if (failPresenceList) { res.writeHead(503,{"content-type":"application/json"}); res.end(JSON.stringify({message:"承载暂不可读"})); return; }
        value = currentHosts;
      }
      else if (url.pathname === `${p}/domains`) value = [domain];
      else if (url.pathname === `${p}/domains/${domainId}/route`) {
        value = currentRoute;
        if (holdNextRoute) { holdNextRoute = false; heldRoutes++;
          await new Promise<void>(resolve => { releaseHeldRoute = resolve; }); }
      }
      else if (url.pathname === `${p}/resident-queues`) value = [currentQueue];
      else if (url.pathname === `${p}/resident-queues/${queueId}`) {
        value = priorityDetail ?? currentQueue;
        if (priorityDetail) { heldPriorityDetails++;
          await new Promise<void>(resolve => { releasePriorityDetail = resolve; }); }
        if (holdNextDetail) { holdNextDetail = false; heldDetails++;
          await new Promise<void>(resolve => { releaseHeldDetail = resolve; }); }
      }
      else if (url.pathname === `${p}/resident-queues/${queueId}/attempts`) value = currentAttempts;
      else if (url.pathname === `${p}/runtime`) value = {available:true,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/runtime/sessions`) value = [session];
      else if (url.pathname === `${p}/runtime/runs`) value = url.searchParams.get("taskId") === taskB ? [] : [currentRun];
      else if (url.pathname === `${p}/tasks/${taskA}` || url.pathname === `${p}/tasks/${taskB}` || url.pathname === `${p}/tasks/${taskC}`) {
        const item = url.pathname.endsWith(taskA) ? task(taskA,"先完成 A 的实际使用") : url.pathname.endsWith(taskB) ? task(taskB,"验收后才启动 B") : task(taskC,"核对下一顺位 C");
        taskReads.push(item.id);
        value = {task:item,revision:{...item,id:item.id,taskId:item.id,actorId:"lead",reason:"夹具",createdAt:stamp},basis:null,links:[],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname.startsWith(`${p}/tasks/`) && oldEntries.some(entry => url.pathname.endsWith(entry.id))) {
        const id = url.pathname.slice(`${p}/tasks/`.length);
        taskReads.push(id);
        const item = task(id,`历史任务 ${id.slice(-2)}`);
        value = {task:item,revision:{...item,id:item.id,taskId:item.id,actorId:"lead",reason:"夹具",createdAt:stamp},basis:null,links:[],impacts:[],decisions:[],deliveries:[],observations:[],closures:[]};
      }
      else if (url.pathname === `${p}/discussions`) {
        if (failDiscussions) { res.writeHead(503,{"content-type":"application/json"}); res.end(JSON.stringify({message:"协作暂不可读"})); return; }
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        value = longDiscussions ? {items:[],nextCursor:String(cursor + 1)} : page([discussion]);
      }
      else if (url.pathname === `${p}/discussions/${discussionId}`) value = discussion;
      else if (url.pathname === `${p}/discussions/${discussionId}/events`) value = events;
      else if (url.pathname.startsWith(`${p}/references/tasks/`)) value = [];
      else if (url.pathname === `${p}/orchestration/status`) value = {state:"active",running:false,busy:false,faults:[],lastError:null};
      else if (url.pathname === `${p}/orchestration/work-status`) value = {items:[]};
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    try {const body=await readFile(file);res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const pageBrowser=await browser.newPage({viewport:process.env.EVOLOOP_RESIDENT_VIEWPORT === "desktop" ? {width:1280,height:900} : {width:390,height:844}});
  const pageErrors:string[]=[]; pageBrowser.on("pageerror", error=>pageErrors.push(error.stack ?? error.message));
  await pageBrowser.goto(`${base}/#/p/${projectId}/roles`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button",{name:"进入",exact:true}).click();
  await pageBrowser.locator(`#role-${roleId} > summary`).getByText("业务职责").waitFor();
  await pageBrowser.locator(`#role-${systemRoleId} > summary`).getByText("系统职责").waitFor();
  await pageBrowser.locator(`#role-${legacyRoleId} > summary`).getByText("分类未登记").waitFor();
  await pageBrowser.locator(`#role-${roleId} > summary`).click();
  await pageBrowser.locator(`#role-${roleId}`).getByText("承载与业务领域").click();
  await pageBrowser.getByText("外部 Codex Desktop 宿主").waitFor();
  const externalCard=pageBrowser.locator(".role-presence-item").filter({hasText:"外部 Codex Desktop 宿主"});
  assert.match(await externalCard.innerText(),/声称能力：.*启动/);
  assert.equal(await externalCard.locator("p").filter({hasText:"已核能力："}).innerText(),"已核能力：打开、读取、人工领取");
  await pageBrowser.getByRole("button",{name:"核对当前路由"}).click();
  await pageBrowser.getByText(/外部宿主需人工领取/).waitFor();
  if (process.env.EVOLOOP_RESIDENT_ROLE_SCREENSHOT) {
    await pageBrowser.addStyleTag({content:".workspace-header{position:static!important}"});
    await pageBrowser.locator(".role-presence").screenshot({path:process.env.EVOLOOP_RESIDENT_ROLE_SCREENSHOT});
  }
  await fetch(`${base}/__fixture/hold-next-route`);
  await pageBrowser.getByRole("button",{name:"核对当前路由"}).click();
  for (let attempt=0; attempt<20 && await (await fetch(`${base}/__fixture/held-route-count`)).text() !== "1"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-route-count`)).text(),"1");
  await fetch(`${base}/__fixture/revoke-route`);
  await pageBrowser.locator(".role-presence-head button").click();
  await pageBrowser.locator(".role-presence-item").filter({hasText:"外部 Codex Desktop 宿主"}).getByText("已撤权").waitFor();
  await fetch(`${base}/__fixture/fail-presence-list`);
  await pageBrowser.locator(".role-presence-head button").click();
  await pageBrowser.getByText(/读取失败：承载暂不可读/).waitFor();
  const delayedRouteResponse = pageBrowser.waitForResponse(response => response.url().endsWith(`/domains/${domainId}/route`) && response.status() === 200, {timeout:3000});
  await fetch(`${base}/__fixture/release-held-route`);
  await delayedRouteResponse;
  await pageBrowser.waitForTimeout(100);
  assert.equal(await pageBrowser.getByText(/自有会话可承接/).count(),0);
  assert.match(await pageBrowser.locator(`#role-${roleId} .role-presence`).innerText(),/读取失败：承载暂不可读/);
  await pageBrowser.getByRole("link",{name:"打开 Session 与原线程历史"}).click();
  await pageBrowser.locator(`#runtime-session-${sessionId}[open]`).waitFor();
  if (await pageBrowser.locator(".resident-queue-card").getAttribute("open") === null)
    await pageBrowser.locator(".resident-queue-card > summary").click();
  await pageBrowser.locator(".resident-queue-meta").getByText(/累计尝试 1/).waitFor();
  const queueItems=pageBrowser.locator(".resident-queue-session li");
  assert.equal(await queueItems.count(),3);
  await queueItems.nth(0).getByRole("link",{name:"先完成 A 的实际使用"}).waitFor();
  await queueItems.nth(1).getByRole("link",{name:"验收后才启动 B"}).waitFor();
  assert.match(await queueItems.nth(0).innerText(),/承接职责 实际开发流程/);
  assert.match(await pageBrowser.locator(".resident-queue-session h4").innerText(),/就绪/);
  assert.match(await queueItems.nth(0).innerText(),/已领取／占用.*已读运行状态 running/s);
  assert.match(await queueItems.nth(1).innerText(),/等待前项放行/);
  assert.equal(await pageBrowser.locator(".resident-queues").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if (process.env.EVOLOOP_RESIDENT_QUEUE_SCREENSHOT) {
    await pageBrowser.addStyleTag({content:".workspace-header{position:static!important}"});
    await pageBrowser.locator(".resident-queues").screenshot({path:process.env.EVOLOOP_RESIDENT_QUEUE_SCREENSHOT});
  }
  await fetch(`${base}/__fixture/terminal-run`);
  await pageBrowser.getByRole("button",{name:"读取运行状态"}).click();
  await queueItems.nth(0).getByText(/本轮运行已结束，仍占用 Session/).waitFor();
  assert.match(await queueItems.nth(0).innerText(),/已领取／占用.*等待消费者使用与验收/s);
  assert.match(await queueItems.nth(0).innerText(),/本轮运行已结束，仍占用 Session；等待交付／验收或明确接续/);
  assert.doesNotMatch(await queueItems.nth(1).innerText(),/running|已读运行状态/);
  assert.match(await queueItems.nth(2).innerText(),/暂停.*运行结果未知.*原操作 ID 尚待核对/s);
  assert.equal(await pageBrowser.locator(".resident-queues").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await fetch(`${base}/__fixture/hold-next-role`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  for (let attempt=0; attempt<30 && await (await fetch(`${base}/__fixture/held-role-count`)).text() !== "1"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-role-count`)).text(),"1");
  await fetch(`${base}/__fixture/rename-role`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await queueItems.nth(0).getByText(/承接职责 已更新的承接职责/).waitFor();
  await fetch(`${base}/__fixture/release-held-role`);
  await pageBrowser.waitForTimeout(100);
  assert.match(await queueItems.nth(0).innerText(),/承接职责 已更新的承接职责/);
  await fetch(`${base}/__fixture/fail-next-role`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await queueItems.nth(0).getByRole("link",{name:"职责 10000002"}).waitFor();
  await pageBrowser.getByText(/部分名称未读回/).waitFor();
  assert.match(await queueItems.nth(0).innerText(),/承接职责 职责 10000002/);
  await fetch(`${base}/__fixture/restore-role`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await queueItems.nth(0).getByText(/承接职责 已更新的承接职责/).waitFor();
  await fetch(`${base}/__fixture/hold-next-role`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  for (let attempt=0; attempt<30 && await (await fetch(`${base}/__fixture/held-role-count`)).text() !== "2"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-role-count`)).text(),"2");
  const missingSession = "20000003-0000-4000-8000-000000000003";
  await pageBrowser.evaluate(hash => { window.location.hash = hash; },`#/p/${projectId}/runtime?session=${missingSession}`);
  await pageBrowser.getByText(/当前项目未读到目标 Session/).waitFor();
  await fetch(`${base}/__fixture/release-held-role`);
  await pageBrowser.waitForTimeout(100);
  assert.equal(await pageBrowser.locator(".resident-queues").count(),0);
  await pageBrowser.evaluate(hash => { window.location.hash = hash; },`#/p/${projectId}/runtime?session=${sessionId}`);
  await queueItems.nth(0).getByText(/承接职责 已更新的承接职责/).waitFor();
  await fetch(`${base}/__fixture/deep-queue`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await pageBrowser.getByText(/本轮优先核对当前占用与各 Session 下一顺位，最多 24 项名称/).waitFor();
  await pageBrowser.getByText(/当前占用：先完成 A 的实际使用/).waitFor();
  await pageBrowser.getByText(/后续顺位：验收后才启动 B/).waitFor();
  const deepItems = pageBrowser.locator(".resident-queue-session li");
  assert.equal(await deepItems.count(),27);
  await deepItems.nth(24).getByRole("link",{name:"先完成 A 的实际使用"}).waitFor();
  await deepItems.nth(25).getByRole("link",{name:"验收后才启动 B"}).waitFor();
  await deepItems.nth(21).getByRole("link",{name:"历史任务 21"}).waitFor();
  const lookedUp = await (await fetch(`${base}/__fixture/task-reads`)).json() as string[];
  const deepLookups = lookedUp.filter(id => id === taskA || id === taskB || oldEntries.some(entry => entry.id === id));
  assert.ok(deepLookups.includes(taskA) && deepLookups.includes(taskB));
  assert.equal(new Set(deepLookups).size,24);
  assert.equal(deepLookups.includes(oldEntries[22]!.id) || deepLookups.includes(oldEntries[23]!.id),false);
  await fetch(`${base}/__fixture/reset-task-reads`);
  await fetch(`${base}/__fixture/priority-detail`);
  await pageBrowser.getByRole("button",{name:"回读详情与尝试"}).click();
  for (let attempt=0; attempt<30 && await (await fetch(`${base}/__fixture/held-priority-detail-count`)).text() !== "1"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-priority-detail-count`)).text(),"1");
  await deepItems.nth(21).getByRole("link",{name:"历史任务 21"}).waitFor();
  assert.equal((await (await fetch(`${base}/__fixture/task-reads`)).json() as string[]).includes(taskC),false);
  await fetch(`${base}/__fixture/release-priority-detail`);
  await pageBrowser.getByText(/后续顺位：核对下一顺位 C/).waitFor();
  await deepItems.nth(26).getByRole("link",{name:"核对下一顺位 C"}).waitFor();
  assert.ok((await (await fetch(`${base}/__fixture/task-reads`)).json() as string[]).includes(taskC));
  await fetch(`${base}/__fixture/restore-queue`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await pageBrowser.locator(".resident-queue-session li").nth(3).waitFor({state:"detached"});
  await fetch(`${base}/__fixture/hold-next-detail`);
  await pageBrowser.getByRole("button",{name:"回读详情与尝试"}).click();
  for (let attempt=0; attempt<20 && await (await fetch(`${base}/__fixture/held-detail-count`)).text() !== "1"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-detail-count`)).text(),"1");
  await fetch(`${base}/__fixture/advance-queue`);
  await pageBrowser.getByRole("button",{name:"重新读取队列"}).click();
  await pageBrowser.locator(".resident-queue-meta").getByText(/累计尝试 2/).waitFor();
  await pageBrowser.getByText(/当前占用：验收后才启动 B/).waitFor();
  assert.match(await queueItems.nth(0).innerText(),/已放行/);
  assert.match(await queueItems.nth(1).innerText(),/已领取／占用/);
  assert.equal(await pageBrowser.locator(".resident-queue-card").getAttribute("open"),"");
  await fetch(`${base}/__fixture/release-held-detail`);
  await pageBrowser.waitForTimeout(100);
  assert.match(await queueItems.nth(1).innerText(),/已领取／占用/);
  assert.match(await pageBrowser.locator(".resident-queue-meta").innerText(),/累计尝试 2/);
  await queueItems.nth(0).getByRole("link",{name:/最近 Run/}).click();
  await pageBrowser.locator(`#runtime-run-${taskA}-${runA}[open]`).waitFor();
  await pageBrowser.locator(".task-collaboration-thread > summary").waitFor({timeout:5000}).catch(async () => {
    assert.fail(`Task collaboration missing: ${await pageBrowser.locator("body").innerText()} ${pageErrors.join(" | ")}`);
  });
  await pageBrowser.locator(".task-collaboration-thread > summary").click();
  await pageBrowser.getByText(/提问 · 致 lead · 已答复/).waitFor();
  await pageBrowser.getByText(/已记录采用至 Run/).waitFor();
  await pageBrowser.getByText(/工程动作请求 · pr.merge · 有独立执行回执，结果另核/).waitFor();
  await pageBrowser.getByText(/工程动作决定 · 批准/).waitFor();
  await pageBrowser.getByText(/工程动作执行回执 · 结果未知/).waitFor();
  await pageBrowser.getByText(/稳定操作 ID/).waitFor();
  assert.equal(await pageBrowser.locator(".task-collaboration").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if (process.env.EVOLOOP_RESIDENT_SCREENSHOT) {
    await pageBrowser.addStyleTag({content:".workspace-header{position:static!important}"});
    await pageBrowser.locator(".task-collaboration").screenshot({path:process.env.EVOLOOP_RESIDENT_SCREENSHOT});
  }
  await fetch(`${base}/__fixture/fail-discussions`);
  await pageBrowser.getByRole("button",{name:"重新读取协作"}).click();
  await pageBrowser.getByText(/协作读取未完成.*上次读回/).waitFor();
  assert.equal(await pageBrowser.getByText(/提问 · 致 lead · 已答复/).count(),1);
  await fetch(`${base}/__fixture/long-discussions`);
  await pageBrowser.evaluate(({projectId,taskB})=>{location.hash=`#/p/${projectId}/tasks/${taskB}?tab=runtime`;},{projectId,taskB});
  await pageBrowser.getByText(/协作列表已达 20 页或 20 个关联频道上限/).waitFor();
  assert.equal(await pageBrowser.getByText("当前没有已登记的任务协作频道。").count(),0);
});
