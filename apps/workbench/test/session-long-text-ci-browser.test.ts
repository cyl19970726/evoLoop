// Built-app regression (set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench), Task b2daa3b1: on the agent page a long
// message with an unbroken path stays inside the conversation and folds; a reply the source cut short folds at a block boundary and says so;
// complete web addresses are links; a paused provider is named in the header and above the composer in the banner's words, and an
// unpaused agent has neither. The screenshot fixture, at 1440×900 and 390×844, light and dark, without sideways scrolling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

async function setup(t: { after(fn: () => unknown): void }) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const common = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const open = async (width: number, height: number, scheme: "light" | "dark"): Promise<any> => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce", colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(common.agentKey("dev"))}`);
    await page.getByLabel("访问令牌").fill(common.token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("[data-workspace-entry]").first().waitFor();
    return page;
  };
  return { open };
}

test("a long message stays in the conversation and folds; a cut reply folds at a block; addresses are links", { skip }, async t => {
  process.env.FIXTURE_LONG_TEXT = "1"; t.after(() => { delete process.env.FIXTURE_LONG_TEXT; });
  const { open } = await setup(t);
  for (const [width, height, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"]] as const) {
    const page = await open(width, height, scheme);
    const label = `${width} ${scheme}`;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${label}: no sideways scrolling`);
    const mine = page.locator('article[aria-label="我发出的消息"]').last();
    const box = await mine.evaluate((el: Element) => { const bubble = el.querySelector(".bg-user-bubble")!.getBoundingClientRect(); return { left: bubble.left, right: bubble.right }; });
    assert.ok(box.left >= 0 && box.right <= width, `${label}: the bubble (${box.left}..${box.right}) stays inside the window`);
    // the path is on screen from its first character, and the long message is folded with a way to open it
    assert.match(await mine.innerText(), /\/Users\/shared\/workspaces\/evoloop\/deep-directory-name-/);
    const fold = mine.locator("[data-message-fold]");
    assert.match(await fold.innerText(), /展开，还有 \d+ 行/);
    assert.equal(await mine.locator("[data-message-code]").count(), 1, `${label}: the code fence is drawn as code`);
    await fold.click();
    assert.equal(await fold.innerText(), "收起");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${label}: opened, still no sideways scrolling`);
    // a reply cut inside a code block: whole blocks only, the cut said in words, the full text one press away
    const cut = page.locator('article[data-workspace-entry="answer-long"]');
    const text = await cut.innerText();
    assert.match(text, /第二段说明，也完整。/); assert.match(text, /表格第二行/);
    assert.doesNotMatch(text, /const a = 1/, `${label}: nothing from the cut code block is shown`);
    assert.match(await cut.locator("[data-reply-cut]").innerText(), /已显示前 \d+ 字，后面还有内容/);
    assert.equal(await cut.getByRole("button", { name: "读取完整回复" }).count(), 1);
    // complete addresses are links that leave in a new tab; a bare domain is not guessed into one
    const hrefs = await page.locator('article a[target="_blank"]').evaluateAll((links: Element[]) => links.map(link => link.getAttribute("href")));
    assert.deepEqual(hrefs, ["https://example.com/docs/chat-panel?tab=long#section", "https://github.com/cyl19970726/evoLoop/pull/516"]);
    assert.equal(await page.locator('article a[target="_blank"]').first().getAttribute("rel"), "noopener noreferrer");
    // a short message and a short reply read as before: no fold, no cut note
    const short = page.locator('article[data-workspace-entry="answer-2"]');
    assert.equal(await short.locator("[data-reply-cut]").count(), 0);
    await page.context().close();
  }
});

test("a paused provider is named in the header and above the composer in the banner's words; an unpaused agent has neither", { skip }, async t => {
  const { open } = await setup(t);
  for (const category of [undefined, "quota_exhausted", "authentication_failed"]) {
    if (category) { process.env.FIXTURE_HOLD = "1"; process.env.FIXTURE_HOLD_CATEGORY = category; } else delete process.env.FIXTURE_HOLD;
    t.after(() => { delete process.env.FIXTURE_HOLD; delete process.env.FIXTURE_HOLD_CATEGORY; });
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await open(width, height, "light");
      const status = (await page.locator(".session-status-badge").allInnerTexts()).join(" ");
      const note = page.getByText("现在发的消息会保存排队，恢复前不会处理。");
      if (!category) {
        assert.doesNotMatch(status, /已暂停/); assert.equal(await note.count(), 0, "an unpaused agent has no pause sentence");
      } else {
        const cause = category === "authentication_failed" ? "Codex 鉴权失败" : "Codex 额度用完";
        assert.equal(status.includes(`已暂停（${cause}）`), true, `${width} ${category}: header says ${status}`);
        assert.equal(await note.count(), 1); assert.match(await note.first().innerText(), new RegExp(`已暂停（${cause}）`));
        assert.match(await page.getByText(/^模型服务 Codex .*新的运行已暂停/).first().innerText(), new RegExp(cause), "the site banner uses the same words");
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      await page.context().close();
    }
  }
});

test("读取完整回复 expands a cut reply to its whole text, with no mismatch error, light and dark", { skip }, async t => {
  process.env.FIXTURE_LONG_TEXT = "1"; t.after(() => { delete process.env.FIXTURE_LONG_TEXT; });
  const { open } = await setup(t);
  for (const scheme of ["light", "dark"] as const) {
    const page = await open(1440, 900, scheme);
    const cut = page.locator('[data-workspace-entry="answer-long"]');
    await cut.locator("[data-reply-cut]").waitFor();
    assert.doesNotMatch(await cut.innerText(), /const a = 1/, `${scheme}: the cut text hides the code block`);
    await cut.getByRole("button", { name: "读取完整回复" }).click();
    await cut.locator("[data-reply-full]").waitFor();
    assert.match(await cut.locator("[data-reply-full]").innerText(), /已读取完整回复，共 \d+ 字/);
    assert.match(await cut.innerText(), /const c = compute\(a, b\)/, `${scheme}: the code block after the cut point is shown`);
    assert.match(await cut.innerText(), /后续第 8 段说明/, `${scheme}: the last paragraph is shown`);
    assert.equal(await page.getByText("正文与所选消息不符").count(), 0);
    assert.equal(await cut.locator("[data-reply-cut]").count(), 0);
    await page.context().close();
  }
});
