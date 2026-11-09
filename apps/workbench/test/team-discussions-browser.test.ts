// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 分工讨论: the inner rail lists discussions; the center reads 准备 → 交接 → 决定 and records a handoff, a decision and
// a follow-up link; the right column names linked tasks, roles and agents (never by ID); a new discussion is prepared.
// Screenshots at 1440 / 1024 / 390 go to EVOLOOP_DISCUSSIONS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DISCUSSIONS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "35000001-0000-4000-8000-000000000001";
const id = (n: number) => `35000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const goal = { projectId, id: id(1), version: 2, outcome: "工作台改版上线", constraints: "", consumer: "", authority: "", scope: "", owner: "owner", createdAt: stamp, actorId: "owner" };
const stage = { projectId, id: id(2), goalId: id(1), version: 1, deliverable: "团队空间新版", learningQuestion: "", state: "active", createdAt: stamp, actorId: "owner" };
const task = { projectId, id: id(3), version: 4, currentRevisionId: id(4), title: "重写分工讨论页", content: "", contentDocumentId: id(90), contentRevisionId: id(91), kind: null, state: "in_progress" };
const role = { projectId, id: id(5), version: 1, currentRevisionId: id(6), state: "active", proposal: { title: "前端实现", roleClass: "business" } };
const adopted = { projectId, id: id(7), title: "团队空间需求", version: 2, currentRevisionId: id(8), adoptedRevisionId: id(8), kind: null, status: "published" };
const discussionDocument = { projectId, id: id(10), title: "前端分工讨论", version: 1, currentRevisionId: id(11), adoptedRevisionId: null, kind: null, status: "draft" };
const body = "# 前端分工讨论\n\n目标：工作台改版上线。\n\n问题：谁来接手团队空间？\n";
const revisions: Record<string, { body: string; author: string }> = { [id(11)]: { body, author: "owner" } };
const sessionKey = `owned:${id(20)}`;

type Event = Record<string, unknown> & { id: string; kind: string };
const discussion = {
  projectId, id: id(30), version: 1, kind: "allocation", status: "prepared", documentId: id(10), preparedDocumentRevisionId: id(11),
  currentDocumentRevisionId: id(11), latestDecisionEventId: null as string | null, goal: { id: id(1), version: 2 }, stage: { id: id(2), version: 1 },
  task: { id: id(3), revisionId: id(4) }, adoptedDocuments: [{ documentId: id(7), revisionId: id(8) }], question: "谁来接手团队空间的分工讨论页？",
  options: ["前端实现职责接手", "统筹另派"], authorizationBoundary: "不改后端接口", targetSessionLabel: "前端智能体", targetSessionRef: null,
  actorId: "owner", createdAt: stamp, updatedAt: stamp, collaboration: null,
};
const direction = { ...discussion, id: id(31), kind: "direction", question: "下一阶段先做知识空间吗？", status: "decided", version: 3 };
const blankEvent = { projectId, documentRevisionId: null, evidence: null, reason: null, choice: null, unresolved: null, relookCondition: null,
  supersedesDecisionEventId: null, decisionEventId: null, target: null, actorId: "owner", createdAt: stamp };
let events: Event[] = [{ ...blankEvent, id: id(40), discussionId: id(30), version: 1, kind: "prepared", documentRevisionId: id(11) }];
const prepared: Array<Record<string, unknown>> = [];
const commands: Array<Record<string, unknown>> = [];

function trace(n: number, relation: unknown) {
  return { id: id(n), discussion: { id: id(30), version: discussion.version, status: discussion.status, title: "前端分工讨论", document: { id: id(10), revisionId: id(11) }, latestDecisionEventId: discussion.latestDecisionEventId },
    decisionEventId: id(60), decisionDocumentRevisionId: id(11), decisionIsLatest: true, sources: [{ kind: "task", id: id(3), revision: id(4), evidence: "project-record", href: `/p/${projectId}/tasks/${id(3)}` }], relation };
}
const traces = () => discussion.latestDecisionEventId ? [
  trace(70, { kind: "decision-target", actionEventId: id(61), target: { kind: "task", id: id(3), revisionId: id(4) }, targetStatus: "current", taskAcceptanceGap: null }),
  trace(71, { kind: "task-recipient", taskActionEventId: id(61), task: { id: id(3), revisionId: id(4) }, taskRevisionStatus: "current", assignmentStatus: "current",
    assignment: { version: 1, target: { kind: "owned", sessionId: id(20) }, acceptedAt: stamp, method: "direct", actorId: "frontend", observerActorId: "owner" } }),
] : [];

function apply(command: Record<string, unknown>) {
  commands.push(command);
  const next = (kind: string, patch: Record<string, unknown>) => {
    discussion.version += 1; discussion.updatedAt = stamp;
    events = [...events, { ...blankEvent, id: id(60 + events.length - 1), discussionId: id(30), version: discussion.version, kind, documentRevisionId: id(11), ...patch }];
  };
  if (command.type === "discussion.handoff.record") { discussion.status = "handed_off"; next("handoff", { evidence: command.evidence, reason: command.reason }); }
  else if (command.type === "discussion.decision.record") {
    discussion.status = "decided"; next("decision", { choice: command.choice, unresolved: command.unresolved, relookCondition: command.relookCondition, evidence: command.evidence, reason: command.reason });
    discussion.latestDecisionEventId = events.at(-1)!.id;
  } else if (command.type === "discussion.action.link") { discussion.status = "linked"; next("action", { target: command.target, decisionEventId: command.decisionEventId, reason: command.reason }); }
  else if (command.type === "discussion.prepare") prepared.push(command);
  return { operationId: command.operationId, status: "applied", entityId: command.type === "discussion.prepare" ? command.discussionId : id(30) };
}

test("分工讨论 lists, reads, records a handoff, a decision and a link, and prepares a new discussion",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`;
        const path = url.pathname;
        let value: unknown = { items: [], nextCursor: null };
        if (path === "/api/commands" && req.method === "POST") {
          let raw = ""; for await (const chunk of req) raw += chunk;
          value = apply(JSON.parse(raw));
        } else if (path === "/api/session") value = { principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (path === root) value = { id: projectId, title: "分工讨论回归项目", createdAt: stamp };
        else if (path === `${root}/goals`) value = { items: [goal], nextCursor: null };
        else if (path === `${root}/stages`) value = [stage];
        else if (path === `${root}/tasks`) value = { items: [task], nextCursor: null };
        else if (path === `${root}/tasks/${id(3)}`) value = { task };
        else if (path === `${root}/roles`) value = { items: [role], nextCursor: null };
        else if (path === `${root}/roles/${id(5)}`) value = role;
        else if (path === `${root}/documents`) value = { items: [adopted, discussionDocument], nextCursor: null };
        else if (path === `${root}/documents/${id(10)}`) value = { document: discussionDocument, current: { projectId, documentId: id(10), id: id(11), contentHash: sha(body) }, adopted: null };
        else if (path.startsWith(`${root}/documents/${id(10)}/revisions/`)) {
          const revision = path.split("/").at(-1)!;
          value = { projectId, documentId: id(10), id: revision, body: revisions[revision]!.body, format: "markdown", mediaType: "text/markdown", originalName: "discussion.md",
            payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: sha(revisions[revision]!.body), author: revisions[revision]!.author, createdAt: stamp, previousRevisionId: null, reason: "准备" };
        } else if (path === `${root}/discussions`) {
          const kind = url.searchParams.get("kind");
          value = { items: [discussion, direction].filter(item => !kind || item.kind === kind), nextCursor: null };
        } else if (path === `${root}/discussions/${id(30)}`) value = discussion;
        else if (path === `${root}/discussions/${id(30)}/events`) value = events;
        else if (path === `${root}/discussions/${id(31)}`) value = direction;
        else if (path === `${root}/discussions/${id(31)}/events`) value = [];
        else if (path === `${root}/allocation-relations`) value = { items: traces(), nextCursor: null, resetRequired: false, canonicalSessionKey: null,
          metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: ["Fixed decision document revision unavailable"] } };
        else if (path === `${root}/session-work`) value = { items: [], nextCursor: null, observationCursor: "cursor-1", metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] },
          totals: { current: 0, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
        else if (path === `${root}/session-work/changes`) value = { items: [], nextCursor: "cursor-1", hasMore: false, resetRequired: false, metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] } };
        else if (path === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: { key: sessionKey, aliases: [], title: "frontend-thread", profile: { displayName: "前端智能体" } } };
        else if (path === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
        else if ([`${root}/runtime/sessions`, `${root}/runtime/runs`, `${root}/resident-queues`, `${root}/impacts`].includes(path)) value = [];
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      try {
        const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const file = await readFile(join(dist, path));
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
        res.end(file);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/discussions`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "分工讨论", exact: true }).waitFor();

    // The inner rail lists the allocation scope; the first one opens without being clicked.
    const rail = page.getByRole("navigation", { name: "讨论列表" });
    await rail.getByRole("link", { name: /谁来接手团队空间/ }).waitFor();
    assert.equal(await rail.getByRole("link", { name: /下一阶段先做知识空间/ }).count(), 0, "the allocation scope leaves out direction discussions");
    const center = page.getByRole("article", { name: "所选讨论" });
    await center.getByRole("heading", { name: discussion.question }).waitFor();
    await center.getByText("待交接", { exact: true }).waitFor();
    await center.getByText("原文已核对").first().waitFor();
    const panel = page.locator("aside[aria-label=右栏]");
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
    assert.equal(commands.length, 0);
    await handoff.getByLabel("实际怎样观察到承接").fill("前端智能体在对话里确认接手");
    await handoff.getByLabel("理由与依据").fill("负责人当面确认");
    await handoff.getByRole("button", { name: "登记承接" }).click();
    await center.getByText("待决定", { exact: true }).waitFor();
    assert.deepEqual([commands[0]!.type, commands[0]!.expectedVersion, commands[0]!.documentRevisionId], ["discussion.handoff.record", 1, id(11)]);

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
    assert.equal(commands[1]!.type, "discussion.decision.record");
    assert.equal(commands[1]!.expectedVersion, 2);
    await center.getByText("由前端实现职责接手").waitFor();

    // Linked objects in the right column read by name; the agent who accepted the same task revision is named too.
    await panel.getByRole("link", { name: "前端智能体" }).waitFor();
    assert.ok(await panel.getByRole("link", { name: "重写分工讨论页" }).count() >= 2);
    const visibleText = `${await page.locator("main").innerText()}\n${await panel.innerText()}`;
    for (const raw of [id(3), id(5), id(20), id(30)]) assert.ok(!visibleText.includes(raw), `${raw} is shown only under 来源与完整标识`);

    // 链接后续对象.
    await center.getByRole("button", { name: "链接后续对象" }).click();
    const linkForm = center.getByRole("form", { name: "链接后续对象" });
    await linkForm.getByLabel("实际的后续对象").selectOption(`role:${id(5)}`);
    await linkForm.getByLabel("理由").fill("由该职责持续负责");
    await linkForm.getByRole("button", { name: "链接对象" }).click();
    await center.getByText("已关联", { exact: true }).waitFor();
    assert.deepEqual(commands[2]!.target, { kind: "role", id: id(5), revisionId: id(6) });
    assert.equal(commands[2]!.decisionEventId, discussion.latestDecisionEventId);
    if (shots) await page.screenshot({ path: `${shots}/discussions-linked-1440.png`, fullPage: true });

    // 全部讨论 shows the direction discussion too.
    await rail.getByLabel("讨论范围").selectOption("all");
    await rail.getByRole("link", { name: /下一阶段先做知识空间/ }).click();
    await center.getByRole("heading", { name: direction.question }).waitFor();
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
    assert.equal(prepared.length, 1);
    assert.deepEqual([prepared[0]!.kind, prepared[0]!.goal, prepared[0]!.task, prepared[0]!.adoptedDocuments, prepared[0]!.options],
      ["allocation", { id: id(1), version: 2 }, { id: id(3), revisionId: id(4) }, [{ documentId: id(7), revisionId: id(8) }], ["前端实现", "知识职责"]]);

    // 1024: the right column is a drawer and does not open on its own; 390: no horizontal overflow.
    await rail.getByRole("link", { name: /谁来接手团队空间/ }).click();
    await center.getByRole("heading", { name: discussion.question }).waitFor();
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
