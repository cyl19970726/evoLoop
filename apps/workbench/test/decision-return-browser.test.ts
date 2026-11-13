// Opt-in built-app regression for 待我决定 deep links: a Role proposal opens 职责 and a stage proposal opens
// 目标与阶段 with “返回待我处理”, and that link returns to the inbox. Opening either page directly shows no way back.
// The two pages are checked at 1440 and 390 without sideways scroll. Set
// EVOLOOP_DECISION_RETURN_SCREENSHOT_DIR to keep the screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DECISION_RETURN_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "bb000001-0000-4000-8000-000000000001";
const roleId = "bb000002-0000-4000-8000-000000000002";
const goalId = "bb000003-0000-4000-8000-000000000003";
const stageId = "bb000004-0000-4000-8000-000000000004";
const taskId = "bb000005-0000-4000-8000-000000000005";
const actorId = "decision-reader";
const stamp = "2026-11-12T09:00:00.000Z";

const proposal = {
  title: "新增验收职责", roleClass: "business" as const, goal: "让验收由独立的人持续承担", independentResponsibility: "验收判断不能由实现者代做",
  ownerScope: "前端工作台", inputs: ["任务", "验收方案"], writableAssets: ["apps/workbench"], deliverables: ["独立验收记录"], triggers: ["任务进入验收"],
  workflow: "读固定交付，实际使用，再记录结果", handoffBoundary: "后端协议交给后端职责", evidence: [{ kind: "rework" as const, observation: "两次返工都缺少实际使用",
    sourceRef: "task://bb000006", observedAtUtc: stamp }], alternatives: [{ kind: "method" as const, assessment: "由实现者自验", estimatedCost: "低" }],
  firstTaskId: taskId, baseline: "每周两次返工", expectedEffect: "返工减少到每周一次", costLimit: "两周", trialDays: 14, reviewAtUtc: stamp,
  exitCriteria: "返工没有减少",
};
const role = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "candidate", proposal, proposedBy: "leader",
  createdAtUtc: stamp, trialStartedAtUtc: null, reviewAtUtc: stamp, mergeTargetRoleId: null };
const goal = { projectId, id: goalId, version: 1, outcome: "让试用团队读懂下一步", constraints: "保留原始依据", consumer: "试用团队",
  authority: "可以调整对外说明", scope: "本季度", owner: roleId, actorId: "leader", createdAt: stamp };
const stage = { projectId, id: stageId, goalId, version: 1, deliverable: "对外说明初稿", learningQuestion: "读者能否据此找到入口？",
  state: "proposed", actorId: "leader", createdAt: stamp };
