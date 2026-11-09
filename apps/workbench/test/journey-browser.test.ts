// Opt-in built-app regression for 目标与阶段 and 新建任务 (docs/frontend/pages/journey.md, tasks.md 新建任务): goals and
// stages read from the project, the tasks under a stage with their next step and responsibility in words, reviews,
// drafts kept across selection, leaving and rereads, a slow and a failed reread kept as the last read, a version conflict
// that rereads before the person keeps the draft, a stage accepted, one task.create sent from `?action=propose` with the
// fields the earlier forms sent, a later index page that fails, and first reads that fail (tasks; stages alone).
// Runs at 1440, 1024 and 390.
// Set EVOLOOP_JOURNEY_SCREENSHOT_DIR to keep screenshots. (Replaces journey-current-read.test.ts, which launched the
// browser without the configured executable and read the old board.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_JOURNEY_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "42000001-0000-4000-8000-000000000001";
const roleId = "42000002-0000-4000-8000-000000000002";
const [goalA, goalB] = ["42000010", "42000011"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [stageActive, stageReviewed, stageProposed] = ["42000020", "42000021", "42000022"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [taskWaiting, taskBlocked, taskClosed, taskLoose, taskBefore] = ["42000030", "42000031", "42000032", "42000033", "42000034"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const documentId = "42000040-0000-4000-8000-000000000000";
const reviewId = "42000050-0000-4000-8000-000000000000";
const stamp = "2026-11-09T08:00:00.000Z";
const goal = (id: string, outcome: string, version = 1) => ({ projectId, id, version, outcome, constraints: "保留原始证据", consumer: "试用团队",
  authority: "可以调整工作台读写", scope: "本季度", owner: roleId, actorId: "leader-actor", createdAt: stamp });
const stage = (id: string, goalId: string, deliverable: string, state: string, version = 2) => ({ projectId, id, goalId, version, deliverable,
  learningQuestion: `${deliverable}能否被真实使用？`, state, actorId: "leader-actor", createdAt: stamp });
const projection = (taskId: string, title: string, phase: string, stageId: string | null, extra: Record<string, unknown> = {}) => ({
  kind: "task", taskId, version: 2, currentRevisionId: taskId, workChangeSequence: 4, title, taskKind: "implementation",
  taskState: phase === "closed" ? "done" : phase === "running" || phase === "awaiting_acceptance" ? "in_progress" : "todo", phase,
  nextAction: "Run the acceptance relay for consumer use", responsible: { kind: "role", id: roleId, label: `role:${roleId}` }, assignment: null,
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null,
  stage: stageId ? { stageId, deliverable: "阶段" } : null, plan: null, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp }, timing: null, actionKey: `task:${taskId}`, ...extra,
});

test("目标与阶段 reads goals, stages and their tasks in words, keeps drafts and last reads, accepts a stage and creates a stage task", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const state = { current: false, failRecords: false, failStages: false, failWork: false, failSecondWorkPage: false, delay: false, accepted: false, goalVersion: 1 };
  const waiting: (() => void)[] = [];
  let delayStarted: (() => void) | null = null;
  const hold = () => new Promise<void>(done => { waiting.push(done); delayStarted?.(); });
  const requests: string[] = [];
  let closedRead = false;
  const commands: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${req.method} ${url.pathname}`);
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      const stages = [stage(stageActive, goalA, "首个可用版本", "active"), stage(stageReviewed, goalA, "试用反馈", "reviewed", state.current ? 4 : 3),
        stage(stageProposed, goalB, "对外说明初稿", state.accepted ? "active" : "proposed", state.accepted ? 2 : 1)];
      if (path === "/api/session") value = { principal: { actorId: "leader-actor", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "目标与阶段夹具", createdAt: stamp };
      else if (path === `${root}/goals`) value = state.failRecords ? (status = 503, { message: "目标暂不可读" }) : { items: [
        { ...goal(goalA, "让试用团队每天用上工作台", state.goalVersion), ...state.goalVersion > 1 ? { scope: "本季度和下季度" } : {} }, goal(goalB, "整理第二季度的对外说明")], nextCursor: null };
      else if (path === `${root}/stages`) {
        if (state.delay) await hold();
        value = state.failRecords || state.failStages ? (status = 503, { message: "阶段暂不可读" }) : stages;
      }
      else if (path === `${root}/work-management/index`) {
        if (url.searchParams.get("includeClosed") === "true") closedRead = true;
        if (state.delay) await hold();
        const paged = state.failSecondWorkPage;
        if (state.failWork || paged && url.searchParams.get("cursor") === "two") { status = 503; value = { message: "工作索引暂不可读" }; }
        else value = { nextCursor: null, ...paged ? { nextCursor: "two" } : {}, items: [
          projection(taskWaiting, "核对首个版本的使用记录", state.current ? "closed" : "awaiting_acceptance", stageActive),
          projection(taskBlocked, "接上日程提醒", "blocked", stageActive, { dependencies: [{ taskId: taskBefore, title: "前置结果", state: "in_progress", currentRevisionId: taskBefore, acceptanceSatisfied: false }] }),
          ...paged ? [] : [projection(taskClosed, "汇总试用反馈", "closed", stageReviewed), projection(taskLoose, "零散的修补", "ready", null)],
        ], total: 4, counts: {}, changeSequence: 4, observedAt: stamp, partial: false };
      }
      else if (path === `${root}/stages/${stageReviewed}/reviews`) value = [{ projectId, id: reviewId, stageId: stageReviewed, stageVersion: 3, supersedesReviewId: null,
        adopted: "每天打开工作台的人变多", rejected: "提醒能代替使用", gap: "缺少周末数据", nextChoice: "stop", evidence: "试用记录", reason: "阶段目标已达成", actorId: "leader-actor", createdAt: stamp }];
      else if (path.endsWith("/reviews")) value = [];
      else if (path === `${root}/goals/${goalA}/revisions`) value = [{ ...goal(goalA, "让试用团队每天用上工作台"), reason: "建立目标" }];
      else if (path === `${root}/roles`) value = { items: [{ projectId, id: roleId, version: 1, state: "active", proposal: { title: "开发职责" } }], nextCursor: null };
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, state: "active", proposal: { title: "开发职责" } };
      else if (path === `${root}/documents`) value = { items: [{ projectId, id: documentId, title: "试用反馈汇总", version: 1, kind: "report", status: "published", currentRevisionId: documentId, adoptedRevisionId: documentId }], nextCursor: null };
      else if (path === "/api/commands" && req.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const command = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        commands.push(command);
        if (command.type === "stage.accept") state.accepted = true;
        if (command.type === "goal.revise" && command.expectedVersion !== state.goalVersion)
          value = { operationId: command.operationId, status: "rejected", code: "VERSION_CONFLICT", message: "The observed version is no longer current" };
        else {
          if (command.type === "goal.revise") state.goalVersion += 1;
          value = { operationId: command.operationId, status: "applied", entityId: command.taskId ?? command.stageId ?? command.goalId, version: 1 };
        }
      }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const login = async () => {
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
  };
  const main = page.getByRole("main");
  const rail = page.getByRole("navigation", { name: "目标与阶段" });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "no horizontal overflow");

  // Read: the first stage being worked on opens; its tasks say what happens next and who acts, in words.
  await page.goto(`${base}/p/${projectId}/journey`);
  await login();
  await main.getByRole("heading", { level: 1, name: "目标与阶段" }).waitFor();
  await main.getByRole("heading", { level: 2, name: "首个可用版本" }).waitFor();
  await rail.getByRole("link", { name: /试用反馈/ }).waitFor();
  assert.match(await rail.innerText(), /让试用团队每天用上工作台[\s\S]*首个可用版本[\s\S]*2 项任务[\s\S]*推进中[\s\S]*试用反馈[\s\S]*1 项任务[\s\S]*已回看[\s\S]*整理第二季度的对外说明/);
  const tasks = main.getByRole("region", { name: "阶段下的任务" });
  await tasks.getByText("下一责任：职责 · 开发职责").first().waitFor();
  const taskText = await tasks.innerText();
  assert.match(taskText, /核对首个版本的使用记录\s*待验收\s*等验收者核对交付与实际使用/);
  assert.match(taskText, /接上日程提醒\s*受阻\s*等待前置任务「前置结果」通过验收；处理后再安排承接/);
  assert.match(await main.locator("[data-stage-next]").innerText(), /核对交付与实际使用/);
  const centerText = await main.innerText();
  for (const raw of [roleId, taskWaiting, stageActive, goalA, "Run the acceptance relay", "role:"]) assert.equal(centerText.includes(raw), false, `${raw} stays in the identifier layer`);
  const facts = page.getByRole("complementary", { name: "右栏" }).getByRole("region", { name: "目标与阶段的信息" });
  await facts.getByText("3 项", { exact: true }).waitFor();
  assert.match(await facts.innerText(), /目标\s*2 项\s*阶段\s*3 项\s*任务\s*4 项，已读全（含已关闭）[\s\S]*任务进展\s*受阻 1 · 待验收 1[\s\S]*不属于阶段的任务\s*1 项/);
  assert.ok(closedRead, "closed tasks are read too");
  await shot("journey-1440");

  // A reviewed stage shows its current judgement; a typed goal revision survives switching goals.
  await rail.getByRole("link", { name: /试用反馈/ }).click();
  await main.getByRole("heading", { level: 2, name: "试用反馈" }).waitFor();
  await main.getByText("停止并保留理由 · 当前判断").waitFor();
  assert.match(await main.locator("[data-stage-next]").innerText(), /阶段已回看/);
  await main.getByText("修订目标", { exact: true }).click();
  const revise = main.getByRole("form", { name: "修订目标" });
  await revise.getByLabel("理由与依据").fill("未提交草稿");
  await rail.getByRole("link", { name: /整理第二季度的对外说明/ }).click();
  await main.getByRole("heading", { level: 2, name: "整理第二季度的对外说明" }).waitFor();
  assert.match(await main.getByRole("region", { name: "这个目标的阶段" }).innerText(), /对外说明初稿[\s\S]*待接受/);
  await rail.getByRole("link", { name: /试用反馈/ }).click();
  await main.getByRole("heading", { level: 2, name: "试用反馈" }).waitFor();
  assert.equal(await main.getByRole("form", { name: "修订目标" }).getByLabel("理由与依据").inputValue(), "未提交草稿");
  // Leaving for a task and coming back keeps the draft.
  await main.getByRole("link", { name: "汇总试用反馈" }).click();
  await page.waitForURL(new RegExp(`/tasks/${taskClosed}`));
  await page.goBack();
  await main.getByRole("heading", { level: 2, name: "试用反馈" }).waitFor();
  assert.equal(await main.getByRole("form", { name: "修订目标" }).getByLabel("理由与依据").inputValue(), "未提交草稿");

  // A slow reread keeps the last read on screen and the button busy; meanwhile the latest review is only the one
  // read back last time. The answer replaces it.
  state.delay = true; state.current = true;
  const started = new Promise<void>(done => { delayStarted = done; });
  await main.getByRole("button", { name: "重新读取" }).click();
  await started;
  await main.getByRole("button", { name: "正在核对…" }).waitFor();
  assert.equal(await main.getByRole("button", { name: "正在核对…" }).isDisabled(), true);
  await main.getByText("试用反馈能否被真实使用？").waitFor();
  await main.getByText("停止并保留理由 · 上次读回的判断").waitFor();
  state.delay = false; for (const done of waiting.splice(0)) done();
  await main.getByRole("button", { name: "重新读取" }).waitFor();
  await main.getByText("停止并保留理由 · 当前判断").waitFor();
  await rail.getByRole("link", { name: /首个可用版本/ }).click();
  await main.locator(`[data-stage-task="${taskWaiting}"]`).getByText("已关闭").waitFor();

  // A failed reread keeps the last read, says it is waiting to be checked, pauses sending and keeps the draft.
  state.failRecords = true; state.failWork = true;
  await main.getByRole("button", { name: "重新读取" }).click();
  await main.getByText("重新读取失败，下面是上次读回的内容，当前待核对").waitFor({ timeout: 15000 });
  await tasks.getByText(/任务没有重新读回：工作索引暂不可读/).waitFor({ timeout: 15000 });
  assert.match(await tasks.innerText(), /核对首个版本的使用记录/);
  assert.match(await facts.innerText(), /上次读回，当前待核对/);
  await rail.getByRole("link", { name: /试用反馈/ }).click();
  assert.equal(await main.getByRole("form", { name: "修订目标" }).getByLabel("理由与依据").inputValue(), "未提交草稿");
  await main.getByRole("form", { name: "修订目标" }).getByText(/提交暂停/).waitFor();
  assert.equal(await main.getByRole("form", { name: "修订目标" }).getByRole("button", { name: "保存修订" }).isDisabled(), true);
  await main.getByText("上次读回的判断", { exact: false }).waitFor();
  state.failRecords = false; state.failWork = false;
  await main.getByRole("button", { name: "再试一次" }).click();
  await main.getByText("重新读取失败，下面是上次读回的内容，当前待核对").waitFor({ state: "detached", timeout: 15000 });
  assert.deepEqual([...new Set(requests.map(item => item.split(" ")[0]))], ["GET"], "reading never writes");

  // Someone else saves the goal meanwhile: the answer is a version conflict, the page rereads, the draft stays, and
  // only after the latest version is on screen may the person keep the draft (or refill) and send against it.
  state.goalVersion = 2;
  const revising = main.getByRole("form", { name: "修订目标" });
  await revising.getByRole("button", { name: "保存修订" }).click();
  await revising.getByRole("button", { name: "保留草稿，按最新版本核对" }).waitFor({ timeout: 15000 });
  await main.locator("[data-goal]").getByText(/第 2 版/).waitFor();
  assert.equal(await revising.getByLabel("理由与依据").inputValue(), "未提交草稿");
  assert.equal(await revising.getByRole("button", { name: "保存修订" }).isDisabled(), true);
  await revising.getByRole("button", { name: "保留草稿，按最新版本核对" }).click();
  await revising.getByRole("button", { name: "保存修订" }).click();
  await revising.getByText(/已保存/).first().waitFor();
  assert.deepEqual(commands.filter(item => item.type === "goal.revise").map(item => [item.expectedVersion, item.reason]), [[1, "未提交草稿"], [2, "未提交草稿"]]);

  // 1024: the right column is a drawer the page never opens by itself.
  await page.setViewportSize({ width: 1024, height: 800 });
  await main.getByRole("button", { name: "阶段信息" }).waitFor();
  await page.getByRole("complementary", { name: "右栏" }).waitFor({ state: "detached" });
  assert.equal(await page.getByRole("region", { name: "目标与阶段的信息" }).isVisible().catch(() => false), false, "the drawer stays closed");
  await shot("journey-1024");
  await main.getByRole("button", { name: "阶段信息" }).click();
  await page.getByRole("dialog").getByRole("region", { name: "目标与阶段的信息" }).waitFor();
  await page.waitForTimeout(400);
  await shot("journey-1024-drawer");
  await page.keyboard.press("Escape");

  // Accept a proposed stage: the reason is asked for first; the command names the version that was read.
  await page.setViewportSize({ width: 1440, height: 900 });
  await rail.getByRole("link", { name: /对外说明初稿/ }).click();
  await main.getByRole("heading", { level: 2, name: "对外说明初稿" }).waitFor();
  assert.match(await main.locator("[data-stage-next]").innerText(), /先判断是否接受/);
  await main.getByText("接受这个阶段", { exact: true }).click();
  const accept = main.getByRole("form", { name: "接受阶段" });
  await accept.getByRole("button", { name: "接受阶段" }).click();
  await accept.getByText("请填写理由与依据。").waitFor();
  assert.equal(commands.filter(item => item.type === "stage.accept").length, 0);
  await accept.getByLabel("理由与依据").fill("交付和学习问题都清楚");
  await accept.getByRole("button", { name: "接受阶段" }).click();
  await main.locator(`[data-stage="${stageProposed}"]`).getByText("推进中").waitFor();
  const acceptCommands = commands.filter(item => item.type === "stage.accept");
  assert.equal(acceptCommands.length, 1);
  const { operationId: acceptOperation, projectId: acceptProject, ...accepted } = acceptCommands[0]!;
  assert.match(String(acceptOperation), /^[0-9a-f-]{36}$/);
  assert.equal(acceptProject, projectId);
  assert.deepEqual(accepted, { type: "stage.accept", stageId: stageProposed, expectedVersion: 1, reason: "交付和学习问题都清楚" });

  // Create a stage task from 目标与阶段: missing fields are named first, then one task.create carries every field.
  await main.getByRole("combobox", { name: "切换目标或阶段" }).waitFor({ state: "hidden" });
  await rail.getByRole("link", { name: /首个可用版本/ }).click();
  await main.getByRole("link", { name: "新建任务" }).click();
  await page.waitForURL(new RegExp(`/journey\\?action=propose&stage=${stageActive}$`));
  await main.getByRole("heading", { level: 1, name: "新建任务" }).waitFor();
  const form = main.getByRole("form", { name: "新建任务" });
  assert.equal(await form.getByLabel("所属阶段（可选）").inputValue(), stageActive);
  await page.getByRole("complementary", { name: "右栏" }).getByText("首个可用版本能否被真实使用？", { exact: false }).waitFor();
  await form.getByLabel("负责职责").selectOption(roleId);
  await form.getByRole("button", { name: "保存任务" }).click();
  await form.getByText(/还有 \d+ 处需要补充/).waitFor();
  await form.getByText("属于阶段的任务要写明来源或反馈证据。").waitFor();
  assert.match(await form.getByText(/还有 \d+ 处需要补充/).innerText(), /任务名称[\s\S]*来源或反馈证据/, "the summary names the fields");
  assert.equal(commands.filter(item => item.type === "task.create").length, 0);
  await form.getByLabel("任务名称").fill("把验收清单接进日程");
  await form.getByLabel("为什么要做").fill("试用团队每天要手动核对。");
  await form.getByLabel("期望结果").fill("日程每天生成核对任务");
  await form.getByLabel("怎样独立验收").fill("另一位智能体按清单核对三天记录");
  await form.getByLabel("实际使用成果的身份").fill("trial-user");
  await form.getByLabel("来源或反馈证据").fill("试用反馈汇总第 3 条");
  await form.getByLabel("停止条件").fill("试用团队不再需要提醒");
  await form.getByLabel("执行时间", { exact: true }).fill("2026-11-12T09:30");
  await form.getByLabel("时区").fill("Asia/Taipei");
  await form.getByLabel("是否重复").selectOption("daily");
  await form.locator("[data-schedule-preview]").getByText(/之后每天同一时刻/).waitFor();
  await form.getByText("更多设置").click();
  await form.getByLabel("试用反馈汇总").check();
  await shot("create-task-1440");
  await form.getByRole("button", { name: "保存任务" }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const creates = commands.filter(item => item.type === "task.create");
  assert.equal(creates.length, 1);
  const { operationId, projectId: sentProject, taskId, ...sent } = creates[0]!;
  assert.match(String(operationId), /^[0-9a-f-]{36}$/);
  assert.equal(sentProject, projectId);
  assert.match(page.url(), new RegExp(`/tasks/${taskId}$`));
  assert.deepEqual(sent, {
    type: "task.create", title: "把验收清单接进日程", kind: null, content: "试用团队每天要手动核对。\n\n期望结果\n日程每天生成核对任务",
    acceptance: "另一位智能体按清单核对三天记录", owner: roleId, acceptanceMode: "independent_agent", useRequired: true, consumer: "trial-user",
    stageId: stageActive, documentIds: [documentId], timing: { executeAtUtc: "2026-11-12T01:30:00.000Z", timezone: "Asia/Taipei", repeat: "daily" },
    evidence: "试用反馈汇总第 3 条", stopCondition: "试用团队不再需要提醒",
  });
  assert.deepEqual(errors, []);

  // The task page offers 新建任务 in its inner rail; the create page fits 390 without sideways scrolling.
  await page.goto(`${base}/p/${projectId}/work`);
  await login();
  await page.locator("[data-shell='object-list']").getByRole("link", { name: "新建任务" }).waitFor();
  await shot("tasks-rail-entry-1440");
  await page.locator("[data-shell='object-list']").getByRole("link", { name: "新建任务" }).click();
  await page.waitForURL(/\/tasks\/new$/);
  await main.getByRole("heading", { level: 1, name: "新建任务" }).waitFor();
  assert.match(await main.getByRole("link", { name: "返回任务列表" }).getAttribute("href") ?? "", new RegExp(`^/p/${projectId}/work`));
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await shot("create-task-390");
  await page.goto(`${base}/p/${projectId}/journey?stage=${stageActive}`);
  await login();
  await main.getByRole("heading", { level: 2, name: "首个可用版本" }).waitFor();
  await main.getByLabel("切换目标或阶段").waitFor();
  await noOverflow();
  await shot("journey-390");

  // A first read that fails is not an empty stage: the tasks are undecided and the next step waits.
  state.failWork = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await login();
  await main.getByRole("heading", { level: 2, name: "首个可用版本" }).waitFor();
  await tasks.getByText("阶段下的任务暂不可读取").waitFor({ timeout: 15000 });
  assert.match(await tasks.innerText(), /这不表示阶段没有任务/);
  assert.doesNotMatch(await tasks.innerText(), /还没有所属任务/);
  assert.match(await main.locator("[data-stage-next]").innerText(), /尚未读全，暂不能判断/);
  assert.match(await facts.innerText(), /任务\s*没有读回，无法判断/);
  await shot("journey-read-failed-1440");

  // A later index page that cannot be read keeps the first page and says the tasks are only partly read.
  state.failWork = false; state.failSecondWorkPage = true;
  await page.reload();
  await login();
  await main.getByRole("heading", { level: 2, name: "首个可用版本" }).waitFor();
  await main.locator("[data-work-partial]").waitFor({ timeout: 15000 });
  assert.match(await main.locator("[data-work-partial]").innerText(), /任务只读了一部分（工作索引暂不可读）/);
  assert.match(await tasks.innerText(), /核对首个版本的使用记录/);
  assert.match(await facts.innerText(), /任务\s*2 项，只读了一部分[\s\S]*不属于阶段的任务\s*0 项（已读部分）/);
  state.failSecondWorkPage = false;

  // Stages that cannot be read leave the goals readable but conclude nothing about stages.
  state.failStages = true;
  await page.reload();
  await login();
  await main.getByRole("heading", { level: 1, name: "目标与阶段" }).waitFor();
  await main.getByText("阶段读取失败").waitFor({ timeout: 15000 });
  await rail.getByText("阶段没有读回，无法判断各目标下有哪些阶段。").waitFor();
  assert.match(await rail.innerText(), /让试用团队每天用上工作台\s*目标 · 阶段无法判断/);
  await rail.getByRole("link", { name: /整理第二季度的对外说明/ }).click();
  await main.getByRole("heading", { level: 2, name: "整理第二季度的对外说明" }).waitFor();
  const stagesFailed = await main.innerText();
  assert.match(stagesFailed, /目标 · 第 1 版 · 阶段无法判断/);
  assert.match(stagesFailed, /阶段没有读回，无法判断这个目标下有哪些阶段/);
  assert.doesNotMatch(`${stagesFailed}\n${await rail.innerText()}`, /0 个阶段|还没有阶段/);
  assert.match(await facts.innerText(), /阶段\s*没有读回，无法判断[\s\S]*不属于阶段的任务\s*没有读回，无法判断/);
  await shot("journey-stages-failed-1440");
  assert.deepEqual(errors, []);
});
