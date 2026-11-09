// Built-app fixture: saving the runtime form must not collapse the Role card. Runs only with a Playwright module.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001", roleId = "30000002-0000-4000-8000-000000000002";
const stamp = "2026-10-25T00:00:00.000Z";
const proposal = { title: "真实功能开发职责", roleClass: "business", templateKey: "functional-development", goal: "g", independentResponsibility: "r",
  ownerScope: "项目", inputs: ["任务"], writableAssets: [], deliverables: ["交付"], triggers: ["分派"], workflow: "w", handoffBoundary: "b",
  evidence: [], alternatives: [], firstTaskId: roleId, baseline: "旧", expectedEffect: "可用", costLimit: "有限", trialDays: 7, reviewAtUtc: stamp, exitCriteria: "c" };

test("saving runtime settings keeps the Role card open and shows the new revision", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let version = 2, revision = 0;
  const role = () => ({ projectId, id: roleId, version, currentRevisionId: roleId, state: "trial", proposal, proposedBy: "r", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null });
  const runtime = () => ({ projectId, roleId, binding: revision ? { projectId, roleId, revision, provider: "codex", skills: { project: true, personal: true, builtin: true, add: [], remove: [] }, actorId: "a", reason: "x", operationId: null, createdAtUtc: stamp } : null,
    history: [], provider: "codex", providerSource: "default", availableProviders: ["codex"], providerAvailable: true,
    selection: { project: true, personal: true, builtin: true, add: [], remove: [] }, selectionSource: "default", workDirectory: { cwd: "/w", source: "grant" },
    skillsReportedBy: "files", plugins: [], mcpServers: [], missing: [], notes: [], observedAtUtc: stamp, skills: [] });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); const root = `/api/projects/${projectId}`;
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "p", createdAt: stamp };
      else if (url.pathname === `${root}/roles`) value = { items: [role()], nextCursor: null };
      else if (url.pathname === `${root}/roles/${roleId}/runtime`) value = runtime();
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        const body = JSON.parse(await new Promise<string>(done => { let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => done(text)); })) as { operationId: string };
        version += 1; revision += 1; value = { status: "applied", operationId: body.operationId, entityId: roleId };
      }
      else if ([`${root}/role-templates`].includes(url.pathname)) value = { templates: [], roles: [], nextCursor: null };
      else if (url.pathname.endsWith("/hosts") || url.pathname.endsWith("/bindings")) value = [];
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#/p/${projectId}/runtime?view=roles`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.locator(`#role-${roleId} > summary`).click();
  await page.getByText("绑定运行时并选择 skill").click();
  await page.getByLabel(/理由/).fill("首次绑定");
  await page.getByRole("button", { name: "绑定角色运行时" }).click();
  await page.getByText("回读到第 1 次修订").waitFor();
  assert.equal(await page.locator(`#role-${roleId}`).evaluate(node => (node as HTMLDetailsElement).open), true);
});
