// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The parts rebuilt in #229 PR9k, each read, written and failing on a fixture: a task's collaboration thread and its
// Markdown text (当前工作), Git and external source registration (运行与关联 and 仓库规范), 待我验收与判断, and a schedule
// said in its own time zone. Screenshots at 1440, 1024 (right column as a drawer) and 390 go to
// EVOLOOP_LEGACY_BITS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_LEGACY_BITS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `29000${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2), roleId = id(3), sessionId = id(4), runId = id(5), discussionId = id(6);
const docId = id(7), docRevision = id(8), gitRef = id(9), decisionId = id(10), scheduleId = id(11), otherTaskId = id(12);
const stamp = "2026-11-09T01:00:00.000Z";
const gitText = "# 合同\n\n固定的接口说明。\n";
const gitHash = createHash("sha256").update(gitText).digest("hex");
const commit = "a".repeat(40);
const page = (items: unknown[]) => ({ items, nextCursor: null });

const task = { projectId, id: taskId, version: 3, currentRevisionId: taskId, title: "合并接口说明", kind: "implementation",
  content: "## 背景\n\n把接口说明合并到一处。\n\n> 只改说明，不改接口。\n\n- 第一步\n- 第二步\n\n```\nnpm test\n```",
  contentDocumentId: docId, contentRevisionId: docRevision, acceptance: "说明只有一份", owner: roleId, state: "in_progress", createdAt: stamp };
const discussion = { projectId, id: discussionId, version: 4, kind: "task_collaboration", status: "open", documentId: docId,
  preparedDocumentRevisionId: docRevision, currentDocumentRevisionId: docRevision, latestDecisionEventId: null, goal: null, stage: null,
  task: { id: taskId, revisionId: taskId }, adoptedDocuments: [], question: "接口说明放哪里", options: [], authorizationBoundary: "只读",
  targetSessionLabel: "", targetSessionRef: null, actorId: "lead", createdAt: stamp, updatedAt: stamp,
  collaboration: { runId, sessionId, issuerActorId: "lead", recipientActorId: "builder" } };
const body = { documentId: docId, revisionId: docRevision };
const event = (n: number, payload: Record<string, unknown>, actorId = "builder") => ({ projectId, id: id(40 + n), discussionId, version: n,
  kind: payload.type, documentRevisionId: null, actorId, createdAt: stamp, evidence: null, reason: null, choice: null, unresolved: null,
  relookCondition: null, supersedesDecisionEventId: null, decisionEventId: null, target: null, collaborationPayload: payload });
const events = [
  event(1, { type: "message", kind: "question", recipientActorId: "lead", body, replyToEventId: null }),
  event(2, { type: "action_request", detail: body, requestId: id(60), executorActorId: "builder", actionType: "git.push",
    scope: { repository: "evoLoop", worktree: "/work/evoloop", paths: ["docs/api.md"] }, inputHash: "b".repeat(64), reason: "推送说明",
    authorityEvidence: "负责人同意", expiresAt: "2026-11-12T01:00:00.000Z", acceptance: "说明可读" }),
  event(3, { type: "action_decision", requestEventId: id(42), decision: "approved", evidence: body }, "lead"),
];
const decision = { projectId, id: decisionId, taskId, taskRevisionId: taskId, slotId: id(13), version: 1, decision: "adopt", kind: "git",
  referenceId: gitRef, revision: commit, contentHash: gitHash, reason: "固定接口说明", actionImpact: "按固定说明改文档", actorId: "lead",
  createdAt: stamp, observedCurrentRevision: commit, observedCurrentHash: gitHash, observedCurrentValidity: "valid" };
const schedule = { projectId, scheduleId, id: scheduleId, version: 1, timezone: "America/New_York", rule: { kind: "once", atUtc: "2026-11-12T14:00:00.000Z" },
  misfire: { kind: "latest" }, overlap: "skip", template: { title: "纽约晨检", content: "## 晨检\n\n核对来源。", acceptance: "留下报告", owner: roleId,
    acceptanceMode: "independent_agent", consumer: null }, authorization: { scopeId: "scope", roleId, authorizedBy: "lead", expiresAtUtc: null },
  reason: "首次建立", actorId: "lead", createdAtUtc: stamp };

