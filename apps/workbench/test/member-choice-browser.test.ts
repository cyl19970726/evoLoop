// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// Choosing an acceptance identity by member name (GET /members) on the screenshot fixture (scripts/frontend/fixture):
// 任务操作 › 修订验收责任, 新建任务 and 创建日程 list only members who can write, of the kind the acceptance mode takes;
// an edited identity file is said with what changes after a restart; the full identity can still be typed; with no member
// list the identity is typed, with the reason. The command sent is the one typing the identity sent before. Screenshots
// at 1440, 1024 and 390 go to EVOLOOP_MEMBERS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { answer } from "../../../scripts/frontend/fixture/api.mjs";
import { projectId, token } from "../../../scripts/frontend/fixture/common.mjs";
import { taskDetail, tasks } from "../../../scripts/frontend/fixture/work.mjs";
import { acceptanceResponsibilityCommand } from "../src/features/workflow/taskCommands.ts";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_MEMBERS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const root = `/api/projects/${projectId}`;

test("验收身份 by member name: only members who can write, of the right kind; typed when there is no list; the same command",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const state = { members: "fixture" as "fixture" | "not_provided" | "fail" };
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

    // 任务操作 › 修订验收责任 on a task to do: 必须本人验收 offers the people who can write; the restart note is said.
    const task = await open(`/p/${projectId}/tasks/${tasks.t5.id}?tab=actions`);
    await task.getByRole("heading", { name: tasks.t5.title, level: 1 }).filter({ visible: true }).first().waitFor();
    const tab = task.getByRole("tabpanel").filter({ visible: true }).first();
    await tab.getByText("修订验收责任", { exact: true }).click();
    const form = tab.locator("form").filter({ has: task.getByRole("button", { name: "保存验收责任" }) });
    await form.getByLabel("验收方式").selectOption("human_required");
    const consumer = form.getByLabel("指定验收身份");
    await form.locator("option", { hasText: "chen-pm · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(consumer), ["不指定", "zhang-reviewer · 人", "chen-pm · 人"]);
    await form.getByText("另有 1 位不能写入、2 位不是人，没有列出。").waitFor();
    await form.getByText("身份文件已改动，部分成员的权限要重启后才生效").waitFor();
    await form.getByText("chen-pm：重启后才能复核").waitFor();
    // An independent agent: the agents who can write.
    await form.getByLabel("验收方式").selectOption("independent_agent");
    await form.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(consumer), ["不指定", "verify-agent · 智能体", "loop-controller · 智能体"]);
    await form.getByLabel("验收方式").selectOption("human_required");
    await consumer.selectOption("chen-pm");
    await form.getByLabel("理由").fill("由产品本人验收");
    await shoot(task, "members-task-actions");
    await form.getByRole("button", { name: "保存验收责任" }).click();
    for (let i = 0; i < 100 && !commands.length; i++) await task.waitForTimeout(50);
    const sent = commands.find(command => command.type === "task.update")!;
    assert.ok(sent, "the acceptance responsibility is sent");
    // The body is the one typing the identity built: the chooser hands over the member's identity as it is.
    const { operationId: _operationId, projectId: sentProject, ...rest } = sent;
    assert.equal(sentProject, projectId);
    assert.deepEqual(rest, acceptanceResponsibilityCommand(taskDetail(tasks.t5), { taskVersion: 2 },
      { acceptanceMode: "human_required", consumer: "chen-pm", reason: "由产品本人验收" }));
    await task.context().close();

    // No member list from the service: the identity is typed, with the reason.
    state.members = "not_provided";
    const typed = await open(`/p/${projectId}/tasks/${tasks.t8.id}?tab=actions`);
    await typed.getByRole("heading", { name: tasks.t8.title, level: 1 }).filter({ visible: true }).first().waitFor();
    const typedTab = typed.getByRole("tabpanel").filter({ visible: true }).first();
    await typedTab.getByText("修订验收责任", { exact: true }).click();
    await typedTab.getByText("服务端没有提供本项目的成员清单，请按完整标识填写登录身份。").waitFor();
    await typedTab.getByLabel("指定验收身份").fill("zhang-reviewer");
    assert.equal(await typedTab.getByLabel("指定验收身份").inputValue(), "zhang-reviewer");
    await typed.context().close();

    // 新建任务: the independent agents by default, the people for 必须本人验收; the full identity under its fold.
    state.members = "fixture";
    const create = await open(`/p/${projectId}/tasks/new`);
    await create.getByRole("heading", { name: "新建任务" }).first().waitFor();
    const user = create.getByLabel(/^实际使用成果的身份/);
    await create.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(user), ["不指定", "verify-agent · 智能体", "loop-controller · 智能体"]);
    await create.getByLabel("验收方式").selectOption("human_required");
    await create.locator("option", { hasText: "zhang-reviewer · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(user), ["选择成员", "zhang-reviewer · 人", "chen-pm · 人"], "required for 必须本人验收");
    // A service identity or a same name: typed as a whole under 按完整标识填写; the choice shows it for what it is.
    await create.getByText("按完整标识填写").click();
    await create.getByLabel("完整标识").fill("li-observer");
    assert.equal(await user.inputValue(), "li-observer");
    assert.equal(await user.locator("option:checked").innerText(), "li-observer（当前登记；不能写入）");
    await user.selectOption("zhang-reviewer");
    assert.equal(await create.getByLabel("完整标识").inputValue(), "zhang-reviewer");
    await shoot(create, "members-task-new");
    await create.context().close();

    // 创建日程: the same chooser; a member list that cannot be read is said, and the identity typed.
    const schedules = await open(`/p/${projectId}/schedules`);
    await schedules.getByRole("heading", { name: "日程" }).first().waitFor();
    await schedules.getByRole("button", { name: "创建日程" }).first().click();
    await schedules.locator("summary", { hasText: "创建日程" }).click();
    const scheduleForm = schedules.getByRole("form", { name: "创建日程" });
    const scheduleConsumer = scheduleForm.getByLabel(/^指定验收人/);
    await scheduleForm.locator("option", { hasText: "verify-agent · 智能体" }).waitFor({ state: "attached" });
    await scheduleForm.getByLabel("任务验收方式").selectOption("human_required");
    await scheduleForm.locator("option", { hasText: "chen-pm · 人" }).waitFor({ state: "attached" });
    assert.deepEqual(await options(scheduleConsumer), ["不指定", "zhang-reviewer · 人", "chen-pm · 人"]);
    await scheduleConsumer.selectOption("zhang-reviewer");
    await shoot(schedules, "members-schedule");
    await schedules.context().close();
    state.members = "fail";
    const failed = await open(`/p/${projectId}/schedules`);
    await failed.getByRole("button", { name: "创建日程" }).first().click();
    await failed.locator("summary", { hasText: "创建日程" }).click();
    const failedForm = failed.getByRole("form", { name: "创建日程" });
    await failedForm.getByText(/本项目的成员没有读回：.*读回之前无法判断谁可选，可以按完整标识填写/).waitFor({ timeout: 20000 });
    await failedForm.getByLabel(/^指定验收人/).fill("zhang-reviewer");
    await failed.context().close();
    assert.deepEqual(errors, []);
  });