const decisions = [
  { kind: "role_proposal", id: "bb000007-0000-4000-8000-000000000007", title: "新增验收职责", detail: "职责提案", proposedBy: "leader",
    at: stamp, roleId, version: 1 },
  { kind: "stage_proposal", id: "bb000008-0000-4000-8000-000000000008", title: "下一阶段提案", detail: "阶段提案", proposedBy: "leader",
    at: stamp, stageId, version: 1 },
];
const emptyWorkPage = { items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
const runtimeView = { projectId, roleId, binding: null, history: [], provider: "codex", providerSource: "default", availableProviders: ["codex"],
  providerAvailable: true, selection: { project: true, personal: false, builtin: true, add: [], remove: [] }, selectionSource: "default",
  workDirectory: { cwd: "/work/repo", source: "grant" }, skills: [], missing: [], skillsReportedBy: "files", plugins: [], mcpServers: [], notes: [],
  observedAtUtc: stamp };

test("待我决定的职责与阶段深链带着返回待我处理，直接打开不显示", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
  timeout: 180_000,
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null };
      if (path === "/api/session") value = { principal: { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "待我决定返回夹具", createdAt: stamp };
      else if (path === `${root}/decisions-for-me`) value = { items: decisions, observedAt: stamp };
      else if (path === `${root}/acceptance-relay/mine`) value = { items: [] };
      else if (path === `${root}/impacts`) value = [];
      else if (path === `${root}/work-management/index`) value = emptyWorkPage;
      else if (path === `${root}/roles`) value = { items: [role], nextCursor: null };
      else if (path === `${root}/roles/${roleId}/hosts`) value = [];
      else if (path === `${root}/domains`) value = [];
      else if (path === `${root}/roles/${roleId}/runtime`) value = runtimeView;
      else if (path === `${root}/roles/${roleId}`) value = role;
      else if (path === `${root}/goals`) value = { items: [goal], nextCursor: null };
      else if (path === `${root}/stages`) value = [stage];
      else if (path === `${root}/stages/${stageId}/reviews`) value = [];
      else if (path === `${root}/session-work`) value = { items: [], observationCursor: "0" };
      else if (path === `${root}/allocation-relations`) value = { items: [], nextCursor: null,
        metadata: { partial: false, limitations: [], generatedAt: stamp } };
      else if (path === `${root}/runtime` || path === `${root}/runtime/sessions` || path === `${root}/runtime/runs` || path === `${root}/resident-queues`)
        value = path === `${root}/runtime` ? { available: true, error: null, allowedCwds: [], grants: [] } : [];
      else if (path === `${root}/runtime/models`) value = { status: "available", models: [], options: [], error: null };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const login = async () => {
    if (await page.getByLabel("访问令牌").count()) {
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
    }
  };
  const open = async (path: string) => { await page.goto(`${base}${path}`); await login(); };
  const noSideways = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    "no horizontal page scroll");
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
  const backLink = () => page.getByRole("link", { name: "返回待我处理", exact: true });

  await open(`/p/${projectId}/inbox`);
  const inbox = page.locator("[data-inbox]");
  await inbox.getByRole("heading", { level: 1, name: "待我验收与判断" }).waitFor();
  const decisionList = inbox.getByRole("list", { name: "待我决定" });
  await decisionList.waitFor();

  const roleHref = new URL((await decisionList.getByRole("link", { name: /新增验收职责/ }).getAttribute("href"))!, "http://x");
  assert.deepEqual([roleHref.pathname, roleHref.searchParams.get("role"), roleHref.searchParams.get("return"), roleHref.searchParams.get("actor"),
    roleHref.searchParams.get("returnTitle")],
  [`/p/${projectId}/roles`, roleId, `/p/${projectId}/inbox`, actorId, "待我处理"]);
  await decisionList.getByRole("link", { name: /新增验收职责/ }).click();
  await page.locator(`#role-${roleId}`).getByRole("heading", { name: "新增验收职责" }).waitFor();
  const roleBack = backLink();
  await roleBack.waitFor();
  assert.equal(await roleBack.getAttribute("href"), `/p/${projectId}/inbox`);
  await noSideways(); await shot("decision-role-return-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await roleBack.waitFor();
  await noSideways(); await shot("decision-role-return-390");
  await roleBack.click();
  await page.waitForURL(`${base}/p/${projectId}/inbox`);
  await inbox.getByRole("heading", { level: 1, name: "待我验收与判断" }).waitFor();
  await decisionList.waitFor();

  await open(`/p/${projectId}/inbox`);
  await decisionList.getByRole("link", { name: /下一阶段提案/ }).waitFor();
  const stageHref = new URL((await decisionList.getByRole("link", { name: /下一阶段提案/ }).getAttribute("href"))!, "http://x");
  assert.deepEqual([stageHref.pathname, stageHref.searchParams.get("stage"), stageHref.searchParams.get("return"), stageHref.searchParams.get("actor"),
    stageHref.searchParams.get("returnTitle")],
  [`/p/${projectId}/journey`, stageId, `/p/${projectId}/inbox`, actorId, "待我处理"]);
  await decisionList.getByRole("link", { name: /下一阶段提案/ }).click();
  await page.getByRole("heading", { level: 2, name: "对外说明初稿" }).waitFor();
  const stageBack = backLink();
  await stageBack.waitFor();
  assert.equal(await stageBack.getAttribute("href"), `/p/${projectId}/inbox`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await noSideways(); await shot("decision-stage-return-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await stageBack.waitFor();
  await noSideways(); await shot("decision-stage-return-390");
  await stageBack.click();
  await page.waitForURL(`${base}/p/${projectId}/inbox`);
  await inbox.getByRole("heading", { level: 1, name: "待我验收与判断" }).waitFor();

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(`/p/${projectId}/roles?role=${roleId}`);
  await page.locator(`#role-${roleId}`).getByRole("heading", { name: "新增验收职责" }).waitFor();
  assert.equal(await page.locator("[data-return-link]").count(), 0, "direct Role open has no way back");
  await shot("decision-role-direct-1440");
  await open(`/p/${projectId}/journey?stage=${stageId}`);
  await page.getByRole("heading", { level: 2, name: "对外说明初稿" }).waitFor();
  assert.equal(await page.locator("[data-return-link]").count(), 0, "direct stage open has no way back");
  await shot("decision-stage-direct-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await open(`/p/${projectId}/roles?role=${roleId}`);
  await page.locator(`#role-${roleId}`).getByRole("heading", { name: "新增验收职责" }).waitFor();
  assert.equal(await page.locator("[data-return-link]").count(), 0, "direct Role open at 390 has no way back");
  await noSideways(); await shot("decision-role-direct-390");
  await open(`/p/${projectId}/journey?stage=${stageId}`);
  await page.getByRole("heading", { level: 2, name: "对外说明初稿" }).waitFor();
  assert.equal(await page.locator("[data-return-link]").count(), 0, "direct stage open at 390 has no way back");
  await noSideways(); await shot("decision-stage-direct-390");

  assert.deepEqual(errors, []);
});