test("rebuilt legacy parts read, write and fail as the record allows, at three widths", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fail = new Set<string>();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/__fixture/fail") { fail.add(url.searchParams.get("what")!); res.end("ok"); return; }
    if (url.pathname === "/__fixture/heal") { fail.delete(url.searchParams.get("what")!); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value: unknown = page([]), status = 200;
      const refused = (what: string) => { if (!fail.has(what)) return false; status = 503; value = { message: "服务暂不可用" }; return true; };
      if (req.method === "POST") {
        let text = ""; for await (const chunk of req) text += String(chunk);
        const payload = JSON.parse(text) as Record<string, unknown>;
        posts.push({ path: url.pathname, body: payload });
        value = { status: "applied", operationId: payload.operationId, entityId: url.pathname.endsWith("/git") ? gitRef : decisionId };
      }
      else if (url.pathname === "/api/session") value = { principal: { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === p) value = { id: projectId, title: "旧组件换新", createdAt: stamp };
      else if (url.pathname === `${p}/tasks/${taskId}` || url.pathname === `${p}/tasks/${otherTaskId}`) {
        const current = url.pathname.endsWith(taskId) ? task : { ...task, id: otherTaskId, currentRevisionId: otherTaskId, title: "补齐来源" };
        value = { task: current, revision: { ...current, taskId: current.id, id: current.currentRevisionId, actorId: "lead", reason: "建立", createdAt: stamp },
          basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (url.pathname.startsWith(`${p}/work-management/tasks/`)) { status = 404; value = { message: "未登记" }; }
      else if (url.pathname === `${p}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "active",
        proposal: { title: "文档职责" }, proposedBy: "lead", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
      else if (url.pathname === `${p}/roles/${roleId}/bindings`) value = [];
      else if (url.pathname === `${p}/session-work/${encodeURIComponent(`owned:${sessionId}`)}/profile`)
        value = { projectId, sessionKey: `owned:${sessionId}`, displayName: "文档助手", version: 1, updatedAt: stamp };
      // An agent is named from its directory record (agentDisplayName), with the registered name.
      else if (url.pathname === `${p}/session-work/${encodeURIComponent(`owned:${sessionId}`)}`)
        value = { session: { key: `owned:${sessionId}`, kind: "owned", title: "文档职责", roles: [], profile: { displayName: "文档助手" } }, observationCursor: "0", currentWork: null };
      else if (url.pathname.endsWith("/profile")) { status = 404; value = { message: "未登记" }; }
      else if (url.pathname === `${p}/discussions`) { if (!refused("discussions")) value = page([discussion]); }
      else if (url.pathname === `${p}/discussions/${discussionId}`) value = discussion;
      else if (url.pathname === `${p}/discussions/${discussionId}/events`) value = events;
      else if (url.pathname === `${p}/references/tasks/${taskId}`) { if (!refused("references")) value = [decision]; }
      else if (url.pathname === `${p}/references/tasks/${otherTaskId}`) { if (!refused("references")) value = []; }
      else if (url.pathname === `${p}/references/git/${gitRef}`) value = { status: "available", referenceId: gitRef,
        ref: { projectId, repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash: gitHash },
        base64: Buffer.from(gitText).toString("base64"), observedAt: stamp };
      else if (url.pathname === `${p}/runtime/sessions` || url.pathname === `${p}/runtime/runs` || url.pathname === `${p}/resident-queues`) value = [];
      else if (url.pathname === `${p}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${p}/repositories`) value = { projectId, status: "available", items: [{ repositoryId: "evoLoop", allowedPaths: ["docs/"] }] };
      else if (url.pathname === `${p}/orchestration/status`) value = { state: "disabled" };
      else if (url.pathname === `${p}/acceptance-relay/mine`) value = { items: [{ projectId, relayId: id(20), taskId, taskRevisionId: taskId, deliveryId: id(21),
        stage: "candidate", scopeKey: "doc-use", scopeDescription: "按说明改一处文档", entrypoint: null, publicationRef: null, version: 2,
        createdAt: stamp, readAt: null, observationId: null }] };
      else if (url.pathname === `${p}/impacts`) { if (!refused("impacts")) value = [{ projectId, id: id(22), taskId: otherTaskId, taskRevisionId: otherTaskId,
        documentId: docId, fromRevisionId: docRevision, toRevisionId: id(23), state: "pending", decisionId: null, createdAt: stamp }]; }
      else if (url.pathname === `${p}/schedules`) value = [{ projectId, id: scheduleId, version: 1, currentRevisionId: scheduleId, state: "active", watermarkUtc: stamp, revision: schedule }];
      else if (url.pathname === `${p}/scheduling/status`) value = { state: "idle", lastTickAt: stamp, lastError: null, lastCreated: 0, grants: [] };
      else if (url.pathname === `${p}/schedules/${scheduleId}/revisions`) value = [schedule];
      else if (url.pathname === `${p}/schedules/${scheduleId}/occurrences`) value = [];
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const data = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const pageBrowser = await context.newPage();
  const errors: string[] = []; pageBrowser.on("pageerror", error => errors.push(error.message));
  const go = (path: string) => pageBrowser.evaluate(target => { const link = Object.assign(document.createElement("a"), { href: target }); document.body.append(link); link.click(); link.remove(); }, path);
  const noOverflow = () => pageBrowser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const shoot = async (name: string) => {
    if (!shots) return;
    for (const width of [1440, 1024, 390]) {
      await pageBrowser.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await pageBrowser.waitForTimeout(150);
      assert.equal(await noOverflow(), true, `${name} fits ${width}px`);
      if (width === 1024 && await pageBrowser.getByRole("button", { name: "展开右栏" }).count()) {
        await pageBrowser.getByRole("button", { name: "展开右栏" }).click();
        await pageBrowser.getByRole("dialog", { name: "右栏" }).waitFor();
        await pageBrowser.waitForTimeout(500);
        await pageBrowser.screenshot({ path: `${shots}/${name}-${width}.png` });
        await pageBrowser.keyboard.press("Escape");
      } else await pageBrowser.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
    }
    await pageBrowser.setViewportSize({ width: 1440, height: 900 });
  };
  await pageBrowser.goto(`${base}/p/${projectId}/tasks/${taskId}`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button", { name: "进入", exact: true }).click();
  const taskPage = pageBrowser.locator(`[data-page-key="task:${taskId}:::"]`);

  // 当前工作: the Markdown text on tokens (no old wrapper), the collaboration thread read in words.
  const markdown = taskPage.locator(".markdown-body").first();
  await markdown.getByRole("heading", { name: "背景" }).waitFor();
  assert.equal(await markdown.evaluate(element => !!element.closest("[data-legacy]")), false, "the task text is not old markup");
  assert.equal(await markdown.locator("blockquote").evaluate(element => getComputedStyle(element).borderLeftStyle), "solid");
  const thread = taskPage.locator("[data-task-collaboration]");
  await thread.getByText(/接口说明放哪里 · 1 个问题待答 · 第 4 版/).click();
  await thread.getByText("提问 · 致 lead · 待答复").waitFor();
  await thread.getByText("工程动作请求 · 推送分支 · 已批准，未见执行回执").waitFor();
  assert.equal((await thread.getByRole("link", { name: "文档助手" }).getAttribute("href"))?.split("&return=")[0], `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${sessionId}`)}`);
  assert.doesNotMatch(await thread.innerText(), /29000\d{3}|Run |Session|git\.push/, "no identifiers or internal words in the reading text");
  await shoot("task-collaboration");
  await fetch(`${base}/__fixture/fail?what=discussions`);
  await thread.getByRole("button", { name: "重新读取协作" }).click();
  await thread.getByText("上次读回，当前待核对").waitFor({ timeout: 15000 });
  assert.equal(await thread.getByText("提问 · 致 lead · 待答复").count(), 1, "the last answer stays, marked");
  await fetch(`${base}/__fixture/heal?what=discussions`);

  // 运行与关联 › Git 与外部来源登记: the recorded decision, its fixed original checked by hash, and two writes.
  await taskPage.getByRole("tab", { name: "运行与关联" }).click();
  const references = taskPage.locator("[data-reference-panel]");
  const recorded = references.locator(`[data-reference-decision="${decisionId}"]`);
  await recorded.getByText("采用 · Git 文件 · 这一依据位置的第 1 版").waitFor();
  await recorded.getByRole("button", { name: "阅读固定 Git 原文" }).click();
  await recorded.getByText("完整字节与登记的 SHA-256 一致").waitFor();
  await recorded.getByText("固定的接口说明。").waitFor();
  assert.doesNotMatch(await recorded.innerText(), new RegExp(`${gitRef}|${commit}`), "identifiers stay in the source layer");
  // Each write is folded under its title; a field is looked up inside its own form.
  const block = (title: string) => references.locator("details").filter({ has: pageBrowser.getByText(title, { exact: true }) }).first();
  const register = block("登记 Git 固定来源");
  await register.getByText("登记 Git 固定来源", { exact: true }).click();
  await register.getByLabel("仓库标识", { exact: true }).selectOption("evoLoop");
  await register.getByText("允许读取：docs/ 下的文件。").waitFor();
  await register.getByLabel("相对路径").fill("docs/api.md");
  await register.getByLabel("完整 commit").fill(commit);
  await register.getByLabel("原文 SHA-256").fill(gitHash);
  await register.getByRole("button", { name: "核验并登记" }).click();
  // Saved is all that is known when the answer comes; nothing claims a reread that has not happened.
  await references.getByText("已保存。登记的固定引用已填入下面两张表单。").waitFor();
  assert.equal(await references.getByText(/已重新读取当前记录/).count(), 0);
  const registered = posts.find(item => item.path.endsWith("/references/git"))!;
  assert.deepEqual(Object.keys(registered.body).sort(), ["commit", "contentHash", "operationId", "path", "referenceId", "repositoryId"], "the same fields as before");
  assert.deepEqual([registered.body.repositoryId, registered.body.path, registered.body.commit, registered.body.contentHash], ["evoLoop", "docs/api.md", commit, gitHash]);
  assert.match(String(registered.body.operationId), /^[0-9a-f-]{36}$/);
  const adopt = block("为当前任务修订采用外部依据");
  await adopt.getByText("为当前任务修订采用外部依据", { exact: true }).click();
  await adopt.getByLabel("采用理由").fill("用固定说明");
  await adopt.getByLabel("会改变的实际行动").fill("改文档");
  await adopt.getByRole("button", { name: "保存决定" }).click();
  for (let i = 0; i < 50 && !posts.some(item => item.path.endsWith("/decisions")); i++) await pageBrowser.waitForTimeout(50);
  const adopted = posts.find(item => item.path.endsWith(`/references/tasks/${taskId}/decisions`))!;
  assert.deepEqual([adopted.body.kind, adopted.body.referenceId, adopted.body.revision, adopted.body.contentHash, adopted.body.decision, adopted.body.expectedTaskVersion, adopted.body.taskRevisionId],
    ["git", gitRef, commit, gitHash, "adopt", 3, taskId], "the decision names the Git source registered just before");
  assert.deepEqual(Object.keys(adopted.body).sort(), ["actionImpact", "contentHash", "decision", "decisionId", "expectedHeadVersion", "expectedTaskVersion", "kind",
    "operationId", "reason", "referenceId", "revision", "slotId", "taskRevisionId"], "the same fields as before");
  await adopt.getByText("已保存，上面已是重新读取的登记。").waitFor();
  await shoot("task-references");
  // 复核此依据 opens the folded decision form itself and says beside it what was loaded.
  await adopt.getByText("为当前任务修订采用外部依据", { exact: true }).click();
  assert.equal(await adopt.evaluate(element => (element as HTMLDetailsElement).open), false);
  await recorded.getByRole("button", { name: "复核此依据" }).click();
  await adopt.getByText("已载入要复核的依据").waitFor();
  assert.equal(await adopt.evaluate(element => (element as HTMLDetailsElement).open), true, "the form is open, not only scrolled to");
  assert.equal(await adopt.getByLabel("决定").inputValue(), "retain");
  await adopt.getByRole("button", { name: "改为采用另一项新依据" }).click();
  assert.equal(await adopt.getByText("已载入要复核的依据").count(), 0);
  // A list that cannot be read says so and does not claim there is nothing; reading again finds the empty list.
  await fetch(`${base}/__fixture/fail?what=references`);
  await go(`/p/${projectId}/tasks/${otherTaskId}?tab=runtime`);
  const otherReferences = pageBrowser.locator(`[data-page-key="task:${otherTaskId}:::"] [data-reference-panel]`);
  await otherReferences.getByText("已登记的依据暂不可读取").waitFor({ timeout: 15000 });
  assert.equal(await otherReferences.getByText("这一版任务还没有登记外部依据。").count(), 0);
  await fetch(`${base}/__fixture/heal?what=references`);
  await otherReferences.getByRole("button", { name: "重新读取" }).click();
  await otherReferences.getByText("这一版任务还没有登记外部依据。").waitFor();

  // 仓库规范: the same registration without a task (no task decision form).
  await go(`/p/${projectId}/repository`);
  const repository = pageBrowser.getByRole("region", { name: "登记固定 Git 来源与正式采用" });
  await repository.getByText("登记 Git 固定来源", { exact: true }).waitFor();
  await repository.getByText("记录正式文档与过程文档的关系", { exact: true }).waitFor();
  assert.equal(await repository.getByText("为当前任务修订采用外部依据").count(), 0);
  assert.equal(await repository.evaluate(element => !!element.closest("[data-legacy]")), false);
  await shoot("repository");

  // 待我验收与判断: both lists in words; a failed list says it cannot tell, never "0 项".
  await go(`/p/${projectId}/inbox`);
  const inbox = pageBrowser.locator("[data-inbox]");
  await inbox.getByText("候选验收 · 按说明改一处文档").waitFor();
  await inbox.getByRole("link", { name: /补齐来源/ }).waitFor();
  assert.doesNotMatch(await inbox.innerText(), /doc-use|29000\d{3}/);
  await shoot("inbox");
  await fetch(`${base}/__fixture/fail?what=impacts`);
  await inbox.getByRole("button", { name: "重新读取" }).first().click();
  await inbox.getByText("上次读回，当前待核对").waitFor({ timeout: 15000 });
  // A first read that fails (a fresh page, nothing read before).
  await pageBrowser.goto(`${base}/p/${projectId}/inbox`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button", { name: "进入", exact: true }).click();
  await inbox.getByRole("alert").getByText("依据变化暂不可读取").waitFor({ timeout: 15000 });
  const impactHeader = inbox.getByRole("region", { name: "依据变化" });
  assert.match(await impactHeader.innerText(), /暂不可读取/);
  assert.doesNotMatch(await impactHeader.innerText(), /0 项|没有待复核/, "a failed read never says there is nothing");
  await fetch(`${base}/__fixture/heal?what=impacts`);

  // 日程: the schedule's own zone, with the reader's clock (Asia/Shanghai) added because it reads otherwise.
  await go(`/p/${projectId}/schedules`);
  await pageBrowser.getByRole("heading", { name: "纽约晨检" }).waitFor();
  await pageBrowser.getByText("仅一次 · 2026/11/12 09:00:00 · 纽约（你的时间 2026/11/12 22:00:00）").first().waitFor();
  // (The revision form's time zone choice lists 台北 among the zones; no time is said in it.)
  assert.equal(await pageBrowser.getByText(/台北/).filter({ hasNot: pageBrowser.locator("option") }).and(pageBrowser.locator(":not(option)")).count(), 0);
  await shoot("schedule-zone");
  assert.deepEqual(errors, []);
});
