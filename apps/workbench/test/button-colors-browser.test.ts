// Built-app regression (design language of 2026-11-22, replaces DEC-051's terracotta/soft-blue): on the component sample page the primary button is brand (ink green) on on-brand,
// the secondary is an outline button (panel colour with a strong hairline), each in its default, hover and pressed state with ≥4.5:1 text contrast read from the computed
// styles; a selected row, tab and menu item is a neutral fill with --text at weight 600 and no edge or outline. Then, over the screenshot fixture, no key page shows more than one
// solid primary button on a screen and no button is filled with the old terracotta.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_BUTTON_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_BUTTON_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const tokens = readFileSync(resolve(import.meta.dirname, "../../../packages/ui/src/tokens.css"), "utf8");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

const darkAt = tokens.indexOf(':root[data-theme="dark"]');
const token = (mode: "light" | "dark", name: string) => (mode === "light" ? tokens.slice(0, darkAt) : tokens.slice(darkAt)).match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!.toLowerCase();
const rgb = (css: string) => { const m = css.match(/rgba?\(([^)]+)\)/); const [r, g, b, a = 1] = m![1]!.split(/[ ,/]+/).filter(Boolean).map(Number) as number[]; return { r: r!, g: g!, b: b!, a }; };
const hex = (css: string) => { const { r, g, b } = rgb(css); return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`; };
const lum = (h: string) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };

test("buttons are ink green, selections are neutral with heavier text, and no key page has more than one solid primary button", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token: signIn } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });
  const settle = (page: any) => page.waitForTimeout(350);   // the colour transition is 150ms
  const colors = (locator: any) => locator.evaluate((el: HTMLElement) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, fg: s.color, opacity: s.opacity }; });

  for (const mode of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${fixture.base}/ui`);
    await page.getByRole("tab", { name: mode === "light" ? "浅色" : "深色" }).click();
    await page.getByRole("heading", { name: "按钮与输入" }).waitFor();

    const check = async (label: string, locator: any, bgToken: string, fgToken: string) => {
      const want = { bg: token(mode, bgToken), fg: token(mode, fgToken) };
      const got = await colors(locator);
      assert.equal(hex(got.bg), want.bg, `${mode} ${label}: background is --${bgToken}`);
      assert.equal(hex(got.fg), want.fg, `${mode} ${label}: text is --${fgToken}`);
      assert.equal(got.opacity, "1", `${mode} ${label}: no opacity`);
      const ratio = contrast(hex(got.bg), hex(got.fg));
      assert.ok(ratio >= 4.5, `${mode} ${label}: contrast ${ratio.toFixed(2)} ≥ 4.5`);
      return ratio;
    };
    const primary = page.getByRole("button", { name: "通过验收" }), secondary = page.getByRole("button", { name: "退回返工" });
    await settle(page);
    await check("primary default", primary, "brand", "on-brand");
    await check("secondary default", secondary, "brand-soft", "on-brand-soft");
    await primary.hover(); await settle(page); await check("primary hover", primary, "brand-hover", "on-brand");
    await page.mouse.down(); await settle(page); await check("primary pressed", primary, "brand-pressed", "on-brand"); await page.mouse.up();
    await secondary.hover(); await settle(page); await check("secondary hover", secondary, "brand-soft-hover", "on-brand-soft");
    await page.mouse.down(); await settle(page); await check("secondary pressed", secondary, "brand-soft-pressed", "on-brand-soft"); await page.mouse.up();
    await page.mouse.move(0, 0);
    // The disabled button stays translucent as before.
    assert.equal((await colors(page.getByRole("button", { name: "不可用" }).first())).opacity, "0.5", `${mode}: a disabled button is half transparent as before`);
    // Selected row and selected tab: the neutral selected fill, --text at weight 600, no edge bar and no outline.
    for (const [label, locator] of [["selected row", page.getByRole("button", { name: /阶段一/ })], ["selected tab", page.getByRole("tab", { selected: true }).first()]] as const) {
      await check(label, locator, "accent-soft", "text");
      const look = await locator.evaluate((el: HTMLElement) => { const st = getComputedStyle(el); return { weight: Number(st.fontWeight), shadow: st.boxShadow }; });
      assert.ok(look.weight >= 600, `${mode} ${label}: weight ${look.weight} ≥ 600`);
      assert.ok(!/inset 3px|color-mix/.test(look.shadow) && (look.shadow === "none" || !look.shadow.includes("0px 0px 0px 1px")), `${mode} ${label}: no edge bar or outline (${look.shadow})`);
    }
    assert.deepEqual(errors, []);
    if (shots) await page.screenshot({ path: `${shots}/ui-${mode}.png`, fullPage: true });
    await context.close();

    // The key pages over the fixture: at most one solid primary button on a screen (what is in the viewport), and none filled with the old terracotta.
    const brand = token(mode, "brand");
    for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const name of ["overview", "tasks", "task", "arrangement", "agent", "team-runtime", "settings"]) {
      const scene = scenes.find((candidate: { name: string }) => candidate.name === name);
      assert.ok(scene, `scene ${name}`);
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: mode, locale: "zh-CN" });
      const p = await ctx.newPage();
      await p.goto(`${fixture.base}${scene.path}`);
      await p.getByLabel("访问令牌").fill(signIn); await p.getByRole("button", { name: "进入", exact: true }).click();
      await scene.ready(p); await settle(p);
      // As a string: the page cannot see helpers the test runner's transform adds to named functions.
      const found: string[] = await p.evaluate(`(() => {
        const brandHex = ${JSON.stringify(brand)}, oldTerracotta = ["#b1582b", "#e18c5f"];
        function toHex(css) { const m = css.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); const a = parts.length > 3 ? parts[3] : 1;
          return a < 0.5 ? null : "#" + parts.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join(""); }
        const out = [];
        for (const el of document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem]")) {
          const box = el.getBoundingClientRect(); if (box.bottom <= 0 || box.top >= innerHeight || box.width < 4 || box.height < 4 || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
          const style = getComputedStyle(el); if (style.visibility === "hidden" || style.display === "none") continue;
          const bg = toHex(style.backgroundColor); if (bg && (bg === brandHex || oldTerracotta.includes(bg))) out.push(((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30)) + " [" + bg + "]");
        }
        return out; })()`);
      assert.ok(found.length <= 1 && found.every(entry => entry.endsWith(`[${brand}]`)), `${mode} ${width} ${name}: solid primary buttons ${JSON.stringify(found)}`);
      if (shots) await p.screenshot({ path: `${shots}/${name}-${width}-${mode}.png` });
      await ctx.close();
    }
  }
});
