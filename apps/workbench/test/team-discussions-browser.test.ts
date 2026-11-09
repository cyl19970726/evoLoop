// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 分工讨论: the inner rail lists discussions; the center reads 准备 → 交接 → 决定 and records a handoff, a decision and a
// link; the right column names linked tasks, roles and agents (never by ID). The safety test covers the baseline guards
// (discussion updated, document head changed, stale answer), recovery, correction and an unknown result that is later
// read back as applied. The last test covers permissions and failed reads.
// Screenshots at 1440 / 1024 / 390 go to EVOLOOP_DISCUSSIONS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DISCUSSIONS_SCREENSHOT_DIR;
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE";
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "35000001-0000-4000-8000-000000000001";
const id = (n: number) => `35000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const receiptKey = "evoloop.unconfirmed-operations.v1";
// Mirrors core's canonicalJson, so a lost answer can be confirmed by its operation digest.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);

const goal = { projectId, id: id(1), version: 2, outcome: "工作台改版上线", constraints: "", consumer: "", authority: "", scope: "", owner: "owner", createdAt: stamp, actorId: "owner" };
const stage = { projectId, id: id(2), goalId: id(1), version: 1, deliverable: "团队空间新版", learningQuestion: "", state: "active", createdAt: stamp, actorId: "owner" };
const task = { projectId, id: id(3), version: 4, currentRevisionId: id(4), title: "重写分工讨论页", content: "", contentDocumentId: id(90), contentRevisionId: id(91), kind: null, state: "in_progress" };
const role = { projectId, id: id(5), version: 1, currentRevisionId: id(6), state: "active", proposal: { title: "前端实现", roleClass: "business" } };
const adopted = { projectId, id: id(7), title: "团队空间需求", version: 2, currentRevisionId: id(8), adoptedRevisionId: id(8), kind: null, status: "published" };
const body = (version: number) => `# 前端分工讨论\n\n第 ${version} 版。\n\n问题：谁来接手团队空间？\n`;
const sessionKey = `owned:${id(20)}`;
const question = "谁来接手团队空间的分工讨论页？";
type Event = Record<string, unknown> & { id: string; kind: string };
type Next = "apply" | "lose" | { reject: string; then?: () => void };

