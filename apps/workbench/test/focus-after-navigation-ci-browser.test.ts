// The page moves focus to <main id="workspace-main"> once after a page change, for screen readers (App.tsx). It must not take focus back from something
// the person (or code) has focused since the change (Task 06868d2a: the frame after sign-in took focus from a link just focused, which made the 跳到
// focus-return test fail about once in thirty runs). Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("focus after a page change: a focus the person already chose stays; otherwise the landmark takes it", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    return { context, page };
  };
  const active = (page: { evaluate: Function }) => page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return { id: el?.id ?? "", tag: el?.tagName ?? "", text: (el?.textContent ?? "").trim().slice(0, 12) }; });

  // 1. Focus put on a link in the very task in which the first page appears is still there after the frame that would have moved it.
  {
    const { context, page } = await open();
    // Armed before sign-in: the moment the rail link exists, in the same task as the page's first commit, focus it.
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const link = [...document.querySelectorAll("nav a, aside a")].find(anchor => anchor.textContent?.trim() === "智能体") as HTMLElement | undefined;
        if (link && document.getElementById("workspace-main")) { link.focus(); (window as unknown as { __focusedAt: number }).__focusedAt = performance.now(); observer.disconnect(); }
      });
      document.addEventListener("DOMContentLoaded", () => observer.observe(document.documentElement, { childList: true, subtree: true }));
    });
    await page.goto(`${fx.base}/p/${projectId}/overview`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor();
    await page.waitForFunction(() => (window as unknown as { __focusedAt?: number }).__focusedAt !== undefined, null, { timeout: 15000 });
    await page.waitForTimeout(700); // many frames: the landmark's one move has had every chance to run
    const now = await active(page);
    assert.equal(now.tag, "A", `the link focused at the first commit keeps focus, got ${JSON.stringify(now)}`);
    assert.equal(now.text, "智能体");
    // 2. A page change by link still hands focus to the landmark (the screen-reader behaviour stays).
    await page.getByRole("link", { name: "任务", exact: true }).first().click();
    await page.waitForFunction(() => location.pathname.endsWith("/work"));
    await page.waitForFunction(() => document.activeElement?.id === "workspace-main", null, { timeout: 5000 });
    // 3. And on the next page change by link, the same: the landmark again, once.
    await page.getByRole("link", { name: "文档", exact: true }).first().click();
    await page.waitForFunction(() => location.pathname.endsWith("/documents"));
    await page.waitForFunction(() => document.activeElement?.id === "workspace-main", null, { timeout: 5000 });
    await context.close();
  }
});
