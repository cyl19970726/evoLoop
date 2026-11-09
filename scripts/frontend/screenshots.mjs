#!/usr/bin/env node
// Page screenshots for docs/frontend/pages: builds the workbench, serves it with the synthetic fixture API
// (scripts/frontend/fixture/) and writes docs/assets/frontend-pages/<page>-<width>.png.
//
//   EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.js \
//   EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE=/path/to/chromium \
//   npm run docs:screenshots [-- --only tasks,task --widths 1440 --skip-build --jobs 3 --out <dir>]
//   (--raw keeps Chromium's own PNG instead of the 256-colour one, to compare pixels while debugging.)
//
// Playwright is not a dependency: it is loaded from the same module path the browser tests use. The clock, time zone,
// locale, device scale and motion are fixed, so the same build and fixture give the same pictures; a file is only
// rewritten when its bytes change, and the summary says how many did.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NOW, token } from "./fixture/common.mjs";
import { startFixtureServer } from "./fixture/server.mjs";
import { indexPng } from "./png.mjs";
import { scenes } from "./pages.mjs";

const repo = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = option("--only")?.split(",").map(s => s.trim()).filter(Boolean);
const widthsOnly = option("--widths")?.split(",").map(Number);
const jobs = Math.max(1, Number(option("--jobs") ?? 3));
const out = resolve(repo, option("--out") ?? "docs/assets/frontend-pages");
const dist = join(repo, "apps/workbench/dist");
const viewports = { 1440: { width: 1440, height: 900 }, 1024: { width: 1024, height: 768 }, 390: { width: 390, height: 844 } };

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.error("Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE to playwright's index.js (and EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE if needed).");
  process.exit(2);
}
const executablePath = process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || undefined;

if (!args.includes("--skip-build")) {
  console.log("Building the workbench…");
  execFileSync("npx", ["tsc", "-b", "packages/contracts"], { cwd: repo, stdio: "inherit" });
  execFileSync("npx", ["vite", "build", "--logLevel", "error"], { cwd: join(repo, "apps/workbench"), stdio: "inherit" });
}

const chosen = only ? scenes.filter(scene => only.includes(scene.name)) : scenes;
if (only && chosen.length !== only.length) {
  console.error(`Unknown page: ${only.filter(name => !scenes.some(scene => scene.name === name)).join(", ")}`);
  process.exit(2);
}

// No transitions, animations or blinking caret; the screenshot call also stops CSS animations.
const stillStyle = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";

const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
const fixture = await startFixtureServer(dist);
// Software raster in one pass: GPU and partial raster round anti-aliased edges differently from run to run.
const rasterFlags = ["--disable-gpu", "--disable-gpu-rasterization", "--disable-partial-raster", "--disable-skia-runtime-opts",
  "--force-color-profile=srgb", "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging",
  "--run-all-compositor-stages-before-draw", "--num-raster-threads=1"];
const browser = await chromium.launch({ headless: true, args: rasterFlags, ...(executablePath ? { executablePath } : {}) });
await mkdir(out, { recursive: true });
const results = [];
const problems = [];

/** Waits until no API request has been in flight for `quiet` ms (polling reads may keep starting; cap at `limit`). */
async function settle(page, inflight, quiet = 400, limit = 6000) {
  const start = Date.now();
  let calmSince = Date.now();
  while (Date.now() - start < limit) {
    if (inflight.size) calmSince = Date.now();
    else if (Date.now() - calmSince >= quiet) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))));
}

