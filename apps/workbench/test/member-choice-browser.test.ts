// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// Choosing an acceptance identity by member name (GET /members) on the screenshot fixture (scripts/frontend/fixture):
// 任务操作 › 修订验收责任, 新建任务, 创建日程 and 保存日程修订 list only members who can write, of the kind the acceptance
// mode takes (a task's old agreement takes any member); 必须本人验收 offers no empty choice; an edited identity file is
// said with what changes after a restart; the full identity can be typed, also while the list is read; with no member
// list the identity is typed, with the reason. Each form is submitted once and the command compared with the body the
// typed form sent, written out in full. Screenshots at 1440, 1024 and 390 go to EVOLOOP_MEMBERS_SCREENSHOT_DIR when set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { answer } from "../../../scripts/frontend/fixture/api.mjs";
import { actorId, id, projectId, roles, token } from "../../../scripts/frontend/fixture/common.mjs";
import { tasks } from "../../../scripts/frontend/fixture/work.mjs";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_MEMBERS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const root = `/api/projects/${projectId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The command without what each sending makes up anew (IDs, the operation, the moment), each checked for its form. */
function fixed(command: Record<string, unknown>, generated: string[]): Record<string, unknown> {
  const rest = { ...command };
  assert.match(String(rest.operationId), uuid); delete rest.operationId;
  assert.equal(rest.projectId, projectId); delete rest.projectId;
  for (const name of generated) {
    assert.ok(name === "watermarkUtc" ? !Number.isNaN(Date.parse(String(rest[name]))) : uuid.test(String(rest[name])), `${name} is made up when sent`);
    delete rest[name];
  }
  return rest;
}

test("验收身份 by member name: who can be chosen, typed when needed, and each form sends the body the typed identity sent",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const state = { members: "fixture" as "fixture" | "not_provided" | "fail", membersDelay: 0 };
    const commands: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
        const path = decodeURIComponent(url.pathname);
        if (path === "/api/commands" && req.method === "POST") {
          let text = ""; for await (const chunk of req) text += String(chunk);
          const command = JSON.parse(text) as Record<string, unknown>;
          commands.push(command);
          return send(200, { status: "applied", operationId: command.operationId, entityId: command.taskId ?? command.scheduleId });
        }
        if (path === `${root}/members` && state.membersDelay) await new Promise(done => setTimeout(done, state.membersDelay));
        if (path === `${root}/members` && state.members === "not_provided") return send(200, { projectId, status: "unavailable", reason: "not_provided" });
        if (path === `${root}/members` && state.members === "fail") return send(503, { message: "成员清单暂不可读" });
        const result = answer(path, url.searchParams) as { status: number; value: unknown } | undefined;
        return result ? send(result.status, result.value) : send(200, { items: [], nextCursor: null });
      }
      try {
        const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const body = await readFile(join(dist, file));
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE } : {}) });
    t.after(() => browser.close());
    const errors: string[] = [];
    async function open(path: string) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}${path}`);
      await page.getByLabel("访问令牌").fill(token);
      await page.getByRole("button", { name: "进入", exact: true }).click();
      return page;
    }
    type Page = Awaited<ReturnType<typeof open>>;
    const options = (select: ReturnType<Page["getByLabel"]>) => select.locator("option").allInnerTexts();
    const sentOf = async (page: Page, type: string) => {
      for (let i = 0; i < 200 && !commands.some(command => command.type === type); i++) await page.waitForTimeout(50);
      const sent = commands.find(command => command.type === type);
      assert.ok(sent, `${type} is sent`);
      commands.length = 0;
      return sent!;
    };
    const shoot = async (page: Page, name: string) => {
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.waitForTimeout(200);
        assert.equal(await page.getByRole("dialog").count(), 0, `the right drawer does not open by itself at ${width}px`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `${name} fits ${width}px`);
        if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };

    // 任务操作 › 修订验收责任 on a task to do. Its old agreement takes any person (a reviewer records a person's use for
    // them) but only agents who can write (an agent records its own use).
    const task = await open(`/p/${projectId}/tasks/${tasks.t5.id}?tab=actions`);
    await task.getByRole("heading", { name: tasks.t5.title, level: 1 }).filter({ visible: true }).first().waitFor();
    const tab = task.getByRole("tabpanel").filter({ visible: true }).first();
    await tab.getByText("修订验收责任", { exact: true }).click();
    const form = tab.locator("form").filter({ has: task.getByRole("button", { name: "保存验收责任" }) });
    const consumer = form.getByLabel("指定验收身份");
    await form.locator("option", { hasText: "li-observer · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(consumer), ["不指定", `${actorId} · 人`, "chen-pm · 人", "li-observer · 人", "verify-agent · 智能体", "loop-controller · 智能体"],
      "the old agreement: every person, a read-only one too; not the read-only gateway-sender agent");
    await form.getByText("另有 1 位智能体不能写入，没有列出。").waitFor();
    // 必须本人验收: the people who can write, and no empty choice to go back to.
    await form.getByLabel("验收方式").selectOption("human_required");
    await form.locator("option", { hasText: "chen-pm · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(consumer), ["选择成员", `${actorId} · 人`, "chen-pm · 人"]);
    assert.equal(await consumer.locator("option").first().isDisabled(), true, "必须本人验收 offers no 不指定");
    await form.getByText("另有 1 位不能写入、3 位不是人，没有列出。").waitFor();
    await form.getByText("身份文件已改动，部分成员的权限要重启后才生效").waitFor();
    await form.getByText("chen-pm：重启后才能复核").waitFor();
    // An independent agent: the agents who can write, and 不指定 again.
    await form.getByLabel("验收方式").selectOption("independent_agent");
    await form.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(consumer), ["不指定", "verify-agent · 智能体", "loop-controller · 智能体"]);
    await form.getByLabel("验收方式").selectOption("human_required");
    await consumer.selectOption("chen-pm");
    await form.getByLabel("理由").fill("由产品本人验收");
    await shoot(task, "members-task-actions");
    await form.getByRole("button", { name: "保存验收责任" }).click();
    // The body the typed form sent (taskCommands.acceptanceResponsibilityCommand over the fixture task), field by field.
    assert.deepEqual(fixed(await sentOf(task, "task.update"), []), {
      type: "task.update", taskId: tasks.t5.id, expectedVersion: 2, title: tasks.t5.title, content: `# ${tasks.t5.title}\n\n${tasks.t5.title}的正文：说明要做什么、为什么做。`,
      acceptance: "1. 选中哪一项，右栏就换成这一项。\n2. 1024 以下右栏是抽屉，不会自己弹出。\n3. 读取失败写“无法判断”。", owner: roles.docs.id, kind: "validation",
      documentIds: [], acceptanceMode: "human_required", useRequired: true, consumer: "chen-pm", reason: "由产品本人验收" });
    await task.context().close();

    // No member list from the service: the identity is typed, with the reason.
    state.members = "not_provided";
    const typed = await open(`/p/${projectId}/tasks/${tasks.t8.id}?tab=actions`);
    await typed.getByRole("heading", { name: tasks.t8.title, level: 1 }).filter({ visible: true }).first().waitFor();
    const typedTab = typed.getByRole("tabpanel").filter({ visible: true }).first();
    await typedTab.getByText("修订验收责任", { exact: true }).click();
    await typedTab.getByText("服务端没有提供本项目的成员清单，请按完整标识填写登录身份。").waitFor();
    await typedTab.getByLabel("指定验收身份").fill(actorId);
    assert.equal(await typedTab.getByLabel("指定验收身份").inputValue(), actorId);
    await typed.context().close();

    // 新建任务: while the members are read the identity can be typed; then the independent agents by default, the people
    // for 必须本人验收; submitted once.
    state.members = "fixture"; state.membersDelay = 2500;
    const create = await open(`/p/${projectId}/tasks/new`);
    await create.getByRole("heading", { name: "新建任务" }).first().waitFor();
    const user = create.getByLabel(/^实际使用成果的身份/);
    await create.locator("option", { hasText: "正在读取本项目的成员…" }).waitFor({ state: "attached" });
    await create.getByText("按完整标识填写").click();
    await create.getByLabel("完整标识").fill("someone-outside");
    assert.equal(await user.inputValue(), "someone-outside", "typed while the list is read");
    await create.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    state.membersDelay = 0;
    assert.equal(await user.locator("option:checked").innerText(), "someone-outside（当前所填；不在本项目的成员清单里）");
    await create.getByLabel("完整标识").fill("");
    assert.deepEqual(await options(user), ["不指定", "verify-agent · 智能体", "loop-controller · 智能体"]);
    await create.getByLabel("验收方式").selectOption("human_required");
    await create.locator("option", { hasText: `${actorId} · 人` }).waitFor({ state: "attached" });
    assert.deepEqual(await options(user), ["选择成员", `${actorId} · 人`, "chen-pm · 人"], "required for 必须本人验收");
    // A service identity or a same name: typed as a whole under its fold; the choice shows it for what it is.
    await create.getByLabel("完整标识").fill("li-observer");
    assert.equal(await user.locator("option:checked").innerText(), "li-observer（当前所填；不能写入）");
    await user.selectOption("chen-pm");
    assert.equal(await create.getByLabel("完整标识").inputValue(), "chen-pm");
    await create.getByLabel("任务名称").fill("整理验收清单");
    await create.getByLabel("为什么要做").fill("旧清单过时");
    await create.getByLabel("期望结果").fill("新清单");
    await create.getByLabel("怎样独立验收").fill("本人用过新清单");
    const owner = create.getByLabel("负责职责");
    await owner.locator("option", { hasText: roles.verify.title }).waitFor({ state: "attached" });
    await owner.selectOption(roles.verify.id);
    await shoot(create, "members-task-new");
    await create.getByRole("button", { name: "保存任务" }).click();
    assert.deepEqual(fixed(await sentOf(create, "task.create"), ["taskId"]), { type: "task.create", title: "整理验收清单", kind: null,
      content: "旧清单过时\n\n期望结果\n新清单", acceptance: "本人用过新清单", owner: roles.verify.id, acceptanceMode: "human_required", useRequired: true,
      consumer: "chen-pm" });
    await create.context().close();

    // 创建日程: the same chooser, submitted once.
    const schedules = await open(`/p/${projectId}/schedules`);
    await schedules.getByRole("heading", { name: "日程" }).first().waitFor();
    await schedules.getByRole("button", { name: "创建日程" }).first().click();
    await schedules.locator("summary", { hasText: "创建日程" }).click();
    const scheduleForm = schedules.getByRole("form", { name: "创建日程" });
    const scheduleConsumer = scheduleForm.getByLabel(/^指定验收人/);
    await scheduleForm.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    await scheduleForm.getByLabel("任务验收方式").selectOption("human_required");
    await scheduleForm.locator("option", { hasText: "chen-pm · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(scheduleConsumer), ["选择成员", `${actorId} · 人`, "chen-pm · 人"]);
    await scheduleConsumer.selectOption(actorId);
    await scheduleForm.getByLabel(/^仅一次：日期和时间/).fill("2026-11-12T09:30");
    await scheduleForm.getByLabel("新提议任务的名称").fill("季度巡检");
    await scheduleForm.getByLabel("新任务正文（Markdown）").fill("按清单核对");
    await scheduleForm.getByLabel("新提议任务的接受条件").fill("留下报告");
    const scheduleOwner = scheduleForm.getByLabel("任务负责职责");
    await scheduleOwner.locator("option", { hasText: roles.verify.title }).waitFor({ state: "attached" });
    await scheduleOwner.selectOption(roles.verify.id);
    await scheduleForm.getByLabel("理由与依据").fill("开始季度巡检");
    await shoot(schedules, "members-schedule");
    await scheduleForm.getByRole("button", { name: "创建日程" }).click();
    assert.deepEqual(fixed(await sentOf(schedules, "schedule.create"), ["scheduleId", "revisionId", "watermarkUtc"]), {
      type: "schedule.create", state: "active", timezone: "Asia/Shanghai", rule: { kind: "once", atUtc: "2026-11-12T01:30:00.000Z" },
      misfire: { kind: "latest" }, overlap: "skip",
      template: { title: "季度巡检", content: "按清单核对", acceptance: "留下报告", owner: roles.verify.id, acceptanceMode: "human_required", consumer: actorId },
      authorization: { scopeId: "scope-verify", roleId: roles.verify.id, authorizedBy: actorId, expiresAtUtc: null }, reason: "开始季度巡检" });
    await schedules.context().close();

    // 保存日程修订 on the fixture's daily schedule: another person chosen, submitted once.
    const revising = await open(`/p/${projectId}/schedules`);
    const card = revising.locator(".schedule-definition");
    await card.getByText("每日验收巡检", { exact: true }).first().waitFor();
    await card.locator("summary", { hasText: "修订规则、暂停或恢复" }).click();
    await card.locator("summary", { hasText: "保存日程修订" }).click();
    const revise = card.getByRole("form", { name: "保存日程修订" });
    const reviseConsumer = revise.getByLabel(/^指定验收人/);
    await revise.locator("option", { hasText: "chen-pm · 人" }).waitFor({ state: "attached" });
    assert.equal(await reviseConsumer.inputValue(), actorId, "the registered person is on screen");
    await reviseConsumer.selectOption("chen-pm");
    await revise.getByLabel("理由与依据").fill("换成产品验收");
    await revise.getByRole("button", { name: "保存日程修订" }).click();
    const daily = id(1400);
    assert.deepEqual(fixed(await sentOf(revising, "schedule.revise"), ["revisionId"]), {
      type: "schedule.revise", scheduleId: daily, expectedVersion: 1, state: "active", timezone: "Asia/Shanghai", rule: { kind: "daily", localTime: "09:00" },
      misfire: { kind: "latest" }, overlap: "skip",
      template: { title: "每日验收巡检", content: "每日验收巡检：核对来源并留下报告", acceptance: "报告写明读到的范围", owner: roles.verify.id,
        acceptanceMode: "human_required", consumer: "chen-pm" },
      authorization: { scopeId: "scope-verify", roleId: roles.verify.id, authorizedBy: actorId, expiresAtUtc: null }, reason: "换成产品验收" });
    await revising.context().close();

    // A member list that cannot be read is said, and the identity typed.
    state.members = "fail";
    const failed = await open(`/p/${projectId}/schedules`);
    await failed.getByRole("button", { name: "创建日程" }).first().click();
    await failed.locator("summary", { hasText: "创建日程" }).click();
    const failedForm = failed.getByRole("form", { name: "创建日程" });
    await failedForm.getByText(/本项目的成员没有读回：.*读回之前无法判断谁可选，可以按完整标识填写/).waitFor({ timeout: 20000 });
    await failedForm.getByLabel(/^指定验收人/).fill(actorId);
    await failed.context().close();
    assert.deepEqual(errors, []);
  });
