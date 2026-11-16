#!/usr/bin/env node
// Before/after pictures for the palette proposals (task 294a4d38): the real built workbench over the screenshot fixture, six pages × 1440×900 and 390×844 × light and
// dark, each as it is now and with proposal A and B applied on top (scripts/frontend/palette-proposals/*.css). Writes the PNGs, manifest.json with the SHA-256 of every
// picture, and index.html — one page that lays the three side by side. Nothing here goes into the public repository but the script and the two sheets.
//
//   npm run build --workspace @evoloop/workbench
//   EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.js node --import tsx scripts/frontend/palette-compare.mjs --out /some/private/dir
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(option("--out") ?? "/tmp/palette-compare");
const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
if (!modulePath) { console.error("Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE to playwright's index.js"); process.exit(2); }
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || undefined;
const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
const { startFixtureServer } = await import("./fixture/server.mjs");
const { projectId, token, agentKey, tasks } = await import("./fixture/common.mjs");
const { scenes } = await import("./pages.mjs");
const { fixtureBoard, fixtureEvents } = await import("../../apps/workbench/src/features/sessions/flow/flowFixtures.ts");

const sheets = { a: readFileSync(join(repo, "scripts/frontend/palette-proposals/a.css"), "utf8"), b: readFileSync(join(repo, "scripts/frontend/palette-proposals/b.css"), "utf8") };
const sceneOf = name => scenes.find(scene => scene.name === name);
const p = path => `/p/${projectId}/${path}`;
const pages = [
  { id: "overview", title: "总览", scene: sceneOf("overview") },
  { id: "tasks", title: "任务列表", scene: sceneOf("tasks") },
  { id: "task-delivery", title: "Task 详情 · 交付与使用", scene: sceneOf("task-delivery") },
  { id: "leader", title: "Leader 会话", path: p(`sessions?session=${encodeURIComponent(agentKey("lead"))}`), ready: page => page.locator("body").getByText("统筹").first().waitFor() },
  { id: "arrangement", title: "统筹安排", scene: sceneOf("arrangement") },
  { id: "flow", title: "动态图", path: p("sessions?view=flow"), flow: true, ready: page => page.locator('[data-node="leader"], [data-node]').first().waitFor() },
];
for (const page of pages) if (page.scene) { page.path = page.scene.path; page.ready = page.scene.ready; }
const sizes = [[1440, 900], [390, 844]];

mkdirSync(join(out, "img"), { recursive: true });
const fixture = await startFixtureServer(join(repo, "apps/workbench/dist"));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const manifest = [];
for (const mode of ["light", "dark"]) for (const [width, height] of sizes) for (const page of pages) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: mode, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 });
  const tab = await context.newPage();
  if (page.flow) {
    const board = { ...fixtureBoard, projectId };
    await tab.route(new RegExp(`/api/projects/${projectId}/work-board(\\?.*)?$`), route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) }));
    await tab.route(new RegExp(`/api/projects/${projectId}/work-board/events`), route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: fixtureEvents, cursor: fixtureBoard.eventSeq, head: fixtureBoard.eventSeq }) }));
    await tab.route(new RegExp(`/api/projects/${projectId}/work-board/stream`), route => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" }));
  }
  await tab.goto(`${fixture.base}${page.path}`);
  await tab.getByLabel("访问令牌").fill(token); await tab.getByRole("button", { name: "进入", exact: true }).click();
  await page.ready(tab); await tab.waitForTimeout(800);
  await tab.evaluate(m => { if (m === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme; }, mode);
  for (const variant of ["current", "a", "b"]) {
    await tab.evaluate(() => document.getElementById("palette-proposal")?.remove());
    if (variant !== "current") await tab.evaluate(css => { const style = document.createElement("style"); style.id = "palette-proposal"; style.textContent = css; document.head.append(style); }, sheets[variant]);
    await tab.mouse.move(0, 0); await tab.waitForTimeout(450);
    const file = `img/${page.id}-${width}-${mode}-${variant}.png`;
    const buffer = await tab.screenshot({ path: join(out, file) });
    manifest.push({ page: page.id, title: page.title, width, height, mode, variant, file, sha256: createHash("sha256").update(buffer).digest("hex") });
  }
  await context.close();
}
await browser.close(); fixture.close();
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const label = { current: "现状", a: "方案 A（小步）", b: "方案 B（大步）" };
const rows = [];
for (const mode of ["light", "dark"]) for (const [width] of sizes) for (const page of pages) {
  const cells = ["current", "a", "b"].map(v => manifest.find(m => m.page === page.id && m.width === width && m.mode === mode && m.variant === v));
  rows.push(`<section><h2>${page.title} · ${width} 宽 · ${mode === "light" ? "浅色" : "深色"}</h2><div class="row">${cells.map(c => `<figure><figcaption>${label[c.variant]} <code>${c.sha256.slice(0, 12)}</code></figcaption><img loading="lazy" src="${c.file}" width="${width === 1440 ? 560 : 240}"></figure>`).join("")}</div></section>`);
}
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>配色小修方案：前后对照</title><style>body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px;background:#f4f2ee;color:#1c1714}h1{font-size:20px}h2{font-size:15px;margin:28px 0 8px}.row{display:flex;gap:16px;align-items:flex-start;overflow-x:auto}figure{margin:0}figcaption{margin-bottom:4px}img{border:1px solid #cfc8bd;border-radius:6px;display:block}code{color:#6a635b;font-size:11px}</style><h1>配色小修方案（宣纸 / 松烟）· 现状与方案 A、B 并排</h1><p>每张图旁是 SHA-256 前 12 位；完整值在 manifest.json。点图可看原图。</p>${rows.join("\n")}`);
console.log(`${manifest.length} pictures → ${out}/index.html`);
