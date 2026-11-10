// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 导入过程文档 on the shared command form (new markup, no old wrapper): an incomplete upload says why before anything is
// read; a complete one reads and hashes the file, saves the receipt, and sends the same import command as before (no
// receipt `type` in it) with the file beside it; an answer that is lost blocks the form until it is checked by the
// original operation ID. All data is synthetic.
// Screenshots: EVOLOOP_DOCUMENT_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DOCUMENT_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `48000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const stamp = "2026-11-10T08:00:00.000Z";
const original = "# 上线方案\n\n从原件读出的正文。\n";

test("the upload form reads the file, saves the receipt first and sends the same import command", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const imports: Array<{ command: Record<string, unknown>; uploads: Array<{ blobId: string; base64: string }> }> = [];
  let lose = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const p = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === p) return send({ id: projectId, title: "上传表单项目", createdAt: stamp });
      if (url.pathname === `${p}/documents/import` && req.method === "POST") {
        let text = ""; for await (const chunk of req) text += String(chunk);
        const body = JSON.parse(text);
        imports.push(body);
        if (lose) return send({ message: "gateway timeout" }, 504);
        return send({ status: "applied", operationId: body.command.operationId, entityId: body.command.documentId });
      }
      if (url.pathname.startsWith(`${p}/operations/`)) return send({ message: "not found" }, 404);
      if (url.pathname === `${p}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/documents`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("button", { name: "保存文档" }).click();
  const form = page.getByRole("form", { name: "导入过程文档" });
  await form.waitFor();
  assert.equal(await form.evaluate(element => element.hasAttribute("data-ui") && !element.closest("[data-legacy]")), true, "new markup, no old wrapper");

  // Incomplete: said in the form, nothing read or sent.
  await form.getByRole("button", { name: "导入原件" }).click();
  await form.getByText("请填写名称、理由并选择原件。").waitFor();
  assert.equal(imports.length, 0);

  // Complete: one import with the file beside it.
  await form.getByLabel("标题").fill("上线方案");
  await form.getByLabel("类型（可选）").selectOption("spec");
  await form.getByLabel("原件").setInputFiles({ name: "上线方案.md", mimeType: "text/markdown", buffer: Buffer.from(original) });
  await form.getByLabel("修订理由").fill("首次导入");
  if (shots) await page.screenshot({ path: `${shots}/document-upload-1440.png`, fullPage: true });
  await form.getByRole("button", { name: "导入原件" }).click();
  await form.getByText("已保存，正在读取持久记录。").waitFor();
  assert.equal(imports.length, 1);
  const [{ command, uploads }] = imports as [typeof imports[number]];
  const hash = createHash("sha256").update(original).digest("hex");
  assert.equal(command.type, undefined, "the receipt's type is not sent");
  assert.deepEqual({ ...command, operationId: "op", documentId: "doc", revisionId: "rev", source: { ...(command.source as object), payloadRef: "blob" } }, {
    projectId, operationId: "op", documentId: "doc", revisionId: "rev", mode: "create", title: "上线方案", kind: "spec", format: "markdown", mediaType: "text/markdown",
    originalName: "上线方案.md", author: "lead", reason: "首次导入",
    source: { storage: "blob", payloadRef: "blob", contentHash: hash, size: Buffer.byteLength(original), entrypoint: null, assets: [] },
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.blobId, (command.source as { payloadRef: string }).payloadRef);
  assert.equal(Buffer.from(uploads[0]!.base64, "base64").toString(), original);
  assert.equal(await form.getByLabel("标题").inputValue(), "", "an applied upload empties the form");

  // A lost answer: the form says the result is unknown and does not send again.
  lose = true;
  await form.getByLabel("标题").fill("第二份方案");
  await form.getByLabel("原件").setInputFiles({ name: "第二份.md", mimeType: "text/markdown", buffer: Buffer.from("# 第二份\n") });
  await form.getByLabel("修订理由").fill("再导入一份");
  await form.getByRole("button", { name: "导入原件" }).click();
  await form.getByText("这次提交的结果未确认").waitFor({ timeout: 15000 });
  assert.equal(await form.getByRole("button", { name: "导入原件" }).isDisabled(), true, "nothing is sent again until it is checked");
  assert.equal(imports.length, 2);
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `no sideways scroll at ${width}`);
    if (shots) await page.screenshot({ path: `${shots}/document-upload-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
});
