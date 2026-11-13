// Built-app regression that runs in CI (`npm run test:browser`): Tab through the key pages over the screenshot fixture, in
// the light and the dark theme, and require that every element the keyboard reaches shows a focus indicator (the accent
// ring, outline or fill — on the element or, for a bare field inside a styled wrapper, on a near ancestor) and that no
// scroll container clips it (docs/frontend/foundations.md 阴影与层级, WCAG 2.4.7). Acceptance of #402 found rings cut off
// in the left rail and seven controls with none; this keeps both from coming back.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_BROWSER_TEST_REQUIRED=1 in CI).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

/**
 * What the keyboard is on, whether something marks it, and the first container that would cut the mark off. Kept as page
 * source text: the test loader would otherwise wrap its inner functions in a helper the page does not have.
 */
const probe = String.raw`(() => {
  const focused = document.activeElement;
  if (!focused || focused === document.body) return null;
  const accent = /rgb\((47, 75, 179|147, 166, 242)\)/;
  const indicator = el => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && accent.test(s.outlineColor);
    const shadows = s.boxShadow === "none" ? [] : s.boxShadow.split(/,(?![^(]*\))/).map(x => x.trim()).filter(x => accent.test(x) && !/ 0px 0px 0px 0px/.test(x));
    const fill = accent.test(s.backgroundColor);
    if (!outline && !shadows.length && !fill) return null;
    let ext = 0;
    if (outline) ext = Math.max(ext, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    for (const x of shadows) if (!/inset/.test(x)) { const m = /(\d+(?:\.\d+)?)px$/.exec(x); if (m) ext = Math.max(ext, parseFloat(m[1])); }
    return { el, ext: Math.max(0, ext) };
  };
  let found = indicator(focused);
  for (let a = focused.parentElement, depth = 0; !found && a && depth < 4; a = a.parentElement, depth++) found = indicator(a);
  const target = found ? found.el : focused, ext = found ? found.ext : 0;
  const r = target.getBoundingClientRect();
  const box = { l: r.left - ext, t: r.top - ext, r: r.right + ext, b: r.bottom + ext };
  let clipped = null;
  for (let a = target.parentElement; a; a = a.parentElement) {
    const as = getComputedStyle(a);
    if (as.overflowX === "visible" && as.overflowY === "visible") continue;
    const ar = a.getBoundingClientRect();
    const cut = [box.l < ar.left - 0.5 && "left", box.r > ar.right + 0.5 && "right", box.t < ar.top - 0.5 && "top", box.b > ar.bottom + 0.5 && "bottom"].filter(Boolean);
    if (cut.length) { clipped = cut.join("+") + " by <" + a.tagName.toLowerCase() + " class=\"" + String(a.className).slice(0, 60) + "\">"; break; }
  }
  const name = (focused.getAttribute("aria-label") || focused.textContent || focused.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return { key: focused.tagName.toLowerCase() + ":" + name, visible: !!found, clipped };
})()`;
type Probe = { key: string; visible: boolean; clipped: string | null } | null;

test("every element the keyboard reaches shows a focus ring that no scroll container cuts off", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { NOW, projectId, token, agentKey } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const { tasks } = await import(pathToFileURL(`${fixtureDir}/work.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const pages: Record<string, string> = { agent: `sessions?session=${encodeURIComponent(agentKey("dev"))}`, arrangement: "sessions", tasks: "tasks",
    task: `tasks/${tasks.t1.id}`, overview: "overview" };
  const problems: string[] = [];
  let reached = 0;
  for (const scheme of ["light", "dark"] as const) for (const [label, path] of Object.entries(pages)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
    await context.clock.setFixedTime(NOW);
    const page = await context.newPage();
    await page.goto(`${fixture.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { level: 1 }).filter({ visible: true }).first().waitFor();
    await page.waitForTimeout(1200);
    await page.mouse.click(5, 450);
    const seen = new Set<string>();
    for (let step = 0; step < 90; step++) {
      await page.keyboard.press("Tab");
      // The ring may take a frame or a short transition to settle: look again before calling it missing.
      let info = await page.evaluate(probe) as Probe;
      for (let tries = 0; info && (!info.visible || info.clipped) && tries < 8; tries++) { await page.waitForTimeout(60); info = await page.evaluate(probe) as Probe; }
      if (!info || seen.has(info.key)) continue;
      seen.add(info.key); reached++;
      if (!info.visible) problems.push(`${scheme} ${label}: no focus ring on ${info.key}`);
      else if (info.clipped) problems.push(`${scheme} ${label}: ring of ${info.key} clipped ${info.clipped}`);
    }
    await context.close();
  }
  assert.ok(reached > 150, `the walk reached the pages' controls (${reached})`);
  assert.deepEqual(problems, []);
});
