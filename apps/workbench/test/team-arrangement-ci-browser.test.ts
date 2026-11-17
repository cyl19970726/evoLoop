// CI browser test (Task 0f8c7a15): one Leader home. Who is free, the queues and the conflicts are on 团队 › 统筹安排 and nowhere else; 运行与接入 and the
// agent directory say so in one sentence with a link; every old address still opens somewhere sensible. At 1440x900 and 390x844.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { id, projectId, serve } from "./arrangement-fixture.ts";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_ARRANGEMENT_SCREENSHOT_DIR;

test("团队 › 统筹安排 is the only page with the arrangement; 运行与接入 and the agent directory point to it; old links open",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { base } = await serve(t);
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE ?? process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH }); t.after(() => browser.close());
    const errors: string[] = [];
    // Inside the app (a link click), as a reader moves: a reload would drop the token the fixture login keeps in memory.
    const go = (page: import("playwright-core").Page, target: string) => page.evaluate(to => { const link = Object.assign(document.createElement("a"), { href: to }); document.body.append(link); link.click(); link.remove(); }, target);
    const arrangementFacts = /冲突与风险|没有承接者的任务|各智能体的安排|个智能体在做事|执行队列|自动循环|安排看板/;
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", error => errors.push(error.message));
      const path = () => new URL(page.url()).pathname + new URL(page.url()).search;
      await page.goto(`${base}/p/${projectId}/arrangement`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
      // 1. 统筹安排 carries the board, the conflicts and (moved here) 编排与队列; its one sentence says what the page is and where the rest lives.
      await page.getByRole("list", { name: "各智能体的安排" }).waitFor();
      await page.getByRole("region", { name: "冲突与风险" }).or(page.getByLabel("概况")).first().waitFor();
      await page.getByRole("heading", { name: "编排与队列" }).waitFor();
      const role = page.locator("[data-page-key]:not([hidden]) [data-page-role]");
      assert.match(await role.innerText(), /统筹安排：谁在做什么、谁空闲、队伍与冲突，是唯一显示安排的页面/);
      assert.equal(await role.locator("a", { hasText: "运行与接入" }).getAttribute("href"), `/p/${projectId}/runtime`);
      assert.equal(await role.locator("a", { hasText: "智能体目录" }).getAttribute("href"), `/p/${projectId}/sessions`);
      if (width === 1440) {
        const nav = page.getByRole("navigation", { name: "工作分区" });
        assert.deepEqual(await nav.locator("ul ul a").evaluateAll(links => links.map(link => link.textContent)), ["统筹安排", "运行与接入", "职责", "分工讨论", "组织复盘", "协作回执"], "团队 lists 统筹安排 first and 运行与接入 second");
        assert.equal(await nav.locator("ul ul a[aria-current=page]").innerText(), "统筹安排");
      }
      if (shots) await page.screenshot({ path: `${shots}/team-arrangement-${width}.png` });

      // 2. 运行与接入: the sentence, the link, and none of the arrangement facts.
      await go(page, `/p/${projectId}/runtime`);
      await page.getByRole("heading", { name: "运行与接入", exact: true }).waitFor({ timeout: 6000 }).catch(async () => assert.fail(`${page.url()} :: ${(await page.locator("body").innerText()).slice(0, 300)} :: ${errors.join(" | ")}`));
      const runtimeRole = page.locator("[data-page-key]:not([hidden]) [data-page-role]");
      assert.match(await runtimeRole.innerText(), /安排看统筹安排/);
      assert.equal(await runtimeRole.locator("a", { hasText: "统筹安排" }).getAttribute("href"), `/p/${projectId}/arrangement`);
      await page.getByRole("heading", { name: "执行服务" }).first().waitFor();
      assert.doesNotMatch(await page.locator("[data-page-key]:not([hidden])").innerText(), arrangementFacts, "运行与接入 shows no arrangement");
      assert.equal(await page.locator("[data-page-key]:not([hidden])").getByRole("heading", { name: "编排与队列" }).count(), 0);
      await runtimeRole.locator("a", { hasText: "统筹安排" }).click();
      await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
      assert.equal(path(), `/p/${projectId}/arrangement`, "the sentence's link opens 统筹安排");
      if (shots) { await go(page, `/p/${projectId}/runtime`); await page.getByRole("heading", { name: "运行与接入", exact: true }).waitFor(); await page.screenshot({ path: `${shots}/team-runtime-${width}.png` }); }

      // 3. The agent directory: only the directory, with the way to 统筹安排.
      await go(page, `/p/${projectId}/sessions`);
      await page.getByRole("heading", { name: "智能体", exact: true }).waitFor();
      assert.equal(await page.locator("[data-page-key]:not([hidden]) .arrangement-page").count(), 0);
      assert.doesNotMatch(await page.locator("[data-page-key]:not([hidden])").innerText(), arrangementFacts, "the agent directory shows no arrangement");
      assert.equal(await page.locator("[data-page-key]:not([hidden]) [data-arrangement-entry]").getAttribute("href"), `/p/${projectId}/arrangement`);
      assert.match(await page.locator("[data-page-key]:not([hidden]) [data-page-role]").innerText(), /智能体目录：选一个智能体/);
      if (shots) await page.screenshot({ path: `${shots}/agents-directory-${width}.png` });

      // 4. Old addresses: each opens (no 404) and lands where it belongs.
      await go(page, `/p/${projectId}/sessions?view=flow`);
      await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
      assert.equal(path(), `/p/${projectId}/arrangement?view=flow`, "/sessions?view=flow opens 统筹安排 › 动态");
      assert.equal(await page.getByRole("tab", { name: "动态" }).getAttribute("aria-selected"), "true");
      await go(page, `/p/${projectId}/runtime?session=owned:${id(2)}`);
      await page.waitForFunction(() => location.pathname.endsWith("/sessions"));
      assert.equal(decodeURIComponent(path()), `/p/${projectId}/sessions?session=owned:${id(2)}`, "an old runtime conversation link opens the agent");
      await go(page, `/p/${projectId}/runtime?session=${id(2)}`);
      await page.locator("[data-page-key]:not([hidden]) [data-session-target]").waitFor();  // the fixture has no managed agents: the page says so instead of failing
      assert.equal(new URL(page.url()).pathname, `/p/${projectId}/runtime`, "a managed-agent link stays on 运行与接入");
      assert.equal(await page.getByRole("heading", { level: 1, name: "找不到这个页面" }).count(), 0);
      await go(page, `/p/${projectId}/sessions?session=owned:${id(2)}`);
      await page.waitForFunction(() => document.querySelector("[data-shell=frame]") !== null);
      assert.equal(await page.getByRole("heading", { level: 1, name: "找不到这个页面" }).count(), 0, "an agent link keeps opening the agent");
      await page.close();
    }
    assert.deepEqual(errors, []);
  });
