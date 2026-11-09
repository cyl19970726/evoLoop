// Opt-in built-app regression for the task page's five detail tabs (docs/frontend/pages/tasks.md): 依据与影响 handles
// one basis change on its own; 交付与使用 keeps each delivery's check, source run and use apart; 运行与关联 confirms an
// assignment, holds a queue entry and opens one run from its link; 历史 opens a fixed revision read only with one way
// back; 任务操作 shows only what this identity may do now and refuses a form whose baseline moved. Reads that fail
// say they cannot tell, at 1440, 1024 (right column as a drawer) and 390 (no sideways scroll).
// EVOLOOP_TASK_TABS_SCREENSHOT_DIR=<dir> saves one screenshot per tab and width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TASK_TABS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (prefix: string, tail = "000000000000") => `${prefix}-0000-4000-8000-${tail}`;
const projectId = id("33000001"), roleId = id("33000002"), sessionId = id("33000003");
const [taskA, taskC, taskD] = [id("33000010"), id("33000012"), id("33000013")];
const [docMain, docSpec] = [id("33000020"), id("33000021")];
const [revMain, revSpecOld, revSpecNew] = [id("33000030"), id("33000031"), id("33000032")];
const taskRev = (n: number) => id("33000040", String(n).padStart(12, "0"));
const [deliveryOld, deliveryNew, runId, queueId, entryA, entryC, impactId, basisId, entryD] =
  [id("33000050"), id("33000051"), id("33000060"), id("33000070"), id("33000071"), id("33000072"), id("33000080"), id("33000090"), id("33000073")];
const stamp = "2026-11-09T00:00:00.000Z";

