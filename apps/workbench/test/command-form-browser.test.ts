// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The one command form (shared/command) on a page that still holds it in an old [data-legacy] region (创建日程): it is
// drawn as new markup, says which required fields are empty, asks before sending after its baseline moved (keep my
// changes / refill / copy), and an unknown result blocks the form until it is checked by its original operation ID,
// after which the applied draft is cleared. Screenshots at 1440, 1024 and 390 go to EVOLOOP_COMMAND_FORM_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_COMMAND_FORM_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `43100${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), otherRoleId = id(3);
const stamp = "2026-11-10T01:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Mirrors core's canonicalJson, so the lost answer can be confirmed by its operation digest.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);

test("the command form in an old region: new markup, required fields, a moved baseline asks, an unknown result is checked by its original ID",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const state = { grants: [{ projectId, actorId: "reader", scopeId: "scope-dev", roleId }], commands: [] as Record<string, unknown>[],
      operations: new Map<string, unknown>(), operationReads: [] as string[] };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/__fixture/grants") {
        state.grants = [...state.grants, { projectId, actorId: "reader", scopeId: "scope-ops", roleId: otherRoleId }]; res.end("ok"); return;
      }
      if (url.pathname === "/api/commands" && req.method === "POST") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const command = JSON.parse(raw) as Record<string, unknown>;
        state.commands.push(command);
        // The answer is lost on the way back; the operation itself was applied.
        state.operations.set(String(command.operationId), { id: command.operationId, projectId, actorId: "reader", commandType: command.type,
          commandHash: sha(canonical({ actorId: "reader", command })), createdAt: stamp,
          result: { status: "applied", operationId: command.operationId, entityId: command.scheduleId } });
        res.writeHead(200, { "content-type": "application/json" }); res.end(""); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const base = `/api/projects/${projectId}`;
        if (url.pathname === "/api/session") return json({ principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
        if (url.pathname === base) return json({ id: projectId, title: "表单项目", createdAt: stamp });
        if (url.pathname === `${base}/impacts`) return json([]);
        if (url.pathname === `${base}/schedules`) return json([]);
        if (url.pathname === `${base}/scheduling/status`) return json({ state: "idle", lastTickAt: stamp, lastError: null, lastCreated: 0, grants: state.grants });
        if (url.pathname.startsWith(`${base}/operations/`)) {
          const operationId = url.pathname.split("/").at(-1)!;
          state.operationReads.push(operationId);
          const operation = state.operations.get(operationId);
          return json(operation ?? { code: "OPERATION_NOT_FOUND", message: "没有这个操作" }, operation ? 200 : 404);
        }
        if (url.pathname.startsWith(`${base}/roles/`)) {
          const roleKey = url.pathname.split("/").at(-1)!;
          return json({ projectId, id: roleKey, version: 1, currentRevisionId: roleKey, state: "active", proposal: { title: roleKey === roleId ? "巡检职责" : "运维职责" },
            proposedBy: "reader", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null });
        }
        return json({ items: [], nextCursor: null });
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => { server.close(); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/schedules`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const form = page.getByRole("form", { name: "创建日程" });
    await form.waitFor();

    // New markup even inside the old region: the old global button and field rules do not reach it.
    const look = await form.evaluate(element => {
      const style = (selector: string) => getComputedStyle(element.querySelector(selector)!);
      const submit = element.querySelector<HTMLElement>("button[type=submit]")!;
      return { legacy: !!element.closest("[data-legacy]"), island: element.hasAttribute("data-ui"), submitBorder: style("button[type=submit]").borderTopWidth,
        submitRadius: parseFloat(style("button[type=submit]").borderTopLeftRadius), submitHeight: submit.getBoundingClientRect().height,
        inputBorder: style("input[name=title]").borderTopWidth, labelWeight: style("label").fontWeight };
    });
    assert.deepEqual([look.legacy, look.island], [true, true], "the page still holds this form in an old region; the form marks itself as new markup");
    assert.equal(look.submitBorder, "0px", JSON.stringify(look));
    assert.ok(look.submitRadius >= 15 && look.submitHeight <= 32, `the submit button is the compact pill, not the old 38px button: ${JSON.stringify(look)}`);
    assert.equal(look.inputBorder, "0px");

    // Required fields: sending is refused field by field, and nothing is sent.
    await form.getByRole("button", { name: "创建日程" }).click();
    await form.getByText("请填写新提议任务的名称。").waitFor();
    await form.getByText("请填写理由与依据。").waitFor();
    assert.equal(state.commands.length, 0);
    await form.getByLabel("仅一次：UTC 时刻").fill("2026-11-20T01:00:00Z");
    await form.getByLabel("新提议任务的名称").fill("每周巡检");
    await form.getByLabel("新任务正文（Markdown）").fill("核对来源与漂移");
    await form.getByLabel("新提议任务的接受条件").fill("留下巡检报告");
    await form.getByLabel("任务责任角色 ID").fill(roleId);
    await form.getByLabel("理由与依据").fill("每周需要固定巡检");
    assert.equal(await form.getByText("请填写新提议任务的名称。").count(), 0, "an error goes once the field is filled");
    if (shots) await page.screenshot({ path: `${shots}/command-form-1440.png`, fullPage: true });

    // The grants it was opened on change while the person types: it asks before sending, and says what it keeps.
    await fetch(`${base}/__fixture/grants`);
    await page.getByRole("button", { name: "回读当前状态" }).click();
    await form.getByText("打开表单后内容已被更新").waitFor();
    assert.equal(await form.getByRole("button", { name: "创建日程" }).isDisabled(), true);
    await form.getByRole("button", { name: "复制当前草稿" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/command-form-baseline-1440.png`, fullPage: true });
    await form.getByRole("button", { name: "保留我的修改" }).click();
    assert.equal(await form.getByLabel("理由与依据").inputValue(), "每周需要固定巡检", "the person's changes are kept");
    assert.equal(await form.getByLabel("新提议任务的名称").inputValue(), "每周巡检");

    // The answer is lost: the receipt stays, the form will not send again, and the global notice points to the check.
    await form.getByRole("button", { name: "创建日程" }).click();
    await form.getByText("这次提交的结果未确认").waitFor();
    assert.equal(state.commands.length, 1);
    const sent = state.commands[0]!;
    assert.equal(sent.type, "schedule.create");
    assert.match(String(sent.operationId), /^[0-9a-f-]{36}$/);
    assert.equal(await form.getByRole("button", { name: "创建日程" }).isDisabled(), true);
    await form.getByText(/本项目仍有结果未确认的操作/).waitFor();
    assert.equal(await form.getByLabel("理由与依据").inputValue(), "每周需要固定巡检", "the draft stays while the result is unknown");

    // 1024: the right column is a drawer the page never opens by itself; 390: nothing scrolls sideways.
    await page.setViewportSize({ width: 1024, height: 800 });
    assert.equal(await page.getByRole("dialog").count(), 0, "the right drawer does not open by itself");
    if (shots) await page.screenshot({ path: `${shots}/command-form-unknown-1024.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the form fits 390px");
    if (shots) await page.screenshot({ path: `${shots}/command-form-unknown-390.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Checked by its original operation ID elsewhere: back on the page, the form reads the same operation and clears the draft.
    await page.getByRole("link", { name: "按原操作 ID 核对" }).first().click();
    await page.getByRole("button", { name: "按操作 ID 核对" }).click();
    await page.getByText(/已应用；正在回读当前数据/).waitFor();
    await page.goBack();
    await form.getByText("原操作已核对为已应用，这份草稿已清除。").waitFor();
    assert.equal(await form.getByLabel("理由与依据").inputValue(), "", "the applied draft is cleared");
    assert.equal(state.commands.length, 1, "nothing was sent twice");
    assert.ok(state.operationReads.length >= 2 && state.operationReads.every(key => key === sent.operationId),
      `the check and the form both read the original operation ID only: ${JSON.stringify(state.operationReads)}`);
    assert.deepEqual(errors, []);
  });
