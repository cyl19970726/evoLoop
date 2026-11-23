// Task 5415aed3, in a real browser over the built workbench and the fixture service: code blocks (language name, copy, wrap, diff colours, the
// message a person sent) and the composer's answer to a pasted or dropped file (a line saying it was not sent; nothing is sent; the browser does
// not open the file). Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (CI sets it with EVOLOOP_BROWSER_TEST_REQUIRED=1). EVOLOOP_TIMELINE_CAPTURE_DIR saves screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const captureDir = process.env.EVOLOOP_TIMELINE_CAPTURE_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("code blocks copy, wrap and colour a diff; a pasted or dropped file is answered and never sent", { skip, timeout: 180000 }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const common = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const scene = scenes.find((candidate: { name: string }) => candidate.name === "agent");
  assert.ok(scene, "scene agent");
  const { token, actorId, ago } = common as { token: string; actorId: string; ago: (minutes: number) => string };
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());

  const longLine = `const long = "${"x".repeat(200)}";`;
  const userText = "请看这段：\n```sh\nnpm run test -- --filter user-bubble\n```\n谢谢";
  const replyText = ["下面是几块代码。", "", "```ts", longLine, "const short = 1;", "```", "", "```", "no language here", "```", "", "```diff",
    "--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", " context line", "-removed line", "+added line", "```", "", "```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");
  const entry = (id: string, role: "input" | "assistant", body: string, minutes: number, turnId: string, who: string) => ({ id, kind: "message", role, phase: role === "input" ? "unknown" : "final_answer", body,
    clientId: role === "input" ? id : null, state: "completed", turnId, nativeItemId: `n-${id}`, nativeKind: role === "input" ? "userMessage" : "agentMessage",
    author: role === "input" ? { kind: "actor", id: who, label: who } : { kind: "session", id: null, label: "前端实现" },
    origin: role === "input" ? { kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: who } : null,
    occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const timeline = { entries: [entry("message:m1", "input", userText, 20, "t1", actorId), entry("a1", "assistant", replyText, 18, "t1", "")],
    turns: [{ id: "t1", state: "completed", startedAt: ago(20), completedAt: ago(18), origin: { kind: "message", id: "m1", taskId: null, taskRevisionId: null, initiatingActorId: actorId } }], pending: [] };
  const fact = { projectId: "p", id: "m1", operationId: "m1", target: { kind: "owned", sessionId: "s" }, senderActorId: actorId, senderClass: "user", content: userText, context: null,
    replyToMessageId: null, state: "replied", version: 1, blockedReason: null, readReceipt: null, createdAt: ago(21), updatedAt: ago(20) };

  const open = async (width: number, height: number, colorScheme: "light" | "dark") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    // The clipboard is the browser's and CI's Chrome may refuse to read it back (a read has no timeout and can wait forever), so the page's own write is recorded:
    // what the button hands to writeText is what the person's clipboard receives.
    await context.addInitScript("Object.defineProperty(navigator, \"clipboard\", { configurable: true, value: { writeText: text => { window.__copied = text; return Promise.resolve(); } } });");
    const page = await context.newPage();
    const errors: string[] = []; const posts: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
    await page.route(/\/session-work\/owned%3A[^/?]+\/timeline(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, body: JSON.stringify({ ...body, ...timeline, nextCursor: null, messagesCursor: null }) });
    });
    await page.route(/\/session-work\/owned%3A[^/?]+\/messages(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, body: JSON.stringify({ ...body, items: [fact], nextCursor: null }) });
    });
    await page.goto(`${fixture.base}${scene.path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    const log = page.getByRole("log", { name: "消息与工具时间线" });
    await log.waitFor();
    await log.locator("[data-code-block]").first().waitFor();
    return { page, context, errors, posts, log };
  };
  const shot = async (page: import("playwright-core").Page, name: string) => { if (captureDir) await page.screenshot({ path: `${captureDir}/${name}.png` }); };

  for (const scheme of ["light", "dark"] as const) await t.test(`code blocks at 1440 ${scheme}`, async () => {
    const { page, context, errors, log } = await open(1440, 900, scheme); t.after(() => context.close());
    const blocks = log.locator("[data-code-block]");
    const langs = await blocks.evaluateAll(els => els.map(el => el.querySelector(".code-lang")?.textContent ?? null));
    // The person's own bubble comes first (no language is kept from a message), then the reply's ts, none and diff blocks; the mermaid block is a diagram, not a code block.
    assert.deepEqual(langs, ["", "ts", "", "diff"], "the written language is shown, an unwritten one is not");
    assert.equal(await log.locator(".markdown-diagram").count(), 1, "mermaid is still a diagram");

    const ts = blocks.nth(1), plain = blocks.nth(2), diff = blocks.nth(3);
    // Diff: added, removed, hunk and context lines have four different colours.
    const colours = await diff.evaluate(el => ({ add: getComputedStyle(el.querySelector(".diff-add")!).color, del: getComputedStyle(el.querySelector(".diff-del")!).color,
      hunk: getComputedStyle(el.querySelector(".diff-hunk")!).color, context: getComputedStyle(el.querySelector("pre code")!).color }));
    assert.equal(new Set(Object.values(colours)).size, 4, `four different colours ${JSON.stringify(colours)}`);

    // Wrap: off by default (the long line scrolls inside the block, the page does not), on for this block only, off again on the second click.
    const wrapOf = (block: import("playwright-core").Locator) => block.locator("pre").evaluate(el => ({ white: getComputedStyle(el).whiteSpace, scroll: el.scrollWidth > el.clientWidth + 1 }));
    assert.deepEqual(await wrapOf(ts), { white: "pre", scroll: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the page does not overflow sideways");
    const wrapButton = ts.getByRole("button", { name: "自动换行" });
    await wrapButton.click();
    assert.deepEqual(await wrapOf(ts), { white: "pre-wrap", scroll: false });
    assert.equal(await wrapButton.getAttribute("aria-pressed"), "true");
    assert.equal((await wrapOf(plain)).white, "pre", "another block is not affected");
    await wrapButton.click();
    assert.equal((await wrapOf(ts)).white, "pre");

    // Copy: the clipboard holds the original text, not the language name; the button says 已复制 and returns; the keyboard alone works.
    const copy = ts.getByRole("button", { name: "复制代码" });
    assert.equal(await copy.getAttribute("aria-label"), "复制代码");
    await copy.focus(); await page.keyboard.press("Enter");
    await ts.getByText("已复制").waitFor();
    assert.equal(await page.evaluate("window.__copied"), `${longLine}\nconst short = 1;\n`);
    await ts.locator("[data-copy-label]").getByText("复制", { exact: true }).waitFor({ timeout: 4000 });
    assert.equal(await ts.locator("[data-copy-label]").innerText(), "复制");
    // The message a person sent has the same two buttons.
    const bubble = blocks.nth(0);
    await bubble.getByRole("button", { name: "复制代码" }).click();
    assert.equal(await page.evaluate("window.__copied"), "npm run test -- --filter user-bubble");
    await bubble.getByRole("button", { name: "自动换行" }).click();
    assert.equal(await bubble.getAttribute("data-wrap"), "true");
    await shot(page, `code-1440-${scheme}`);
    assert.deepEqual(errors, []);
  });

  await t.test("composer: a pasted or dropped file is answered and never sent; text is left alone", async () => {
    const { page, context, errors, posts, log } = await open(1440, 900, "light"); t.after(() => context.close());
    const box = page.getByRole("combobox", { name: "消息" });
    const notice = page.locator("[data-composer-notice]");
    const paste = (files: Array<{ name: string; type: string }>, text?: string) => box.evaluate((element, input) => {
      const data = new DataTransfer();
      for (const file of input.files) data.items.add(new File(["x"], file.name, { type: file.type }));
      if (input.text) data.setData("text/plain", input.text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { files, text });
    const before = page.url();

    await paste([{ name: "image.png", type: "image/png" }]);
    await notice.waitFor();
    assert.equal((await notice.innerText()).trim(), "现在还不能附图片或文件，剪贴板里的图片没有发送。可以把内容贴成文字，或让智能体去读工作区里的路径。");
    await shot(page, "paste-notice-1440");
    await notice.getByRole("button", { name: "关闭提示" }).click();
    await notice.waitFor({ state: "detached" });
    await paste([{ name: "报告.pdf", type: "application/pdf" }], "有文字");
    await notice.waitFor();
    assert.match(await notice.innerText(), /报告\.pdf没有发送/);
    await box.pressSequentially("a");
    await notice.waitFor({ state: "detached" });
    await paste([], "只有文字");
    assert.equal(await notice.count(), 0, "text alone brings no notice");

    // Drop: the page is not left, the file is not opened, the box says nothing can be dropped while a file is over the page, and the drop is answered.
    const drag = (type: string, target: string, files: boolean) => page.evaluate(({ type, target, files }) => {
      const element = document.querySelector(target)!;
      const data = new DataTransfer();
      if (files) data.items.add(new File(["x"], "drop.txt", { type: "text/plain" })); else data.setData("text/plain", "拖进来的文字");
      const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, effect: data.dropEffect };
    }, { type, target, files });
    await drag("dragenter", "[role=log]", true);
    await page.locator("[data-file-drag-label]").waitFor();
    assert.equal(await page.locator("[data-file-drag=blocked]").count(), 1);
    await shot(page, "drag-over-1440");
    assert.equal((await drag("dragover", "[role=log]", true)).prevented, true);
    assert.equal((await drag("drop", "[role=log]", true)).prevented, true, "the browser does not open the file");
    await notice.waitFor();
    assert.match(await notice.innerText(), /drop\.txt没有发送/);
    assert.equal(await page.locator("[data-file-drag-label]").count(), 0, "the drop ends the refusal state");
    await box.pressSequentially("b");
    await drag("dragenter", "textarea", true);
    assert.equal((await drag("drop", "textarea", true)).prevented, true);
    await notice.waitFor();
    assert.equal(page.url(), before, "the address does not change");

    await box.pressSequentially("c");
    await notice.waitFor({ state: "detached" });
    assert.equal((await drag("dragover", "textarea", false)).prevented, false, "text dragged into the box is left to the browser");
    assert.equal((await drag("drop", "textarea", false)).prevented, false);
    assert.equal(await notice.count(), 0, "no notice for text");
    assert.deepEqual(posts.filter(url => /\/messages|\/session-work\//.test(url)), [], "nothing was sent");
    assert.equal(await log.count(), 1);
    assert.deepEqual(errors, []);
  });

  await t.test("390 wide: the head fits, the notice wraps, nothing overflows", async () => {
    const { page, context, errors } = await open(390, 844, "dark"); t.after(() => context.close());
    const fits = await page.locator("[data-code-block]").evaluateAll(els => els.every(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; }));
    assert.equal(fits, true, "every block, head included, is inside the screen");
    const box = page.getByRole("combobox", { name: "消息" });
    await box.evaluate(element => { const data = new DataTransfer(); data.items.add(new File(["x"], "一个名字很长很长很长很长很长很长的文件名称.pdf", { type: "application/pdf" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
    await page.locator("[data-composer-notice]").waitFor();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the page does not overflow sideways");
    await shot(page, "code-notice-390-dark");
    assert.deepEqual(errors, []);
  });
});
