// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 创建日程 and 保存日程修订 without raw IDs or UTC: the responsible role and the grant are chosen by name, the time is
// typed on the schedule's own clock and previewed as the coordinator will read it (a daylight-saving gap is refused),
// and the commands carry the same role ID, grant and UTC instant the old form asked the person to type. Screenshots at
// 1440, 1024 and 390 go to EVOLOOP_SCHEDULE_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_SCHEDULE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `45000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), otherRole = id(3);
const stamp = "2026-11-10T01:00:00.000Z";
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;
const role = (roleKey: string, title: string) => ({ projectId, id: roleKey, version: 1, currentRevisionId: roleKey, state: "active", proposal: { title },
  proposedBy: "reader", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null });

test("创建日程 and 保存日程修订: role and grant by name, a local time on the schedule's clock, the same command as before",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const commands: Array<Record<string, any>> = [];
    let schedules: unknown[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const body = await new Promise<string>(done => { let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => done(text)); });
        const base = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (url.pathname === base) value = { id: projectId, title: "日程表单项目", createdAt: stamp };
        else if (url.pathname === `${base}/impacts`) value = [];
        else if (url.pathname === `${base}/schedules`) value = schedules;
        else if (url.pathname === `${base}/scheduling/status`) value = { state: "idle", lastTickAt: stamp, lastError: null, lastCreated: 0,
          grants: [{ projectId, actorId: "reader", scopeId: "acceptance-schedules", roleId }] };
        else if (url.pathname === `${base}/roles`) value = { items: [role(roleId, "巡检职责"), role(otherRole, "发布职责")], nextCursor: null };
        else if (url.pathname === `${base}/roles/${roleId}`) value = role(roleId, "巡检职责");
        else if (url.pathname === `${base}/roles/${otherRole}`) value = role(otherRole, "发布职责");
        else if (/\/schedules\/[^/]+\/revisions$/.test(url.pathname)) value = schedules.map(item => (item as { revision: unknown }).revision);
        else if (/\/schedules\/[^/]+\/occurrences$/.test(url.pathname)) value = [];
        else if (url.pathname === "/api/commands" && req.method === "POST") {
          const command = JSON.parse(body) as Record<string, any>;
          commands.push(command);
          if (command.type === "schedule.create") {
            const { type: _, operationId: __, projectId: ___, scheduleId, revisionId, watermarkUtc, state, ...rest } = command;
            schedules = [{ projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state, watermarkUtc,
              revision: { projectId, scheduleId, id: revisionId, version: 1, ...rest, actorId: "reader", createdAtUtc: stamp } }];
          }
          value = { status: "applied", operationId: command.operationId, entityId: command.scheduleId };
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
    const until = async (check: () => boolean, label: string) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(done => setTimeout(done, 50));
      assert.ok(check(), label);
    };
    await page.goto(`${origin}/p/${projectId}/schedules`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();

    // No schedule yet: the create form is open. The role and the grant are offered by name.
    const form = page.getByRole("form", { name: "创建日程" });
    await page.locator("summary", { hasText: "创建日程" }).click();
    await form.waitFor();
    const owner = form.getByLabel("任务负责职责");
    await owner.locator("option", { hasText: "巡检职责" }).waitFor({ state: "attached" });
    assert.deepEqual(await owner.locator("option").allInnerTexts(), ["请选择", "发布职责", "巡检职责"]);
    assert.deepEqual(await form.getByLabel("日程授权").locator("option").allInnerTexts(), ["按职责“巡检职责”授权"]);
    assert.equal(await form.getByLabel("任务验收方式").locator("option").first().innerText(), "独立智能体验收");
    assert.equal(await form.getByLabel(/^仅一次：日期和时间/).getAttribute("type"), "datetime-local");
    await shot("schedule-form-1440-01-empty");

    await form.getByLabel("时区", { exact: true }).selectOption("America/New_York");
    // A time the zone skips (spring forward) is refused before sending, in words.
    await form.getByLabel(/^仅一次：日期和时间/).fill("2027-03-14T02:30");
    await form.getByText("所选时区没有这个时刻（夏令时调整），请换一个时间。").waitFor();
    await form.getByLabel(/^仅一次：日期和时间/).fill("2026-11-12T09:30");
    await form.getByText(/^按纽约时间 2026\/11\/12 09:30.*记录为 2026-11-12 14:30 UTC。$/).waitFor();
    await form.getByLabel("新提议任务的名称").fill("季度巡检");
    await form.getByLabel("新任务正文（Markdown）").fill("按清单核对");
    await form.getByLabel("新提议任务的接受条件").fill("留下报告");
    await owner.selectOption({ label: "巡检职责" });
    await form.getByLabel("理由与依据").fill("开始季度巡检");
    for (const text of [await form.innerText()]) {
      assert.doesNotMatch(text, uuid, "no raw ID in the form");
      assert.doesNotMatch(text, /IANA|ISO 8601|Agent|角色 ID|acceptance-schedules/, "the page's own words");
    }
    // The identifiers chosen are one click away.
    const ownerIds = form.locator("[data-field-preview=owner]");
    await ownerIds.getByText("完整标识").click();
    assert.match(await ownerIds.innerText(), new RegExp(roleId));
    const grantIds = form.locator("[data-field-preview=grant]");
    await grantIds.getByText("完整标识").click();
    assert.match(await grantIds.innerText(), /acceptance-schedules/);
    await shot("schedule-form-1440-02-filled");
    await form.getByRole("button", { name: "创建日程" }).click();
    await until(() => commands.some(command => command.type === "schedule.create"), "the schedule is created");
    const created = commands.find(command => command.type === "schedule.create")!;
    assert.equal(created.timezone, "America/New_York");
    assert.deepEqual(created.rule, { kind: "once", atUtc: "2026-11-12T14:30:00.000Z" });
    assert.equal(created.template.owner, roleId);
    assert.deepEqual(created.authorization, { scopeId: "acceptance-schedules", roleId, authorizedBy: "reader", expiresAtUtc: null });
    assert.equal(created.template.acceptanceMode, "independent_agent");

    // The revision form opens on the schedule's own clock and names; pausing sends the same rule and grant.
    const card = page.locator(".schedule-definition");
    await card.getByText("季度巡检", { exact: true }).first().waitFor();
    await card.locator("summary", { hasText: "修订规则、暂停或恢复" }).click();
    const revise = card.getByRole("form", { name: "保存日程修订" });
    await card.locator("summary", { hasText: "保存日程修订" }).click();
    await revise.waitFor();
    assert.equal(await revise.getByLabel(/^仅一次：日期和时间/).inputValue(), "2026-11-12T09:30");
    assert.equal(await revise.getByLabel("时区", { exact: true }).inputValue(), "America/New_York");
    assert.equal(await revise.getByLabel("任务负责职责").locator("option:checked").innerText(), "巡检职责");
    await revise.getByLabel("日程状态").selectOption("paused");
    await revise.getByLabel("理由与依据").fill("先暂停");
    await shot("schedule-form-1440-03-revise");
    await revise.getByRole("button", { name: "保存日程修订" }).click();
    await until(() => commands.some(command => command.type === "schedule.revise"), "the revision is sent");
    const revised = commands.find(command => command.type === "schedule.revise")!;
    assert.deepEqual([revised.state, revised.timezone, revised.rule, revised.template.owner, revised.authorization],
      ["paused", "America/New_York", created.rule, roleId, created.authorization]);

    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await page.getByRole("dialog").count(), 0, "the right drawer does not open by itself");
    await shot("schedule-form-1024");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the form fits 390px");
    await shot("schedule-form-390");
    assert.deepEqual(errors, []);
  });