test("the task page's five tabs read, write and refuse as the record allows, at three widths", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE", timeout: 240_000,
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let version = 3;
  let impactState = "pending";
  let assignmentState = "assigned", assignmentVersion = 2;
  let entryCState = "queued";
  // The queue starts with its current order not adopted; adopting does not change its version, reordering does.
  let queueVersion = 2, queueAdopted: number | null = 1, queueOrder = [entryA, entryC, entryD];
  const failing = new Set<string>();
  const commands: Record<string, unknown>[] = [];
  const leaderWrites: { path: string; body: Record<string, unknown> }[] = [];
  const task = () => ({ projectId, id: taskA, version, currentRevisionId: taskRev(version), title, content: "# 目标\n把五个页签改成新组件。",
    contentDocumentId: docMain, contentRevisionId: revMain, kind: "implementation", acceptance: "1. 页签可用。2. 写入带基线。", owner: roleId, state: "in_progress" });
  const other = { projectId, id: taskC, version: 1, currentRevisionId: taskRev(9), title: "乙：排队的后续任务", content: "后续", contentDocumentId: docMain,
    contentRevisionId: revMain, kind: "implementation", acceptance: "后续验收", owner: roleId, state: "todo" };
  const later = { ...other, id: taskD, currentRevisionId: taskRev(8), title: "丙：再后面的任务" };
  let title = "甲：重写任务页签";
  const revision = (n: number) => ({ ...task(), taskId: taskA, id: taskRev(n), version: n, state: n === 1 ? "todo" : "in_progress", basisSetId: basisId,
    actorId: "lead", reason: n === 1 ? "创建" : n === 2 ? "开始执行" : `第 ${n} 版的复核`, createdAt: stamp, content: `第 ${n} 版正文` });
  const basis = (n: number) => ({ projectId, taskId: taskA, taskRevisionId: taskRev(n), id: basisId, sealed: true,
    members: [{ documentId: docMain, revisionId: revMain }, { documentId: docSpec, revisionId: revSpecOld }] });
  const detail = () => ({ task: task(), revision: revision(version), basis: basis(version), links: [],
    impacts: [{ projectId, id: impactId, taskId: taskA, taskRevisionId: taskRev(version), documentId: docSpec, fromRevisionId: revSpecOld, toRevisionId: revSpecNew,
      state: impactState, decisionId: null, createdAt: stamp }],
    decisions: impactState === "resolved" ? [{ projectId, id: id("33000081"), impactId, taskId: taskA, previousTaskRevisionId: taskRev(version - 1),
      nextTaskRevisionId: taskRev(version), decision: "retain", reason: "旧版仍适用", actorId: "reader", createdAt: stamp }] : [],
    proposal: { projectId, taskId: taskA, taskRevisionId: taskRev(version), stageId: null, consumer: "qa-agent", useRequired: true,
      acceptanceMode: "independent_agent", evidence: "来自需求会话", stopCondition: "范围变化时停止", createdAt: stamp },
    judgements: [],
    deliveries: [
      { projectId, id: deliveryOld, taskId: taskA, taskRevisionId: taskRev(1), runId: null, artifactRef: "https://git.example/pr/41", artifactRevision: "a1",
        contentHash: "a".repeat(64), technicalResult: "failed", technicalEvidence: "旧交付的检查没有通过", reason: "第一次", actorId: "worker", createdAt: stamp },
      { projectId, id: deliveryNew, taskId: taskA, taskRevisionId: taskRev(version), runId, submittedByActorId: "worker", artifactRef: "https://git.example/pr/42",
        artifactRevision: "b2", contentHash: "b".repeat(64), technicalResult: "passed", technicalEvidence: "构建与浏览器测试通过", reason: "第二次", actorId: "worker", createdAt: stamp }],
    observations: [{ projectId, id: id("33000052"), taskId: taskA, deliveryId: deliveryNew, observer: "qa-agent", observerKind: "agent", result: "used",
      evidence: "实际打开了五个页签", reason: "验收使用", actorId: "qa-agent", createdAt: stamp }],
    closures: [] });
  const projection = () => ({ kind: "task", taskId: taskA, version, currentRevisionId: taskRev(version), workChangeSequence: 5, title: task().title,
    taskKind: "implementation", taskState: "in_progress", phase: "awaiting_acceptance", nextAction: "agent text", responsible: { kind: "consumer", id: "qa-agent", label: "x" },
    assignment: { targetKind: "owned", targetId: sessionId, state: assignmentState, recipientActorId: "worker" }, latestRun: { runId, state: "completed" },
    delivery: null, pendingImpactCount: impactState === "pending" ? 1 : 0, queueHold: null, goal: null, stage: null,
    plan: { plannedStartAt: null, dueAt: null, priority: 2, version: 1, actorId: "lead", updatedAt: stamp }, dependencies: [], dependencyVersion: 0, review: null,
    dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp }, timing: null, actionKey: `task:${taskA}` });
  const documents: Record<string, { title: string; current: string; body: Record<string, string> }> = {
    [docMain]: { title: "甲的主正文", current: revMain, body: { [revMain]: "# 目标\n甲的正文。" } },
    [docSpec]: { title: "页签规范", current: revSpecNew, body: { [revSpecOld]: "## 规范\n旧版：页签只读。", [revSpecNew]: "## 规范\n新版：页签可写。" } },
  };
  const run = { projectId, id: runId, taskId: taskA, taskRevisionId: taskRev(3), basisSetId: basisId, sessionId, operationId: id("33000061"), input: "实现", inputHash: "h",
    state: "completed", version: 3, nativeTurnId: "turn-1", interruptRequested: false, resultSummary: "已完成五个页签", actorId: "lead", createdAt: stamp, updatedAt: stamp };
  const entry = (entryId: string, taskId: string, position: number, state: string) => ({ projectId, queueId, id: entryId, taskId, taskRevisionId: taskId === taskA ? taskRev(3) : taskRev(9),
    sourceInputJson: "{}", sessionId, roleId, position, dependsOn: [], consumerId: "qa-agent", useRequired: true, releaseRule: "accepted", state,
    holdCode: state === "held" ? "manual_review" : null, holdReason: state === "held" ? "等人工复核" : null, claimId: state === "claimed" ? "c1" : null, version: 4 });
  const queue = () => ({ projectId, id: queueId, version: queueVersion, adoptedVersion: queueAdopted, maxRuns: 3, reason: "按验收顺序", actorId: "lead",
    entries: [entry(entryA, taskA, queueOrder.indexOf(entryA), "claimed"), entry(entryC, taskC, queueOrder.indexOf(entryC), entryCState),
      entry(entryD, taskD, queueOrder.indexOf(entryD), "queued")] });
  const agent = { key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [], title: "开发智能体", profile: { displayName: "开发智能体" }, identity: null,
    kind: "owned", roles: [{ id: roleId, title: "开发" }], membership: "current", capabilities: { observe: { available: true, reason: null } } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/__fixture/")) {
      const what = url.searchParams.get("what") ?? "";
      if (url.pathname === "/__fixture/fail") failing.add(what);
      if (url.pathname === "/__fixture/recover") failing.delete(what);
      if (url.pathname === "/__fixture/bump") version += 1;
      res.end("ok"); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      try {
        const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
        res.end(await readFile(join(dist, file)));
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    const root = `/api/projects/${projectId}`;
    const path = decodeURIComponent(url.pathname);
    const reader = /readonly/.test(req.headers.authorization ?? "");
    let value: unknown = { items: [], nextCursor: null }, status = 200;
    const fail = (what: string) => { if (failing.has(what)) { status = 503; value = { message: `${what} 暂不可读（夹具）` }; return true; } return false; };
    let body: Record<string, unknown> = {};
    if (req.method === "POST" || req.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    }
    if (path === "/api/session") value = { principal: { actorId: reader ? "viewer" : "reader", projectIds: [projectId],
      permissions: reader ? ["read"] : ["read", "write", "review"], identityKind: "human" }, capabilities: {} };
    else if (path === root) value = { id: projectId, title: "页签夹具", createdAt: stamp };
    else if (path === `${root}/tasks`) value = { items: [task(), other, later], nextCursor: null };
    else if (path === `${root}/orchestration/work-status`) value = { items: [taskA, taskC].map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
    else if (path === `${root}/work-management/index`) value = { items: [projection()], nextCursor: null, total: 1, counts: { awaiting_acceptance: 1 }, changeSequence: 5, observedAt: stamp, partial: false };
    else if (path === `${root}/work-management/tasks/${taskA}`) value = projection();
    else if (path.startsWith(`${root}/work-management/tasks/`) && req.method === "PUT") {
      leaderWrites.push({ path: path.slice(root.length), body });
      value = { operationId: body.operationId, status: "applied", entityId: taskA, version: 2 };
    }
    else if (path.startsWith(`${root}/work-management/tasks/`)) { status = 404; value = { message: "未登记" }; }
    else if (path === `${root}/tasks/${taskA}`) { if (!fail("task")) value = detail(); }
    else if (path === `${root}/tasks/${taskC}` || path === `${root}/tasks/${taskD}`) {
      const item = path.endsWith(taskC) ? other : later;
      value = { ...detail(), task: item, revision: { ...item, taskId: item.id, id: item.currentRevisionId }, impacts: [], deliveries: [], observations: [] };
    }
    else if (path === `${root}/tasks/${taskA}/revisions`) { if (!fail("revisions")) value = Array.from({ length: version }, (_, index) => ({ revision: revision(index + 1), basis: basis(index + 1) })); }
    else if (path.startsWith(`${root}/tasks/${taskA}/revisions/`)) { const n = Number(path.slice(-1)); value = { revision: revision(n), basis: basis(n) }; }
    else if (path === `${root}/tasks/${taskA}/timing`) { if (!fail("timing")) value = { projectId, taskId: taskA, seriesId: id("33000100"), rootTaskId: taskA, version: 4,
      executeAtUtc: "2026-11-11T01:00:00.000Z", timezone: "Asia/Shanghai", repeat: "daily", seriesState: "active", previousTaskId: null, nextTaskId: null,
      nextAtUtc: "2026-11-12T01:00:00.000Z", waitingReason: null, futureTemplate: { title: "每日核对", content: "核对正文", acceptance: "核对验收" }, occurrences: [] }; }
    else if (path === `${root}/tasks/${taskA}/assignment`) { if (!fail("assignment")) value = { projectId, taskId: taskA, version: assignmentVersion, taskRevisionId: taskRev(version),
      target: { kind: "owned", sessionId }, recipientActorId: "worker", state: assignmentState,
      ack: assignmentState === "accepted" ? { method: "lead-observed", actorId: null, observerActorId: "reader", evidence: "看到它开始了", sourceRef: null, at: stamp } : null,
      actorId: "lead", reason: "按职责分派", updatedAt: stamp }; }
    else if (path === `${root}/tasks/${taskA}/assignment/history`) value = { items: [], nextCursor: null };
    else if (path === `${root}/tasks/${taskA}/attention`) value = { followUp: null, followUpHistory: [], items: [], itemsNextCursor: null };
    else if (path === `${root}/tasks/${taskA}/acceptance-relay`) value = { items: [{ relayId: id("33000110"), version: 1, operationId: "o", supersedesRelayId: null, arrangedBy: "lead",
      taskId: taskA, taskRevisionId: taskRev(3), deliveryId: deliveryNew, stage: "candidate", scopeKey: "tabs", scopeDescription: "五个页签的读写", entrypoint: null,
      publicationRef: null, reason: "验收", mode: "session", recipientActorId: "qa-agent", sessionId: null, roleId: null, senderActorId: "lead", state: "linked", blockedReason: null,
      messageId: "m", messageOperationId: "mo", messageState: "replied", processingState: "completed", nativeTurnId: null, readActorId: "qa-agent", humanReadAt: null,
      observationId: "obs", observationResult: "used", observationActorId: "qa-agent", evidenceLevel: null, independenceEvidence: "distinct_runtime_session", createdAt: stamp, updatedAt: stamp }] };
    else if (path.startsWith(`${root}/documents/`)) {
      const [documentId, , revisionId] = path.slice(`${root}/documents/`.length).split("/");
      const document = documents[documentId!];
      const revisionOf = (rev: string) => ({ projectId, documentId, id: rev, body: document!.body[rev], format: "markdown", mediaType: "text/markdown", originalName: "doc.md",
        payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "c".repeat(64), author: "writer", createdAt: stamp, previousRevisionId: null, reason: "夹具" });
      if (!document) { status = 404; value = { message: "无此文档" }; }
      else value = revisionId ? revisionOf(revisionId) : { document: { projectId, id: documentId, title: document.title, version: 1, currentRevisionId: document.current,
        adoptedRevisionId: document.current, kind: "spec", status: "published" }, current: revisionOf(document.current), adopted: revisionOf(document.current) };
    }
    else if (path === `${root}/session-work`) value = { items: [agent], nextCursor: null };
    else if (path === `${root}/session-work/owned:${sessionId}`) value = { session: agent };
    else if (path === `${root}/roles`) value = { items: [{ projectId, id: roleId, state: "active", proposal: { title: "开发" } }], nextCursor: null };
    else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, state: "active", proposal: { title: "开发" } };
    else if (path === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
    else if (path === `${root}/runtime/sessions`) value = [{ projectId, id: sessionId, roleId, cwd: "/w", authorizationScope: "s", model: null, sandbox: "danger-full-access",
      approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: "thread", nativeSessionId: null, operationId: "op", actorId: "lead", createdAt: stamp, updatedAt: stamp,
      executionProfile: { activationState: "active", activeRevisionId: "profile-1", revision: { revisionId: "profile-1", version: 1, sandbox: "danger-full-access",
        approvalPolicy: "never", model: null, cwd: "/w", authorizationScope: "s" } } }];
    else if (path === `${root}/runtime/runs`) { if (!fail("runs")) value = url.searchParams.get("taskId") === taskA ? [run] : []; }
    else if (path === `${root}/runtime/runs/${runId}`) value = run;
    else if (path === `${root}/runtime/runs/${runId}/events`) value = [{ id: "e1", kind: "run.completed", detail: "运行结束，等待交付", actorId: "runtime", createdAt: stamp }];
    else if (path === `${root}/resident-queues`) { if (!fail("queues")) value = [queue()]; }
    else if (path === `${root}/resident-queues/${queueId}`) value = queue();
    else if (path === `${root}/resident-queues/${queueId}/attempts`) value = [{ entryId: entryA, claimId: "c1", attempts: [{ projectId, claimId: "c1", sequence: 1, runId,
      operationId: "op", taskRevisionId: taskRev(3), actualRunTaskRevisionId: taskRev(3), reservedAt: stamp }] }];
    else if (path.startsWith(`${root}/references/tasks/`)) value = [];
    else if (path === "/api/commands" && req.method === "POST") {
      commands.push(body);
      if (body.type === "task.reviewBasis") { impactState = "resolved"; version += 1; }
      if (body.type === "task.assignment.observeAcceptance") { assignmentState = "accepted"; assignmentVersion += 1; }
      if (body.type === "queue.hold") entryCState = "held";
      if (body.type === "queue.adopt") queueAdopted = queueVersion;
      if (body.type === "queue.reorder") { queueOrder = body.entryIds as string[]; queueVersion += 1; }
      if (body.type === "task.update") { title = String(body.title); version += 1; }
      value = { operationId: body.operationId, status: "applied", entityId: taskA, version };
    }
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = (path: string) => fetch(`${base}/__fixture/${path}`);
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const errors: string[] = [];
  const open = async (token: string) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${base}/p/${projectId}/tasks/${taskA}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { level: 1, name: "甲：重写任务页签" }).waitFor();
    return page;
  };
  const page = await open("fixture-token");
  const center = page.locator(`[data-task-page="${taskA}"]`);
  const tab = async (name: string) => {
    await center.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    await center.getByRole("tab", { name: new RegExp(`^${name}`), selected: true }).waitFor();
    return center.getByRole("tabpanel").filter({ visible: true });
  };
  const noSideways = async (label: string) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${label}: no sideways page scroll (${overflow}px)`);
  };

  // 依据与影响: the fixed basis says which document has a newer version; the change is read in two versions and kept.
  let panel = await tab("依据与影响");
  await panel.getByText("已有新版").waitFor();
  const impact = panel.locator(`[data-impact="${impactId}"]`);
  await impact.locator("[data-impact-compare]").getByText("旧版：页签只读。").first().waitFor();
  await impact.locator("[data-impact-compare]").getByText("新版：页签可写。").first().waitFor();
  await impact.getByText("决定采用新版或保留旧版").click();
  await impact.getByLabel("保留任务固定的旧版").check();
  await impact.getByLabel("理由").fill("旧版仍适用");
  await impact.getByRole("button", { name: "提交复核决定" }).click();
  await panel.getByText("当前没有待复核的依据变化。").waitFor();
  const review = commands.find(command => command.type === "task.reviewBasis")!;
  assert.deepEqual({ expectedVersion: review.expectedVersion, impactId: review.impactId, decision: review.decision, reason: review.reason },
    { expectedVersion: 3, impactId, decision: "retain", reason: "旧版仍适用" });
  await panel.getByText(/页签规范 · 保留了旧版/).waitFor();

  // 交付与使用: newest first; the old failed check stays with its own delivery; the source run is checked before it links.
  panel = await tab("交付与使用");
  const latest = panel.locator(`[data-delivery="${deliveryNew}"]`);
  await latest.getByText("技术检查通过").waitFor();
  await latest.getByRole("link", { name: "核对这次运行 →" }).waitFor();
  assert.equal(await latest.getByRole("link", { name: "核对这次运行 →" }).getAttribute("href"), `/p/${projectId}/tasks/${taskA}?tab=runtime&run=${runId}`);
  assert.match(await latest.innerText(), /qa-agent · 登记为智能体 · 已使用/);
  assert.match(await panel.locator(`[data-delivery="${deliveryOld}"]`).innerText(), /历史交付[\s\S]*技术检查未通过[\s\S]*尚无这次交付的使用观察/);
  await panel.getByText(/候选验收 · 消息已入队 · 交给业务智能体/).waitFor();
  assert.doesNotMatch(await panel.innerText(), /Run|Session/);

  // 运行与关联: the assignment is confirmed by the lead's observation; a queued entry is held; the run opens from its link.
  panel = await tab("运行与关联");
  const assignment = panel.locator("[data-assignment]");
  await assignment.getByText("已分派，待确认接手").waitFor();
  await assignment.getByText("记录负责人观察到接手").click();
  await assignment.getByLabel("实际观察与证据").fill("看到它开始了");
  await assignment.getByRole("button", { name: "记录观察" }).click();
  await assignment.getByText("已接手", { exact: true }).waitFor();
  const observed = commands.find(command => command.type === "task.assignment.observeAcceptance")!;
  assert.deepEqual({ expectedVersion: observed.expectedVersion, expectedTaskVersion: observed.expectedTaskVersion }, { expectedVersion: 2, expectedTaskVersion: 4 });
  const queuePanel = panel.locator("[data-queue-panel]");
  await queuePanel.locator(`[data-queue-entry="${entryA}"]`).getByText("已领取／占用").waitFor();
  const queued = queuePanel.locator(`[data-queue-entry="${entryC}"]`);
  await queued.getByText("乙：排队的后续任务").waitFor();
  await queued.getByText("暂停这一项").click();
  await queued.getByLabel("理由与依据").fill("先等验收");
  await queued.getByRole("button", { name: "暂停", exact: true }).click();
  await queued.getByText("等待人工复核：等人工复核").waitFor();
  assert.equal(commands.find(command => command.type === "queue.hold")!.entryId, entryC);
  assert.doesNotMatch(await queuePanel.innerText(), /Session|Run\b|queue/);
  // Adopting does not change the queue's version: the open queue still reads its detail again and drops the form.
  const queueCard = queuePanel.locator(`[data-queue="${queueId}"]`);
  await queueCard.getByText("已采纳第 1 版").waitFor();
  await queueCard.getByText("采纳当前顺序", { exact: true }).click();
  await queueCard.getByRole("button", { name: "采纳当前顺序" }).click();
  await queueCard.locator("summary").getByText("已采纳", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-queue]")?.textContent?.includes("采纳当前顺序"));
  assert.equal(commands.find(command => command.type === "queue.adopt")!.expectedVersion, 2);
  await queueCard.getByText("调整顺序", { exact: true }).click();
  const reorder = queueCard.getByRole("form", { name: "保存顺序" });
  await reorder.getByLabel("要提前的任务").selectOption({ label: "丙：再后面的任务 · 现在第 3 项" });
  await reorder.getByLabel("理由与依据").fill("丙更急");
  await reorder.getByRole("button", { name: "保存顺序" }).click();
  await queueCard.locator(`[data-queue-entry="${entryD}"]`).getByText("第 2 项").waitFor();
  const reordered = commands.find(command => command.type === "queue.reorder")!;
  assert.deepEqual({ expectedVersion: reordered.expectedVersion, entryIds: reordered.entryIds }, { expectedVersion: 2, entryIds: [entryA, entryD, entryC] });
  // The task is arranged on its agent (a one-task queue) and one run is reserved, both on the recorded versions.
  await panel.getByText("把任务排进具体智能体的队列", { exact: true }).click();
  const arrangeForm = panel.getByRole("form", { name: "创建队列" });
  await arrangeForm.getByLabel("承接的智能体").selectOption({ index: 1 });
  await arrangeForm.getByLabel("为什么安排给这个智能体").fill("它已接手");
  await arrangeForm.getByRole("button", { name: "创建队列" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "queue.create"); attempt++) await page.waitForTimeout(50);
  const created = commands.find(command => command.type === "queue.create")! as { entries: Record<string, unknown>[] };
  assert.deepEqual({ sessionId: created.entries[0]!.sessionId, taskRevisionId: created.entries[0]!.taskRevisionId }, { sessionId, taskRevisionId: taskRev(4) });
  await panel.getByText("派发这一次运行", { exact: true }).click();
  const reserveForm = panel.getByRole("form", { name: "派发运行" });
  await reserveForm.getByLabel("承接的智能体").selectOption({ index: 1 });
  await reserveForm.getByLabel("这一次的有界工作与停止条件").fill("只改依据页签，改完即停");
  await reserveForm.getByRole("button", { name: "派发运行" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "runtime.run.reserve"); attempt++) await page.waitForTimeout(50);
  const reserved = commands.find(command => command.type === "runtime.run.reserve")!;
  assert.deepEqual({ expectedVersion: reserved.expectedVersion, sessionId: reserved.sessionId }, { expectedVersion: 4, sessionId });
  // An old link form (#/p/…) is redirected like any address; it lands on the run and opens it.
  await page.evaluate(path => { location.hash = path; }, `/p/${projectId}/tasks/${taskA}?tab=runtime&run=${runId}`);
  await page.locator(`#runtime-run-${taskA}-${runId}[open]`).waitFor();
  await page.locator(`#runtime-run-${taskA}-${runId}`).getByRole("button", { name: "阅读运行、交接与审批回执" }).click();
  await page.getByText("运行结束，等待交付").waitFor();

  // 历史: the timeline lists every revision; an old one opens read only with one way back.
  panel = await tab("历史");
  const timeline = panel.getByRole("list", { name: "任务修订" });
  await timeline.locator(`[data-revision="${taskRev(1)}"]`).waitFor();
  assert.equal(await timeline.locator("[data-revision]").count(), version);
  await timeline.locator(`[data-revision="${taskRev(1)}"]`).getByRole("link", { name: "只读查看这一版" }).click();
  const fixed = page.locator("#task-fixed-revision");
  await fixed.getByRole("heading", { name: "固定历史任务修订" }).waitFor();
  await fixed.getByText("第 1 版正文").waitFor();
  assert.equal(await fixed.getByRole("button", { name: /提交|保存/ }).count(), 0, "a historical revision offers no writes");
  await fixed.getByRole("link", { name: "返回当前任务" }).click();
  await page.waitForFunction(() => !location.search.includes("revision="));

  // 任务操作: what this reviewer may do while the task is in progress; the Leader's plan keeps its recorded version.
  panel = await tab("任务操作");
  for (const title of ["更新任务内容", "提交新的交付", "记录本次交付的使用观察", "核对验收并关闭任务", "设置计划、截止与优先级", "停止以后重复", "取消任务", "返回待办以重新定界"])
    await panel.getByText(title, { exact: true }).first().waitFor();
  assert.equal(await panel.getByText("开始任务并固定依据").count(), 0, "starting is not offered while the task runs");
  await panel.getByText("设置计划、截止与优先级", { exact: true }).click();
  const plan = panel.getByRole("form", { name: "保存计划" });
  await plan.getByLabel("理由与依据").fill("下周交付");
  await plan.getByRole("button", { name: "保存计划" }).click();
  await plan.getByText(/已保存/).waitFor({ timeout: 10_000 }).catch(async () =>
    assert.fail(`plan not saved: ${await plan.innerText().catch(() => "form gone")} writes=${JSON.stringify(leaderWrites)} errors=${JSON.stringify(errors)}`));
  const planWrite = leaderWrites.find(write => write.path.endsWith("/plan"))!;
  assert.deepEqual({ type: planWrite.body.type, expectedTaskVersion: planWrite.body.expectedTaskVersion, expectedPlanVersion: planWrite.body.expectedPlanVersion, priority: planWrite.body.priority },
    { type: undefined, expectedTaskVersion: 4, expectedPlanVersion: 1, priority: 2 });
  await panel.getByText("设置前置任务依赖", { exact: true }).click();
  const dependencies = panel.getByRole("form", { name: "设置前置任务依赖" });
  await dependencies.getByLabel("从已载入的任务中添加").selectOption({ label: "乙：排队的后续任务" });
  await dependencies.getByRole("button", { name: "添加" }).first().click();
  await dependencies.getByRole("link", { name: "乙：排队的后续任务" }).waitFor();
  await dependencies.getByLabel("理由与依据").fill("乙要先验收");
  await dependencies.getByRole("button", { name: "保存前置任务" }).click();
  for (let attempt = 0; attempt < 50 && !leaderWrites.some(write => write.path.endsWith("/dependencies")); attempt++) await page.waitForTimeout(50);
  const dependencyWrite = leaderWrites.find(write => write.path.endsWith("/dependencies"))!.body;
  assert.deepEqual({ expectedTaskVersion: dependencyWrite.expectedTaskVersion, expectedDependencyVersion: dependencyWrite.expectedDependencyVersion, dependsOnTaskIds: dependencyWrite.dependsOnTaskIds },
    { expectedTaskVersion: 4, expectedDependencyVersion: 0, dependsOnTaskIds: [taskC] });
  await panel.getByText("调整执行时间与重复规则", { exact: true }).click();
  const timingForm = panel.getByRole("form", { name: "保存调整" });
  await timingForm.getByLabel("约定执行时间").fill("2026-11-12T09:00:00+08:00");
  await timingForm.getByLabel("调整理由").fill("改到早上");
  await timingForm.getByRole("button", { name: "保存调整" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "task.timing.set"); attempt++) await page.waitForTimeout(50);
  const timingWrite = commands.find(command => command.type === "task.timing.set")!;
  assert.deepEqual({ expectedTaskVersion: timingWrite.expectedTaskVersion, expectedTimingVersion: timingWrite.expectedTimingVersion, scope: timingWrite.scope, executeAtUtc: timingWrite.executeAtUtc },
    { expectedTaskVersion: 4, expectedTimingVersion: 4, scope: "future", executeAtUtc: "2026-11-12T01:00:00.000Z" }, "the task has started: only later occurrences change");
  // An untouched form follows newer content: nothing to keep, so it records the new version without asking.
  await panel.getByText("返回待办以重新定界", { exact: true }).click();
  const reopen = panel.getByRole("form", { name: "返回待办" });
  await reopen.waitFor();
  // A baseline that moves after the form opened refuses the submit until the person looks at the latest content.
  await panel.getByText("取消任务", { exact: true }).click();
  const cancel = panel.getByRole("form", { name: "取消任务" });
  await cancel.getByLabel("理由与依据").fill("范围已变");
  await fixture("bump");
  await center.getByRole("button", { name: "重新读取当前任务" }).click();
  await center.getByText("第 5 版", { exact: false }).first().waitFor();
  await cancel.getByText("打开表单后内容已被更新").waitFor();
  assert.equal(await cancel.getByRole("button", { name: "取消任务" }).isDisabled(), true);
  await cancel.getByRole("button", { name: "取消任务" }).click({ force: true });
  await page.waitForTimeout(200);
  assert.equal(commands.some(command => command.type === "task.cancel"), false, "nothing is sent while the version that was seen is not the current one");
  assert.equal(await reopen.getByText("打开表单后内容已被更新").count(), 0, "the untouched form followed the new version");
  await cancel.getByRole("button", { name: "保留我的修改" }).click();
  assert.equal(await cancel.getByLabel("理由与依据").inputValue(), "范围已变", "the person's reason is kept");
  await cancel.getByRole("button", { name: "取消任务" }).click();
  await cancel.getByText(/已保存/).waitFor();
  assert.equal(commands.find(command => command.type === "task.cancel")!.expectedVersion, 5);
  await reopen.getByLabel("理由与依据").fill("回到待办重新定界");
  await reopen.getByRole("button", { name: "返回待办" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "task.reopen"); attempt++) await page.waitForTimeout(50);
  assert.equal(commands.find(command => command.type === "task.reopen")!.expectedVersion, 5, "the form that followed sends the version on screen");
  // A write that is read back late: the reread fails, the person edits again, then someone else writes. The form asks.
  await panel.getByText("更新任务内容", { exact: true }).click();
  const update = panel.getByRole("form", { name: "保存任务内容" });
  await update.getByLabel("任务名称").fill("甲：重写任务页签（第二轮）");
  await update.getByLabel("理由与依据").fill("改名");
  await fixture("fail?what=task");
  await update.getByRole("button", { name: "保存任务内容" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "task.update"); attempt++) await page.waitForTimeout(50);
  assert.equal(commands.find(command => command.type === "task.update")!.expectedVersion, 5);
  await center.getByText(/当前任务回读失败/).first().waitFor();
  await update.getByLabel("任务名称").fill("甲：又改了一次名");
  await fixture("bump"); await fixture("recover?what=task");
  await center.getByRole("button", { name: "重新读取当前任务" }).click();
  await center.getByText("第 7 版", { exact: false }).first().waitFor();
  await update.getByText("打开表单后内容已被更新").waitFor();
  assert.equal(await update.getByRole("button", { name: "保存任务内容" }).isDisabled(), true, "the edit is not sent on a version it was not written against");
  // Someone else renamed the task too: the name is decided field by field, never kept in one click.
  await update.getByRole("radiogroup", { name: "任务名称用哪一版" }).waitFor();
  assert.equal(await update.getByRole("button", { name: "保留我的修改" }).count(), 0);
  assert.equal(await update.getByLabel("任务名称", { exact: true }).inputValue(), "甲：又改了一次名");
  assert.equal(commands.filter(command => command.type === "task.update").length, 1);
  const stop = panel.getByRole("form", { name: "停止以后重复" });
  await panel.getByText("停止以后重复", { exact: true }).click();
  await stop.getByLabel("停止理由").fill("不再需要每日核对");
  await stop.getByRole("button", { name: "停止以后重复" }).click();
  for (let attempt = 0; attempt < 50 && !commands.some(command => command.type === "task.timing.stop"); attempt++) await page.waitForTimeout(50);
  assert.equal(commands.find(command => command.type === "task.timing.stop")!.expectedTimingVersion, 4);

  // Failed reads say they cannot tell; they never become "没有".
  await fixture("fail?what=assignment"); await fixture("fail?what=queues"); await fixture("fail?what=revisions"); await fixture("fail?what=timing");
  await center.getByRole("button", { name: "重新读取当前任务" }).click();
  panel = await tab("运行与关联");
  await panel.locator("[data-assignment]").getByText(/重新读取分派失败|分派暂不可读取/).waitFor();
  assert.equal(await panel.locator("[data-assignment]").getByRole("button", { name: /更换智能体|指定智能体/ }).count(), 0, "no binding from an unconfirmed read");
  await panel.getByText(/执行队列暂不可读取|上次读回，当前待核对/).first().waitFor();
  assert.doesNotMatch(await panel.innerText(), /还没有指定具体的智能体|这项任务还不在已登记的执行队列里/);
  panel = await tab("历史");
  await panel.getByText(/修订历史暂不可读取|上次读回，当前待核对/).first().waitFor();
  panel = await tab("任务操作");
  await panel.getByText(/执行时间暂不可读取|上次读回，当前待核对/).first().waitFor();
  assert.doesNotMatch(await panel.innerText(), /这项任务没有约定执行时间/);
  for (const what of ["assignment", "queues", "revisions", "timing"]) await fixture(`recover?what=${what}`);
  await center.getByRole("button", { name: "重新读取当前任务" }).click();
  await panel.getByText("本次约定执行").waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("上次读回，当前待核对"));

  // Three widths: the right column is beside the task at 1440, a closed drawer at 1024, and nothing scrolls sideways at 390.
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const name of ["依据与影响", "交付与使用", "运行与关联", "历史", "任务操作"]) {
      await tab(name);
      await page.waitForTimeout(150);
      await noSideways(`${width} ${name}`);
      if (shots) await page.screenshot({ path: `${shots}/task-tab-${name}-${width}.png`, fullPage: false });
    }
    const drawer = await page.getByRole("button", { name: "任务信息" }).isVisible();
    assert.equal(drawer, width < 1100, `${width}: the right column ${width < 1100 ? "opens from 任务信息" : "sits beside the task"}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // A reader sees the records and no forms: the actions it may not take are counted, not listed.
  const viewer = await open("readonly-token");
  const viewerCenter = viewer.locator(`[data-task-page="${taskA}"]`);
  await viewerCenter.getByRole("tab", { name: /^任务操作/ }).click();
  const actions = viewerCenter.getByRole("tabpanel").filter({ visible: true });
  await actions.getByText(/另有 \d+ 项操作需要写入或审阅权限/).waitFor();
  assert.equal(await actions.locator("form").count(), 0);
  assert.equal(await actions.getByText("取消任务", { exact: true }).count(), 0);
  await actions.getByText("本次约定执行").waitFor();
  assert.deepEqual(errors, []);
});