function fixture(start: { status: string; version: number; head: number; registered: number; permissions?: string[] }) {
  const state = {
    permissions: start.permissions ?? ["read", "write", "review"],
    discussion: { projectId, id: id(30), version: start.version, kind: "allocation", status: start.status, documentId: id(10), preparedDocumentRevisionId: id(10 + 1),
      currentDocumentRevisionId: id(10 + start.registered), latestDecisionEventId: null as string | null, goal: { id: id(1), version: 2 }, stage: { id: id(2), version: 1 },
      task: { id: id(3), revisionId: id(4) }, adoptedDocuments: [{ documentId: id(7), revisionId: id(8) }], question, options: ["前端实现职责接手", "统筹另派"],
      authorizationBoundary: "不改后端接口", targetSessionLabel: "前端智能体", targetSessionRef: null, actorId: "owner", createdAt: stamp, updatedAt: stamp, collaboration: null },
    head: start.head,
    events: [] as Event[], commands: [] as Array<Record<string, unknown>>, next: [] as Next[], operations: new Map<string, unknown>(),
    failHead: false, failPackage: false, receiptBeforeSend: [] as boolean[],
  };
  const direction = { ...state.discussion, id: id(31), kind: "direction", question: "下一阶段先做知识空间吗？", status: "decided", version: 3 };
  const blank = { projectId, documentRevisionId: null, evidence: null, reason: null, choice: null, unresolved: null, relookCondition: null,
    supersedesDecisionEventId: null, decisionEventId: null, target: null, actorId: "owner", createdAt: stamp };
  state.events.push({ ...blank, id: id(40), discussionId: id(30), version: 1, kind: "prepared", documentRevisionId: id(11) });
  if (start.status !== "prepared") state.events.push({ ...blank, id: id(41), discussionId: id(30), version: 2, kind: "handoff", documentRevisionId: id(11), evidence: "对方确认", reason: "已交接" });
  const event = (kind: string, patch: Record<string, unknown>) => {
    state.discussion.version += 1; state.events.push({ ...blank, id: id(60 + state.events.length), discussionId: id(30), version: state.discussion.version, kind,
      documentRevisionId: state.discussion.currentDocumentRevisionId, ...patch });
  };
  function apply(command: Record<string, unknown>) {
    if (command.type === "discussion.handoff.record") { state.discussion.status = "handed_off"; event("handoff", { evidence: command.evidence, reason: command.reason }); }
    else if (command.type === "discussion.decision.record") {
      if (command.documentRecovery) state.discussion.currentDocumentRevisionId = command.documentRevisionId as string;
      state.discussion.status = "decided"; event("decision", { choice: command.choice, unresolved: command.unresolved, relookCondition: command.relookCondition,
        evidence: command.evidence, reason: command.reason, supersedesDecisionEventId: command.supersedesDecisionEventId ?? null });
      state.discussion.latestDecisionEventId = state.events.at(-1)!.id;
    } else if (command.type === "discussion.action.link") { state.discussion.status = "linked"; event("action", { target: command.target, decisionEventId: command.decisionEventId, reason: command.reason }); }
    return { operationId: command.operationId, status: "applied", entityId: command.type === "discussion.prepare" ? command.discussionId : id(30) };
  }
  const trace = (n: number, relation: unknown) => ({ id: id(n), discussion: { id: id(30), version: state.discussion.version, status: state.discussion.status, title: "前端分工讨论",
    document: { id: id(10), revisionId: id(11) }, latestDecisionEventId: state.discussion.latestDecisionEventId }, decisionEventId: state.discussion.latestDecisionEventId,
    decisionDocumentRevisionId: id(11), decisionIsLatest: true, sources: [{ kind: "task", id: id(3), revision: id(4), evidence: "project-record", href: `/p/${projectId}/tasks/${id(3)}` }], relation });
  const traces = () => state.discussion.latestDecisionEventId ? [
    trace(70, { kind: "decision-target", actionEventId: id(71), target: { kind: "task", id: id(3), revisionId: id(4) }, targetStatus: "current", taskAcceptanceGap: null }),
    trace(72, { kind: "task-recipient", taskActionEventId: id(71), task: { id: id(3), revisionId: id(4) }, taskRevisionStatus: "current", assignmentStatus: "current",
      assignment: { version: 1, target: { kind: "owned", sessionId: id(20) }, acceptedAt: stamp, method: "direct", actorId: "frontend", observerActorId: "owner" } }),
  ] : [];
  const meta = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] as string[] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const root = `/api/projects/${projectId}`, path = url.pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/commands" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const command = JSON.parse(raw) as Record<string, unknown>;
      state.commands.push(command);
      const next = state.next.shift() ?? "apply";
      if (next === "lose") {
        const result = apply(command);
        state.operations.set(command.operationId as string, { id: command.operationId, projectId, actorId: "owner", commandType: command.type,
          commandHash: sha(canonical({ actorId: "owner", command })), result, createdAt: stamp });
        res.writeHead(200, { "content-type": "application/json" }); res.end(""); return;
      }
      if (typeof next === "object") { next.then?.(); json({ operationId: command.operationId, status: "rejected", code: next.reject, message: "所见文档已被修订" }); return; }
      json(apply(command)); return;
    }
    if (path.startsWith(`${root}/operations/`)) {
      const operation = state.operations.get(path.split("/").at(-1)!);
      json(operation ?? { code: "OPERATION_NOT_FOUND", message: "没有这个操作" }, operation ? 200 : 404); return;
    }
    if (path.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null };
      if (path === "/api/session") value = { principal: { actorId: "owner", projectIds: [projectId], permissions: state.permissions }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "分工讨论回归项目", createdAt: stamp };
      else if (path === `${root}/goals`) value = { items: [goal], nextCursor: null };
      else if (path === `${root}/stages`) value = [stage];
      else if (path === `${root}/tasks`) value = { items: [task], nextCursor: null };
      else if (path === `${root}/tasks/${id(3)}`) value = { task };
      else if (path === `${root}/roles`) value = { items: [role], nextCursor: null };
      else if (path === `${root}/roles/${id(5)}`) value = role;
      else if (path === `${root}/documents`) value = { items: [adopted, { ...adopted, id: id(10), title: "前端分工讨论", adoptedRevisionId: null, currentRevisionId: id(10 + state.head), version: state.head }], nextCursor: null };
      else if (path === `${root}/documents/${id(10)}`) {
        if (state.failHead) { json({ message: "文档服务暂时不可用" }, 503); return; }
        value = { document: { projectId, id: id(10), title: "前端分工讨论", version: state.head, currentRevisionId: id(10 + state.head), adoptedRevisionId: null, kind: null, status: "draft" },
          current: { projectId, documentId: id(10), id: id(10 + state.head), contentHash: sha(body(state.head)) }, adopted: null };
      } else if (path.startsWith(`${root}/documents/${id(10)}/revisions/`)) {
        const n = Number(path.split("/").at(-1)!.slice(-12)) - 10;
        if (state.failPackage) { json({ message: "原件暂时不可读" }, 503); return; }
        value = { projectId, documentId: id(10), id: id(10 + n), body: body(n), format: "markdown", mediaType: "text/markdown", originalName: "discussion.md", payloadRef: null,
          entrypoint: null, assetsManifest: [], contentHash: sha(body(n)), author: n === 1 ? "owner" : "editor", createdAt: stamp, previousRevisionId: null, reason: "修订" };
      } else if (path === `${root}/discussions`) {
        const kind = url.searchParams.get("kind");
        value = { items: [state.discussion, direction].filter(item => !kind || item.kind === kind), nextCursor: null };
      } else if (path === `${root}/discussions/${id(30)}`) value = state.discussion;
      else if (path === `${root}/discussions/${id(30)}/events`) value = state.events;
      else if (path === `${root}/discussions/${id(31)}`) value = direction;
      else if (path === `${root}/discussions/${id(31)}/events`) value = [];
      else if (path === `${root}/allocation-relations`) value = { items: traces(), nextCursor: null, resetRequired: false, canonicalSessionKey: null,
        metadata: { ...meta, limitations: ["Fixed decision document revision unavailable"] } };
      else if (path === `${root}/session-work`) value = { items: [], nextCursor: null, observationCursor: "cursor-1", metadata: meta,
        totals: { current: 0, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (path === `${root}/session-work/changes`) value = { items: [], nextCursor: "cursor-1", hasMore: false, resetRequired: false, metadata: meta };
      else if (path === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: { key: sessionKey, aliases: [], title: "frontend-thread", profile: { displayName: "前端智能体" } } };
      else if (path === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
      else if ([`${root}/runtime/sessions`, `${root}/runtime/runs`, `${root}/resident-queues`, `${root}/impacts`].includes(path)) value = [];
      json(value); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(path) ? "index.html" : path;
      const content = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  return { state, server };
}

async function open(t: TestContext, server: ReturnType<typeof createServer>) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const login = async (path: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "分工讨论", exact: true }).waitFor();
    return { page, errors, center: page.getByRole("article", { name: "所选讨论" }), panel: page.locator("aside[aria-label=右栏]"),
      rail: page.getByRole("navigation", { name: "讨论列表" }) };
  };
  return { login };
}