async function shoot(scene, shot) {
  const context = await browser.newContext({ viewport: viewports[shot.width], deviceScaleFactor: 1, locale: "zh-CN",
    timezoneId: "Asia/Shanghai", colorScheme: "light", reducedMotion: "reduce" });
  context.setDefaultTimeout(15000);
  await context.clock.setFixedTime(NOW);
  await context.addInitScript(style => {
    document.addEventListener("DOMContentLoaded", () => {
      const element = document.createElement("style"); element.textContent = style; document.head.append(element);
    });
  }, stillStyle);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const inflight = new Set();
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) inflight.add(request); });
  const done = request => inflight.delete(request);
  page.on("requestfinished", done); page.on("requestfailed", done);
  try {
    if (scene.before) await scene.before(page);
    await page.goto(`${fixture.base}${scene.path}`);
    if (scene.login !== false) {
      await page.getByLabel("访问令牌").fill(token);
      await page.getByRole("button", { name: "进入", exact: true }).click();
    }
    await scene.ready(page);
    await settle(page, inflight);
    if (shot.drawer) {
      await page.getByRole("button", { name: "展开右栏" }).click();
      // Below 1100px the right column opens as a sheet (role dialog): from the right, or from the bottom below 760px.
      await page.getByRole("dialog", { name: "右栏" }).waitFor();
      await settle(page, inflight);
    }
    if (scene.prepare) { await scene.prepare(page); await settle(page, inflight); }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) problems.push(`${shot.file}: page scrolls sideways by ${overflow}px`);
    const raw = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
    const png = args.includes("--raw") ? raw : indexPng(raw);
    const path = join(out, shot.file);
    await rm(join(out, `failed-${shot.file}`), { force: true });
    const previous = await readFile(path).catch(() => null);
    const state = !previous ? "new" : previous.equals(png) ? "unchanged" : "changed";
    if (state !== "unchanged") await writeFile(path, png);
    results.push({ file: shot.file, state, bytes: png.length });
    for (const error of errors) problems.push(`${shot.file}: page error: ${error}`);
    console.log(`${state.padEnd(9)} ${shot.file} ${(png.length / 1024).toFixed(0)} KB`);
  } catch (error) {
    const detail = await page.locator("main pre").allTextContents().catch(() => []);
    problems.push(`${shot.file}: ${error.message.split("\n")[0]}`);
    console.log(`failed    ${shot.file}: ${error.message.split("\n")[0]}`);
    for (const line of [...errors, ...detail]) console.log(`          ${line.replace(/\s+/g, " ").slice(0, 300)}`);
    await page.screenshot({ path: join(out, `failed-${shot.file}`) }).catch(() => undefined);
  } finally {
    await context.close();
  }
}

// A few pages at a time; every shot has its own browser context, so the order does not change any picture.
const queue = chosen.flatMap(scene => shotsOf(scene).map(shot => [scene, shot]));
try {
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) { const [scene, shot] = queue.shift(); await shoot(scene, shot); }
  }));
} finally {
  await browser.close();
  await fixture.close();
}

/** `widths` (default 1440 and 390) as they open; `drawer` (true = 1024) with the right column opened as a drawer. */
function shotsOf(scene) {
  const plain = (scene.widths ?? [1440, 390]).map(width => ({ width, file: `${scene.name}-${width}.png` }));
  const drawer = (scene.drawer === true ? [1024] : scene.drawer || []).map(width => ({ width, file: `${scene.name}-${width}.png`, drawer: true }));
  return [...plain, ...drawer].filter(shot => !widthsOnly || widthsOnly.includes(shot.width));
}

const count = state => results.filter(result => result.state === state).length;
const written = await readdir(out).then(names => names.filter(name => name.endsWith(".png") && !name.startsWith("failed-")));
let total = 0;
for (const name of written) total += (await stat(join(out, name))).size;
console.log(`\n${results.length} screenshots: ${count("changed")} changed, ${count("new")} new, ${count("unchanged")} unchanged.`);
console.log(`${written.length} files in ${relative(repo, out)}, ${(total / 1024 / 1024).toFixed(2)} MB in all.`);
if (fixture.misses.size) console.log(`Reads the fixture does not answer (served an empty page):\n  ${[...fixture.misses].sort().join("\n  ")}`);
if (problems.length) {
  console.error(`\nProblems:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
}
