// Opt-in built-app regression (task d4a19e72): the colour theme preference 跟随系统 / 浅色 / 深色 is in the account menu on every page, kept in this
// browser only, applied before the first paint, follows the system's light/dark switch without a reload while it is 跟随系统, falls back to 跟随系统 when
// storage cannot be read, and the /ui sample page's own switch never changes it. Build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
// EVOLOOP_THEME_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_THEME_SCREENSHOT_DIR;
const dist = process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist");
const projectId = "35000001-0000-4000-8000-000000000001";
const stamp = "2026-11-15T00:00:00.000Z";

test("the theme choice is in the account menu, persists in this browser, follows the system, applies before first paint, and survives unreadable storage and the /ui sample", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  if (shots) mkdirSync(shots, { recursive: true });
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === "/api/projects") value = [{ id: projectId, title: "主题夹具", createdAt: stamp }];
      else if (url.pathname === `/api/projects/${projectId}`) value = { id: projectId, title: "主题夹具", createdAt: stamp };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      // The real server's policy: no inline script, so the pre-paint rule must be a file of its own.
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());

  type Scheme = "light" | "dark";
  const open = async (opts: { width: number; height: number; scheme: Scheme; stored?: string; brokenStorage?: boolean; path?: string }) => {
    const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, colorScheme: opts.scheme });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });
    // Every value data-theme takes on <html> from the first moment, to see a flash of the other theme.
    await page.addInitScript(({ stored, broken }: { stored?: string; broken?: boolean }) => {
      if (broken) Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
      else if (stored && !sessionStorage.getItem("seeded")) { localStorage.setItem("evoloop.theme", stored); sessionStorage.setItem("seeded", "1"); }
      // Every change of data-theme on <html>, with whether <body> existed yet: the rule must run in <head>, before anything can be painted.
      const seen: string[] = [];
      (window as unknown as { __themeSeen: string[] }).__themeSeen = seen;
      new MutationObserver(records => { for (const r of records) seen.push(`${(r.target as HTMLElement).dataset.theme ?? "light"}${document.body ? " after body" : " before body"}`); })
        .observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme"] });
    }, { stored: opts.stored, broken: opts.brokenStorage });
    await page.goto(`${base}${opts.path ?? `/p/${projectId}/tasks`}`);
    return { page, context, errors };
  };
  const login = async (page: any) => { await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click(); };
  const theme = (page: any) => page.evaluate(() => document.documentElement.dataset.theme ?? "light");
  const seen = (page: any) => page.evaluate(() => (window as unknown as { __themeSeen: string[] }).__themeSeen);
  const openMenu = async (page: any) => {
    await page.getByRole("button", { name: /设置与账号|账号与设置/ }).first().click();
    await page.getByRole("group", { name: "外观" }).waitFor({ timeout: 15000 });
  };
  const choose = async (page: any, label: string) => { await openMenu(page); await page.getByRole("menuitemradio", { name: label }).click(); };
  const stored = (page: any) => page.evaluate(() => localStorage.getItem("evoloop.theme"));
  const bg = (page: any) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const label = `${width}`;
    // Default: 跟随系统, with the menu on a page that is not the overview. The system says dark, the page is dark, with no reload when the system turns light.
    {
      const r = await open({ width, height, scheme: "dark" }); await login(r.page);
      await r.page.getByRole("button", { name: /设置与账号|账号与设置/ }).first().waitFor({ timeout: 30000 });
      assert.equal(await theme(r.page), "dark", `${label}: a first visit follows the system (dark)`);
      assert.deepEqual(await seen(r.page), ["dark before body"], `${label}: dark from the first moment, no flash of light (${JSON.stringify(await seen(r.page))})`);
      const darkBg = await bg(r.page);
      await openMenu(r.page);
      assert.equal(await r.page.getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked"), "true", `${label}: 跟随系统 is the selected choice`);
      assert.equal(await r.page.getByRole("menuitemradio", { name: "深色" }).getAttribute("aria-checked"), "false");
      if (shots) { await new Promise(done => setTimeout(done, 400)); await r.page.screenshot({ path: `${shots}/menu-${width}-dark.png` }); }
      await r.page.keyboard.press("Escape");
      await r.page.emulateMedia({ colorScheme: "light" });
      await r.page.waitForFunction(() => !document.documentElement.dataset.theme);
      assert.notEqual(await bg(r.page), darkBg, `${label}: the page background changed with the system, no reload`);
      await r.page.emulateMedia({ colorScheme: "dark" });
      await r.page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      assert.deepEqual(r.errors, [], `${label}: no page or CSP errors`);
      await r.context.close();
    }
    // 浅色 and 深色 override the system, are kept (storage), and survive a reload (the pre-paint rule, no flash).
    for (const [choice, system, expected, other] of [["浅色", "dark", "light", "dark"], ["深色", "light", "dark", "light"]] as const) {
      const r = await open({ width, height, scheme: system }); await login(r.page);
      await r.page.getByRole("button", { name: /设置与账号|账号与设置/ }).first().waitFor({ timeout: 30000 });
      await choose(r.page, choice);
      assert.equal(await theme(r.page), expected, `${label}: ${choice} applies at once`);
      assert.equal(await stored(r.page), expected, `${label}: ${choice} is kept in this browser`);
      await r.page.emulateMedia({ colorScheme: other });
      await new Promise(done => setTimeout(done, 300));
      assert.equal(await theme(r.page), expected, `${label}: ${choice} ignores a system switch`);
      if (shots) { await r.page.screenshot({ path: `${shots}/page-${width}-${expected}.png` }); }
      await r.page.reload();
      assert.deepEqual(await seen(r.page), expected === "dark" ? ["dark before body"] : [], `${label}: after a reload ${choice} is there from the first moment (light: never dark) (${JSON.stringify(await seen(r.page))})`);
      await login(r.page); await r.page.getByRole("button", { name: /设置与账号|账号与设置/ }).first().waitFor({ timeout: 30000 });
      await openMenu(r.page);
      assert.equal(await r.page.getByRole("menuitemradio", { name: choice }).getAttribute("aria-checked"), "true", `${label}: the menu shows ${choice} after a reload`);
      await r.page.keyboard.press("Escape");
      // Back to 跟随系统: the stored value is removed and the system rules again.
      await choose(r.page, "跟随系统");
      assert.equal(await stored(r.page), null, `${label}: 跟随系统 removes the stored value`);
      assert.equal(await theme(r.page), other, `${label}: 跟随系统 follows the system (${other}) again`);
      assert.deepEqual(r.errors, []);
      await r.context.close();
    }
    // Storage that cannot be read: 跟随系统, the page still works, choosing still applies for this page.
    {
      const r = await open({ width, height, scheme: "dark", brokenStorage: true }); await login(r.page);
      await r.page.getByRole("button", { name: /设置与账号|账号与设置/ }).first().waitFor({ timeout: 30000 }).catch(async (e: Error) => { throw new Error(`${e.message}; body: ${(await r.page.locator("body").innerText()).slice(0, 500)}; page errors: ${JSON.stringify(r.errors)}`); });
      assert.equal(await theme(r.page), "dark", `${label}: unreadable storage follows the system`);
      await choose(r.page, "浅色");
      assert.equal(await theme(r.page), "light", `${label}: a choice still applies when it cannot be kept`);
      assert.deepEqual(r.errors, [], `${label}: no errors with unreadable storage`);
      await r.context.close();
    }
  }

  // The /ui sample keeps its own switch and never writes the formal preference; the stored value is still there afterwards.
  {
    const r = await open({ width: 1440, height: 900, scheme: "light", stored: "dark", path: "/ui" });
    await r.page.getByRole("tab", { name: "浅色" }).waitFor({ timeout: 30000 });
    await r.page.getByRole("tab", { name: "浅色" }).click();
    assert.equal(await theme(r.page), "light", "the sample's own switch works");
    await r.page.getByRole("tab", { name: "深色" }).click();
    assert.equal(await theme(r.page), "dark");
    await r.page.getByRole("tab", { name: "浅色" }).click();
    assert.equal(await stored(r.page), "dark", "the sample's switch did not change the formal preference");
    await r.page.getByRole("link", { name: "返回工作台" }).click();
    await r.page.waitForFunction(() => document.documentElement.dataset.theme === "dark");   // leaving the sample applies the formal preference again
    await r.context.close();
  }
});