test("分工讨论 lists, reads, records a handoff, a decision and a link, and prepares a new discussion", { skip }, async t => {
  const { state, server } = fixture({ status: "prepared", version: 1, head: 1, registered: 1 });
  const { login } = await open(t, server);
  const { page, errors, center, panel, rail } = await login(`/p/${projectId}/discussions`);
  // Every command is sent only after its recovery receipt is saved.
  await page.route("**/api/commands", async route => {
    const operationId = (JSON.parse(route.request().postData() ?? "{}") as { operationId?: string }).operationId;
    state.receiptBeforeSend.push(await page.evaluate(([key, value]) => (sessionStorage.getItem(key) ?? "").includes(value), [receiptKey, operationId ?? "-"] as const));
    await route.continue();
  });

  // The inner rail lists the allocation scope; the first one opens without being clicked.
  await rail.getByRole("link", { name: /谁来接手团队空间/ }).waitFor();
  assert.equal(await rail.getByRole("link", { name: /下一阶段先做知识空间/ }).count(), 0, "the allocation scope leaves out direction discussions");
  await center.getByRole("heading", { name: question }).waitFor();
  await center.getByText("待交接", { exact: true }).waitFor();
  await center.getByText("原文已核对").first().waitFor();
  await panel.getByText("工作台改版上线").waitFor();
  await panel.getByRole("link", { name: "重写分工讨论页" }).waitFor();
  await panel.getByRole("link", { name: "团队空间需求" }).waitFor();
  await panel.getByText("还没有正式链接的后续对象").waitFor();
  if (shots) await page.screenshot({ path: `${shots}/discussions-prepared-1440.png`, fullPage: true });

  // 交接: a required field left empty is named, then the handoff is recorded at the version that was read.
  await center.getByRole("button", { name: "登记承接观察" }).click();
  const handoff = center.getByRole("form", { name: "登记承接观察" });
  await handoff.getByRole("button", { name: "登记承接" }).click();
  assert.ok(await handoff.getByText("必填").count() >= 2);
  assert.equal(state.commands.length, 0);
  await handoff.getByLabel("实际怎样观察到承接").fill("前端智能体在对话里确认接手");
  await handoff.getByLabel("理由与依据").fill("负责人当面确认");
  await handoff.getByRole("button", { name: "登记承接" }).click();
  await center.getByText("待决定", { exact: true }).waitFor();
  assert.deepEqual([state.commands[0]!.type, state.commands[0]!.expectedVersion, state.commands[0]!.documentRevisionId], ["discussion.handoff.record", 1, id(11)]);

  // 决定.
  await center.getByRole("button", { name: "登记讨论决定" }).click();
  const decision = center.getByRole("form", { name: "登记讨论决定" });
  await decision.getByLabel("本次取舍（也可以明确维持现状）").fill("由前端实现职责接手");
  await decision.getByLabel("还没解决的问题").fill("知识页排期");
  await decision.getByLabel("什么情况下重看").fill("两周后没有进展");
  await decision.getByLabel("讨论依据与实际观察").fill("对话记录");
  await decision.getByLabel("理由", { exact: true }).fill("职责匹配");
  await decision.getByRole("button", { name: "保存决定" }).click();
  await center.getByText("已决定", { exact: true }).waitFor();
  assert.deepEqual([state.commands[1]!.type, state.commands[1]!.expectedVersion, state.commands[1]!.documentRecovery], ["discussion.decision.record", 2, undefined]);
  await center.getByText("由前端实现职责接手").waitFor();

  // Linked objects in the right column read by name; the agent who accepted the same task revision is named too.
  await panel.getByRole("link", { name: "前端智能体" }).waitFor();
  assert.ok(await panel.getByRole("link", { name: "重写分工讨论页" }).count() >= 2);
  const visibleText = `${await page.locator("main").innerText()}\n${await panel.innerText()}`;
  for (const raw of [id(3), id(5), id(20), id(30)]) assert.ok(!visibleText.includes(raw), `${raw} is shown only under 来源与完整标识`);

  // 链接后续对象, at the version that was read.
  await center.getByRole("button", { name: "链接后续对象" }).click();
  const linkForm = center.getByRole("form", { name: "链接后续对象" });
  await linkForm.getByLabel("实际的后续对象").selectOption(`role:${id(5)}`);
  await linkForm.getByLabel("理由").fill("由该职责持续负责");
  await linkForm.getByRole("button", { name: "链接对象" }).click();
  await center.getByText("已关联", { exact: true }).waitFor();
  assert.deepEqual([state.commands[2]!.target, state.commands[2]!.expectedVersion, state.commands[2]!.decisionEventId],
    [{ kind: "role", id: id(5), revisionId: id(6) }, 3, state.discussion.latestDecisionEventId]);
  assert.equal(await center.getByRole("form", { name: "链接后续对象" }).isVisible(), false, "a form folds away once its write is applied");
  if (shots) await page.screenshot({ path: `${shots}/discussions-linked-1440.png`, fullPage: true });

  // 全部讨论 shows the direction discussion too.
  await rail.getByLabel("讨论范围").selectOption("all");
  await rail.getByRole("link", { name: /下一阶段先做知识空间/ }).click();
  await center.getByRole("heading", { name: "下一阶段先做知识空间吗？" }).waitFor();
  await panel.getByText("还没有链接后续对象").waitFor();

  // 准备讨论: a new package fixes the goal version, the task revision and the adopted document.
  await page.getByRole("link", { name: "准备讨论" }).first().click();
  const prepareForm = page.getByRole("form", { name: "准备讨论" });
  await prepareForm.waitFor();
  await prepareForm.getByLabel("交接包标题").fill("知识空间分工");
  await prepareForm.getByLabel("固定目标").selectOption(id(1));
  await prepareForm.getByLabel("关联阶段（可选）").selectOption(id(2));
  await prepareForm.getByLabel("关联任务（可选）").selectOption(id(3));
  await prepareForm.getByLabel("团队空间需求").check();
  await prepareForm.getByLabel("本次要讨论的问题").fill("知识空间由谁接手？");
  await prepareForm.getByLabel("备选做法").fill("前端实现\n知识职责");
  await prepareForm.getByLabel("授权与不能自行决定的边界").fill("不改知识后端");
  await prepareForm.getByLabel("拟交接的智能体").fill("前端智能体");
  if (shots) await page.screenshot({ path: `${shots}/discussions-prepare-1440.png`, fullPage: true });
  await prepareForm.getByRole("button", { name: "生成交接包" }).click();
  await page.waitForURL(/discussion=/);
  const prepared = state.commands.at(-1)!;
  assert.deepEqual([prepared.type, prepared.kind, prepared.goal, prepared.task, prepared.adoptedDocuments, prepared.options],
    ["discussion.prepare", "allocation", { id: id(1), version: 2 }, { id: id(3), revisionId: id(4) }, [{ documentId: id(7), revisionId: id(8) }], ["前端实现", "知识职责"]]);
  assert.deepEqual(state.receiptBeforeSend, [true, true, true, true], "each command's receipt was saved before it was sent");

  // 1024: the right column is a drawer and does not open on its own; 390: no horizontal overflow.
  await rail.getByRole("link", { name: /谁来接手团队空间/ }).click();
  await center.getByRole("heading", { name: question }).waitFor();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole("dialog").count(), 0, "the right column stays closed below 1100px");
  if (shots) await page.screenshot({ path: `${shots}/discussions-1024.png`, fullPage: true });
  await page.getByRole("button", { name: "展开右栏" }).click();
  await page.getByRole("dialog").getByText("工作台改版上线").waitFor();
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/discussions-1024-drawer.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
  if (shots) await page.screenshot({ path: `${shots}/discussions-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
});

test("分工讨论 refuses to send on a changed baseline or a stale answer, recovers, corrects, and clears a draft whose lost answer was applied", { skip }, async t => {
  // Handed off; the discussion registered revision 1 but the document is already at version 2.
  const { state, server } = fixture({ status: "handed_off", version: 2, head: 2, registered: 1 });
  const { login } = await open(t, server);
  const { page, errors, center } = await login(`/p/${projectId}/discussions?discussion=${id(30)}`);
  const reread = () => page.getByRole("button", { name: "重新读取", exact: true }).first().click();
  await center.getByText("讨论登记版与文档当前版不同").waitFor();
  await center.getByRole("button", { name: "登记讨论决定" }).click();
  const decision = center.getByRole("form", { name: "登记讨论决定" });
  const save = decision.getByRole("button", { name: "保存决定" });
  const confirm = decision.getByRole("checkbox");
  await decision.getByLabel("本次取舍（也可以明确维持现状）").fill("从文档当前版接续");
  await decision.getByLabel("还没解决的问题").fill("无");
  await decision.getByLabel("什么情况下重看").fill("文档再改");
  await decision.getByLabel("讨论依据与实际观察").fill("两版已对照");
  await decision.getByLabel("理由", { exact: true }).fill("负责人修订过");
  await decision.getByLabel("为什么从文档当前版接续").fill("负责人在文档里补了范围");

  // 讨论已更新: someone else's write moves the discussion while the reader types.
  state.discussion.version += 1;
  await reread();
  await decision.getByText("内容已变化，请重新核对").waitFor();
  await decision.getByText(/变化的是：讨论版本/).waitFor();
  assert.equal(await save.isDisabled(), true, "a changed baseline refuses to send");
  await decision.getByRole("button", { name: "已重新核对", exact: true }).click();

  // The reader confirms version 2; the document then moves to version 3 before saving: the confirmation is dropped.
  await confirm.check();
  state.head = 3;
  await reread();
  await decision.getByText(/变化的是：文档当前版/).waitFor();
  assert.equal(await confirm.isChecked(), false, "a recovery confirmation does not survive a new document version");
  assert.equal(await save.isDisabled(), true);
  await decision.getByRole("button", { name: "已重新核对", exact: true }).click();
  await decision.getByText("第 3 版").waitFor();
  await confirm.check();

  // The server answers DOCUMENT_CHANGED (version 4 was saved meanwhile): stale disables saving until reread and checked.
  state.next.push({ reject: "DOCUMENT_CHANGED", then: () => { state.head = 4; } });
  await save.click();
  await decision.getByText("所见内容已过期").waitFor();
  const rejected = state.commands.at(-1)!;
  assert.deepEqual([rejected.documentRevisionId, rejected.documentRecovery], [id(13), { expectedDocumentVersion: 3, reason: "负责人在文档里补了范围" }]);
  assert.equal(await save.isDisabled(), true, "a stale answer refuses to send");
  assert.equal(await confirm.isChecked(), false);
  await decision.getByRole("button", { name: "重新读取" }).click();
  await decision.getByRole("button", { name: "已重新核对，继续" }).click();
  await decision.getByText("第 4 版").waitFor();
  // Acknowledging before the reread lands is safe: the newer head then shows up as a change to check once more.
  if (await decision.getByText("内容已变化，请重新核对").isVisible()) await decision.getByRole("button", { name: "已重新核对", exact: true }).click();
  const sent = state.commands.length;
  await save.click();
  await decision.getByText("两版不同时，需要先确认已核对。").waitFor();
  assert.equal(state.commands.length, sent, "nothing is sent without a fresh confirmation");
  await confirm.check();
  await save.click();
  await center.getByText("已决定", { exact: true }).waitFor();
  const recovered = state.commands.at(-1)!;
  assert.deepEqual([recovered.documentRevisionId, recovered.documentRecovery, recovered.expectedVersion],
    [id(14), { expectedDocumentVersion: 4, reason: "负责人在文档里补了范围" }, 3]);
  if (shots) await page.screenshot({ path: `${shots}/discussions-recovered-1440.png`, fullPage: true });

  // 决定更正: the new decision names the one it corrects.
  const first = state.discussion.latestDecisionEventId;
  await center.getByRole("button", { name: "纠正当前决定" }).click();
  const correction = center.getByRole("form", { name: "纠正当前决定" });
  await correction.getByLabel("本次取舍（也可以明确维持现状）").fill("改由统筹另派");
  await correction.getByLabel("还没解决的问题").fill("无");
  await correction.getByLabel("什么情况下重看").fill("一周后");
  await correction.getByLabel("讨论依据与实际观察").fill("负责人复核");
  await correction.getByLabel("理由", { exact: true }).fill("前端职责已满");
  await correction.getByRole("button", { name: "保存纠正" }).click();
  await center.getByText("当前决定（已纠正前一项）").waitFor();
  assert.deepEqual([state.commands.at(-1)!.supersedesDecisionEventId, state.commands.at(-1)!.documentRecovery], [first, undefined]);
  await center.getByText(/已纠正的决定 · 1 项/).waitFor();

  // 结果未知: the link's answer is lost. Nothing more can be sent; once the receipt is checked as applied, the draft is gone.
  await center.getByRole("button", { name: "链接后续对象" }).click();
  const link = center.getByRole("form", { name: "链接后续对象" });
  await link.getByLabel("实际的后续对象").selectOption(`task:${id(3)}`);
  await link.getByLabel("理由").fill("后续任务");
  state.next.push("lose");
  await link.getByRole("button", { name: "链接对象" }).click();
  await link.getByText(/这次提交的结果未确认/).waitFor();
  assert.equal(await link.getByRole("button", { name: "链接对象" }).isDisabled(), true, "an unknown result refuses a second send");
  await page.getByRole("link", { name: "按原操作 ID 核对" }).first().click();
  await page.getByRole("button", { name: "按操作 ID 核对" }).click();
  await page.getByText(/已应用；正在回读当前数据/).waitFor();
  await page.goBack();
  await center.getByText("已关联", { exact: true }).waitFor();
  await center.getByRole("button", { name: "链接后续对象" }).click();
  assert.equal(await link.getByLabel("实际的后续对象").inputValue(), "", "the applied draft was cleared");
  assert.equal(await link.getByLabel("理由").inputValue(), "");
  assert.equal(state.commands.filter(command => command.type === "discussion.action.link").length, 1, "the lost link was sent once");
  assert.deepEqual(errors, []);
});

test("分工讨论 shows only the writes the identity may make, and says 无法判断 when a check cannot be read", { skip }, async t => {
  const { state, server } = fixture({ status: "prepared", version: 1, head: 1, registered: 1, permissions: ["read"] });
  const { login } = await open(t, server);
  const reader = await login(`/p/${projectId}/discussions`);
  await reader.center.getByText("原文已核对").first().waitFor();
  await reader.center.getByText("当前身份没有写入权限，不能登记承接观察。").waitFor();
  assert.equal(await reader.center.getByRole("button", { name: "登记承接观察" }).count(), 0);
  assert.equal(await reader.page.getByRole("link", { name: "准备讨论" }).count(), 0, "no prepare entry without write permission");
  state.discussion.status = "handed_off";
  await reader.page.getByRole("button", { name: "重新读取", exact: true }).first().click();
  await reader.center.getByText("当前身份没有审阅权限，不能登记决定或链接后续对象。").waitFor();
  assert.equal(await reader.center.getByRole("button", { name: "登记讨论决定" }).count(), 0);
  assert.deepEqual(reader.errors, []);

  // A writer whose package and document head cannot be read: the page says it cannot judge, and offers no write.
  state.permissions = ["read", "write", "review"]; state.discussion.status = "prepared"; state.failHead = true; state.failPackage = true;
  const writer = await login(`/p/${projectId}/discussions`);
  await writer.center.getByText("无法核对").first().waitFor({ timeout: 15000 });
  assert.equal(await writer.center.getByText("原文已核对").count(), 0, "a failed check is never shown as checked");
  await writer.center.getByText("文档当前版没有核实").waitFor({ timeout: 15000 });
  await writer.center.getByText(/无法判断它与讨论登记版是否一致/).first().waitFor();
  assert.equal(await writer.center.getByRole("button", { name: "登记承接观察" }).count(), 0, "no write that depends on the failed check");
  await writer.center.getByText("交接包原文没有核对通过，无法判断它是否完整，暂不能保存。").waitFor();
  if (shots) await writer.page.screenshot({ path: `${shots}/discussions-read-failed-1440.png`, fullPage: true });
  assert.deepEqual(writer.errors, []);
});
