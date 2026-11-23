// Built-app regression for the overview's three finishing touches (Task cfa6c763; docs/frontend/pages/overview.md): the 每日简报 entry beside 最新复盘, the
// figures of 组织自己在处理 as links to the task list narrowed to a phase, and one sentence — one count — for a provider hold on the overview row, in the bar
// above every page and on 待我处理. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; the fixture service answers the rest.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_OVERVIEW_FINISH_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test("overview finish: 每日简报 entry, phase links on the organisation line, one hold sentence", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token, agents } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const api = `**/api/projects/${projectId}`;
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const doc = (n: number, title: string, updatedDaysAgo: number, kind = "brief") => ({ projectId, id: `e000000${n}-0000-4000-8000-00000000000${n}`, title, kind, status: "published", version: 1,
    currentRevisionId: `e100000${n}-0000-4000-8000-00000000000${n}`, adoptedRevisionId: null, updatedAt: at(updatedDaysAgo), createdAt: at(30) });
  const holdFor = (sessionIds: string[]) => ({ observedAtUtc: at(0), items: [{ projectId, id: "b0000001-0000-4000-8000-000000000001", provider: "codex", state: "held", category: "quota_exhausted", causeSessionId: null,
    causeMessageId: null, reason: "额度", version: 1, openedAt: at(1), releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null,
    impact: sessionIds.map(sessionId => ({ sessionId, gatePhase: null, blockedByQuotaFailure: true, queuedMessages: 0 })), queuedMessages: 0 }] });
  const open = async (width: number, height: number, options: { briefs?: Json[]; holds?: Json; path?: string; scheme?: "light" | "dark" } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme: options.scheme ?? "light" });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    if (options.briefs) await page.route(`${api}/documents?*`, async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("kind") !== "brief") return route.fallback();
      return route.fulfill({ json: { items: options.briefs, nextCursor: null } });
    });
    if (options.holds) await page.route(`${api}/runtime/provider-holds`, route => route.fulfill({ json: options.holds }));
    await page.goto(`${fx.base}/p/${projectId}${options.path ?? "/overview"}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 15000 });
    return { page, context };
  };

  // ---- 每日简报: the newest brief by when its current revision was made, whatever order the list comes in ----
  const briefs = [doc(1, "每日简报 2026-11-20", 3), doc(2, "每日简报 2026-11-22", 1), doc(3, "每日简报 2026-11-21", 2)];
  const first = await open(1440, 900, { briefs });
  await first.page.locator("[data-overview-latest-review]").waitFor({ timeout: 15000 });
  const link = first.page.locator("[data-overview-latest-brief]");
  await link.waitFor();
  assert.equal(await link.innerText(), "每日简报");
  assert.equal(await link.getAttribute("href"), `/p/${projectId}/documents/${briefs[1]!.id}`, "the newest brief");
  assert.ok(await first.page.locator("[data-overview-latest-review]").isVisible(), "最新复盘 stays");
  await first.context.close();
  // An older brief given a new revision becomes the newest.
  const second = await open(1440, 900, { briefs: [briefs[0] && { ...briefs[0], updatedAt: at(0) }, briefs[1], briefs[2]] });
  await second.page.locator("[data-overview-latest-brief]").waitFor({ timeout: 15000 });
  assert.equal(await second.page.locator("[data-overview-latest-brief]").getAttribute("href"), `/p/${projectId}/documents/${briefs[0]!.id}`);
  await second.context.close();
  // No brief in the project: no entry, and 最新复盘 is still there.
  const none = await open(1440, 900, { briefs: [] });
  await none.page.locator("[data-overview-latest-review]").waitFor({ timeout: 15000 });
  await none.page.waitForTimeout(500);
  assert.equal(await none.page.locator("[data-overview-latest-brief]").count(), 0);
  assert.equal(await none.page.getByRole("link", { name: "每日简报" }).count(), 0);
  await none.context.close();

  // ---- 组织自己在处理: each non-zero figure is a link to the task list at that phase, with as many rows as the figure; a zero is not a link ----
  const org = await open(1440, 900, { briefs });
  const line = org.page.locator("[data-overview-block=organisation]");
  await line.waitFor({ timeout: 15000 });
  await org.page.waitForFunction(() => /运行中 \d/.test(document.querySelector("[data-overview-block=organisation] summary")?.textContent ?? ""), null, { timeout: 15000 });
  const figures: Array<{ phase: string; label: string; count: number }> = [];
  for (const [phase, label] of [["running", "运行中"], ["rework", "待返工"], ["awaiting_acceptance", "待验收"], ["blocked", "受阻"]] as const) {
    const text = await line.locator("summary").innerText();
    const count = Number(new RegExp(`${label} (\\d+)`).exec(text)?.[1]);
    assert.ok(Number.isInteger(count), `${label} figure in "${text}"`);
    figures.push({ phase, label, count });
    const links = line.locator(`a[data-organisation-phase=${phase}]`);
    assert.equal(await links.count(), count > 0 ? 1 : 0, `${label} ${count}: a link only when not zero`);
    if (count > 0) assert.equal(await links.getAttribute("href"), `/p/${projectId}/work?phase=${phase}`);
  }
  assert.ok(figures.filter(figure => figure.count > 0).length >= 2, "the fixture has several non-zero figures");
  await org.context.close();
  for (const figure of figures.filter(entry => entry.count > 0)) {
    const again = await open(1440, 900, { briefs });
    const row = again.page.locator("[data-overview-block=organisation]");
    await again.page.waitForFunction(() => /运行中 \d/.test(document.querySelector("[data-overview-block=organisation] summary")?.textContent ?? ""), null, { timeout: 15000 });
    await row.locator(`a[data-organisation-phase=${figure.phase}]`).click();
    await again.page.waitForFunction(phase => new URL(location.href).searchParams.get("phase") === phase, figure.phase);
    assert.match(new URL(again.page.url()).pathname, /\/work$/);
    await again.page.locator("[data-task-row]").first().waitFor({ timeout: 15000 });
    assert.equal(await again.page.locator("[data-task-row]").count(), figure.count, `${figure.label}: the list has ${figure.count} rows`);
    await again.context.close();
  }
  // Another place on the line still opens the 调度动态.
  const fold = await open(1440, 900, { briefs });
  const foldLine = fold.page.locator("[data-overview-block=organisation]");
  await fold.page.waitForFunction(() => /运行中 \d/.test(document.querySelector("[data-overview-block=organisation] summary")?.textContent ?? ""), null, { timeout: 15000 });
  await foldLine.locator("summary svg").click();
  await foldLine.getByRole("region", { name: "调度动态" }).waitFor();
  assert.equal(new URL(fold.page.url()).pathname, `/p/${projectId}/overview`, "opening the fold does not leave the overview");
  await fold.context.close();

  // ---- one hold, one sentence, one count: four agents stopped ----
  const four = ["lead", "dev", "verify", "design"].map(name => agents[name].sessionId as string);
  const sentenceOf = async (page: Json, selector: string) => (await page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim();
  const many = await open(1440, 900, { briefs, holds: holdFor(four) });
  const row = "[data-overview-block=priority] li:has([data-tone=blocked])";
  await many.page.locator(row).first().waitFor({ timeout: 15000 });
  const onOverview = (await sentenceOf(many.page, row)).replace(/^受阻\s*/, "").replace(/\s*自 \d.*$/, "");
  const inBar = await sentenceOf(many.page, "[data-provider-hold-line]");
  assert.match(onOverview, /4 个智能体停着/, `overview row: ${onOverview}`);
  assert.match(inBar, /4 个智能体停着/, `bar: ${inBar}`);
  await many.page.locator(row).first().locator("a").click(); // several agents: the row opens the runtime category of 待我处理
  await many.page.locator("[data-hold-sentence]").waitFor({ timeout: 15000 });
  const onInbox = await sentenceOf(many.page, "[data-hold-sentence]");
  assert.match(onInbox, /4 个智能体停着/, `待我处理: ${onInbox}`);
  assert.ok(inBar.startsWith(onInbox) || inBar.includes(onInbox), "the bar and 待我处理 say the same sentence");
  assert.ok(onOverview.includes(onInbox), "the overview row and 待我处理 say the same sentence");
  if (shots) await many.page.screenshot({ path: `${shots}/inbox-four-1440-light.png` });
  await many.context.close();
  // One affected agent: the sentence says its name, in all three places alike.
  const lone = await open(1440, 900, { briefs, holds: holdFor([agents.lead.sessionId]) });
  await lone.page.locator(row).first().waitFor({ timeout: 15000 });
  await lone.page.waitForFunction(selector => !/^\s*(受阻\s*)?模型服务[^，]*，\s*1 个智能体/.test(document.querySelector(selector)?.textContent ?? "x"), row, { timeout: 15000 }).catch(() => undefined);
  const loneOverview = (await sentenceOf(lone.page, row)).replace(/^受阻\s*/, "").replace(/\s*自 \d.*$/, "");
  const loneBar = await sentenceOf(lone.page, "[data-provider-hold-line]");
  assert.doesNotMatch(loneOverview, /等 \d+ 个/, loneOverview);
  assert.ok(!/1 个智能体停着/.test(loneOverview), `a single agent is named: ${loneOverview}`);
  assert.ok(loneBar.startsWith(loneOverview.replace(/：.*$/, "")) || loneBar.includes(loneOverview.replace(/：.*$/, "")), `bar ${loneBar} / overview ${loneOverview}`);
  await lone.context.close();

  // ---- screenshots and no horizontal overflow, both widths, both schemes ----
  for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const scheme of ["light", "dark"] as const) {
    const view = await open(width, height, { briefs, holds: holdFor(four), scheme });
    await view.page.locator("[data-overview-latest-brief]").waitFor({ timeout: 15000 });
    await view.page.waitForFunction(() => /运行中 \d/.test(document.querySelector("[data-overview-block=organisation] summary")?.textContent ?? ""), null, { timeout: 15000 });
    await view.page.waitForTimeout(600);
    const overflow = await view.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${width}px ${scheme}: horizontal overflow ${overflow}`);
    const top = await view.page.evaluate(() => Math.round(document.querySelector("[data-overview-block=priority]")?.getBoundingClientRect().top ?? -1));
    if (shots) { await view.page.screenshot({ path: `${shots}/overview-${width}-${scheme}.png` }); console.log(`overview ${width} ${scheme}: priority block top ${top}`); }
    await view.context.close();
  }
  assert.deepEqual(errors, []);
});
