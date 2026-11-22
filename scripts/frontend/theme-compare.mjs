#!/usr/bin/env node
// Real-page pictures for the two theme orientations (Task 0a8b17a6): the built workbench over the screenshot fixture (the same data for every picture), three pages
// (总览, 任务详情, 智能体对话) × light and dark at 1440×900, plus 总览 at 390×844, each as it is now and with 暖调收紧 / 冷调中性 laid over it
// (scripts/frontend/theme-orientations/*.css). Same file names across variants so they compare one by one. Writes the PNGs, manifest.json (SHA-256 of every picture) and index.html
// (the pictures side by side). Nothing here changes the live style.
//
//   npm run build --workspace @evoloop/workbench
//   EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.js node --import tsx scripts/frontend/theme-compare.mjs --out /some/private/dir
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(option("--out") ?? "/tmp/theme-compare");
const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
if (!modulePath) { console.error("Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE to playwright's index.js"); process.exit(2); }
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || undefined;
const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
const { startFixtureServer } = await import("./fixture/server.mjs");
const { token } = await import("./fixture/common.mjs");
const { scenes } = await import("./pages.mjs");

const variants = ["current", "warm", "cool"];
const sheets = Object.fromEntries(["warm", "cool"].map(name => [name, readFileSync(join(repo, `scripts/frontend/theme-orientations/${name}.css`), "utf8")]));
const pages = [{ id: "overview", title: "总览", scene: "overview", look: "看卡片和底色的分界（暖调下卡片更明显地浮在底色上）、卡片和输入框的圆角（暖调约小一半，冷调更小）、右栏文字的颜色" }, { id: "task", title: "任务详情", scene: "task", look: "看页签条和选中页签的分界、状态胶囊（颜色含义不变）、左栏列表的选中行；冷调下选中和链接都是同一个蓝" }, { id: "agent", title: "智能体对话", scene: "agent", look: "看头像（暖调降低饱和，冷调变灰）、气泡和消息的圆角、右栏卡片与底色的分界；按钮仍是品牌橙" }]
  .map(page => ({ ...page, ...scenes.find(scene => scene.name === page.scene) }));
const shots = [
  ...["light", "dark"].flatMap(mode => pages.map(page => ({ page, mode, width: 1440, height: 900 }))),
  ...["light", "dark"].map(mode => ({ page: pages[0], mode, width: 390, height: 844 })),
];

mkdirSync(join(out, "img"), { recursive: true });
const fixture = await startFixtureServer(join(repo, "apps/workbench/dist"));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const manifest = [];
for (const { page, mode, width, height } of shots) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: mode, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 });
  const tab = await context.newPage();
  await tab.goto(`${fixture.base}${page.path}`);
  await tab.getByLabel("访问令牌").fill(token); await tab.getByRole("button", { name: "进入", exact: true }).click();
  await page.ready(tab); await tab.waitForTimeout(800);
  await tab.evaluate(m => { if (m === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme; }, mode);
  for (const variant of variants) {
    await tab.evaluate(() => document.getElementById("theme-orientation")?.remove());
    if (variant !== "current") await tab.evaluate(css => { const style = document.createElement("style"); style.id = "theme-orientation"; style.textContent = css; document.head.append(style); }, sheets[variant]);
    await tab.mouse.move(0, 0); await tab.waitForTimeout(450);
    const file = `img/${page.id}-${width}-${mode}-${variant}.png`;
    const buffer = await tab.screenshot({ path: join(out, file) });
    manifest.push({ page: page.id, title: page.title, width, height, mode, variant, file, sha256: createHash("sha256").update(buffer).digest("hex") });
    if (page.id === "overview" && width === 1440) { // a zoomed corner of the first card, so the corner radius and the card/background step can be read at a glance
      const crop = `img/corner-${mode}-${variant}.png`;
      await tab.screenshot({ path: join(out, crop), clip: { x: 356, y: 140, width: 110, height: 48 } });
      manifest.push({ page: "corner", title: "放大：卡片的一角", width, height: 48, mode, variant, file: crop, sha256: createHash("sha256").update(readFileSync(join(out, crop))).digest("hex") });
    }
  }
  await context.close();
}
await browser.close(); fixture.close();
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const label = { current: "现在", warm: "暖调收紧", cool: "冷调中性" };
const corner = (mode) => `<section><h2>放大：总览里第一张卡片的左上角 · ${mode === "light" ? "浅色" : "深色"}</h2><p class="look">看哪里：卡片的圆角（线上 14 像素；暖调 8；冷调 6）和卡片与底色的分界。</p><div class="row">${variants.map(v => { const c = manifest.find(m => m.page === "corner" && m.mode === mode && m.variant === v); return `<figure><figcaption>${label[v]} <code>${c.sha256.slice(0, 12)}</code></figcaption><img src="${c.file}" width="440" style="image-rendering:pixelated"></figure>`; }).join("")}</div></section>`;
const rows = shots.map(({ page, mode, width }) => {
  const cells = variants.map(v => manifest.find(m => m.page === page.id && m.width === width && m.mode === mode && m.variant === v));
  return `<section><h2>${page.title} · ${width} 宽 · ${mode === "light" ? "浅色" : "深色"}</h2><p class="look">看哪里：${page.look}</p><div class="row">${cells.map(c => `<figure><figcaption>${label[c.variant]} <code>${c.sha256.slice(0, 12)}</code></figcaption><a href="${c.file}"><img loading="lazy" src="${c.file}" width="${width === 1440 ? 560 : 240}"></a></figure>`).join("")}</div></section>`;
});
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>整体取向对照：现在 / 暖调收紧 / 冷调中性</title><style>body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px;background:#f4f4f2;color:#1c1c1c}h1{font-size:20px}h2{font-size:15px;margin:28px 0 8px}.row{display:flex;gap:16px;align-items:flex-start;overflow-x:auto}figure{margin:0}figcaption{margin-bottom:4px;font-weight:600}img{border:1px solid #cfcfcf;border-radius:4px;display:block}p.look{margin:0 0 8px;color:#444}code{color:#777;font-size:11px;font-weight:400}</style><h1>整体取向对照：现在 / 暖调收紧 / 冷调中性</h1><p>同一份数据、同名文件逐张对照；每张图旁是 SHA-256 前 12 位，完整值在 manifest.json。点图看原图。</p>${corner("light")}${corner("dark")}${rows.join("\n")}`);
console.log(`${manifest.length} pictures → ${out}/index.html`);
