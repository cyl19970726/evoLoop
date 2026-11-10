// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 职责 and 分工与运行: the directory selects a Role whose detail fills the center and whose trial facts, runtime and
// skills fill the right column; decisions, external chats and history read and write from there. 分工与运行 lists the
// managed agents, names every close blocker, sends a close only when none is found, and old runtime links land in
// their new place. Screenshots at 1440 / 1024 / 390 with EVOLOOP_TEAM_ROLES_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialRoleTemplates } from "@evoloop/contracts/roles";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TEAM_ROLES_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "35000001-0000-4000-8000-000000000001";
const id = (n: number) => `35000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const proposal = (title: string, roleClass: "business" | "system") => ({ title, roleClass, goal: `${title}的目标`, independentResponsibility: "需要持续判断交付边界",
  ownerScope: "前端页面", inputs: ["任务", "设计文档"], writableAssets: ["apps/workbench"], deliverables: ["页面"], triggers: ["任务分派"], workflow: "读、改、验证、交付",
  handoffBoundary: "后端接口归后端职责", evidence: [{ kind: "rework", observation: "三次返工", sourceRef: "task://1", observedAtUtc: stamp },
    { kind: "effect", observation: "返工减少", sourceRef: "task://2", observedAtUtc: stamp }, { kind: "cost", observation: "两个工作日", sourceRef: "task://3", observedAtUtc: stamp }],
  alternatives: [{ kind: "method", assessment: "不足", estimatedCost: "低" }, { kind: "knowledge", assessment: "不足", estimatedCost: "低" },
    { kind: "another-instance", assessment: "无实例", estimatedCost: "中" }, { kind: "temporary-assignment", assessment: "不持续", estimatedCost: "中" }],
  firstTaskId: id(90), baseline: "每周返工三次", expectedEffect: "每周不超过一次", costLimit: "两周", trialDays: 14, reviewAtUtc: stamp, exitCriteria: "返工未减少" });
const role = (n: number, title: string, state: string, roleClass: "business" | "system") => ({ projectId, id: id(n), version: 3, currentRevisionId: id(n),
  state, proposal: proposal(title, roleClass), proposedBy: "lead", createdAtUtc: stamp, trialStartedAtUtc: state === "candidate" ? null : stamp, reviewAtUtc: stamp, mergeTargetRoleId: null });
const roles = [role(1, "前端实现", "trial", "business"), role(2, "测试验收", "candidate", "business"), role(3, "统筹", "active", "system")];
const session = (n: number, state: string) => ({ projectId, id: id(n), roleId: id(1), cwd: "/work/repo", authorizationScope: "前端任务", model: "gpt-6-sol",
  sandbox: "danger-full-access", approvalPolicy: "never", state, version: 4, nativeThreadId: "thread", nativeSessionId: "native", operationId: id(n + 50),
  actorId: "lead", createdAt: stamp, updatedAt: stamp });
const sessions = [session(11, "ready"), session(12, "ready")];
const runs = [{ projectId, id: id(21), taskId: id(90), taskRevisionId: id(91), basisSetId: id(92), sessionId: id(11), operationId: id(21), input: "做", inputHash: "a",
  state: "running", version: 2, nativeTurnId: "turn", interruptRequested: false, resultSummary: null, actorId: "lead", createdAt: stamp, updatedAt: stamp }];
const runtimeView = { projectId, roleId: id(1), binding: null, history: [], provider: "codex", providerSource: "default", availableProviders: ["codex"], providerAvailable: true,
  selection: { project: true, personal: false, builtin: true, add: [], remove: [] }, selectionSource: "default", workDirectory: { cwd: "/work/repo", source: "grant" },
  skills: [{ name: "evoloop-workflow", source: "evoloop", selected: true, reason: "business", description: "Use the evoLoop business CLI to take an authorized project assignment through fixed evidence.", location: ".agents/skills/evoloop-workflow", contentHash: null, delivery: "role_context" }],
  missing: [], skillsReportedBy: "files", plugins: [], mcpServers: [], notes: [], observedAtUtc: stamp };
const grant = { projectId, actorId: "lead", roleId: id(1), authorizationScope: "前端任务", cwd: "/work/repo", sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true, models: ["gpt-6-sol"] };

test("职责 and 分工与运行 read and write in the shell layout, and old runtime links land in place", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const commands: Array<Record<string, unknown>> = [];
  let available = true, recovered = 0;
  // Later in the test: a reader who may write but not review, and a Role list with a second page that fails once.
  let permissions = ["read", "write", "review"], paged = false, failNextPage = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "lead", projectIds: [projectId], permissions }, capabilities: {} };
      // Agents are named by their registered profile (never by the identifier's first characters).
      else if (url.pathname.startsWith(`${root}/session-work/`) && url.pathname.endsWith("/profile")) {
        const sessionKey = decodeURIComponent(url.pathname.split("/").at(-2)!);
        value = { projectId, sessionKey, displayName: sessionKey === `owned:${id(11)}` ? "前端甲" : "前端乙", version: 1, updatedAt: stamp };
      }
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const command = JSON.parse(body) as Record<string, unknown>; commands.push(command);
        value = { status: "applied", operationId: command.operationId, entityId: command.roleId ?? command.sessionId ?? command.linkId };
      }
      else if (url.pathname === root) value = { id: projectId, title: "团队深化项目", createdAt: stamp };
      else if (url.pathname === `${root}/roles` && url.searchParams.get("cursor") === "page-2") {
        if (failNextPage) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "下一页暂不可读" })); return; }
        value = { items: [role(4, "第二页职责", "active", "business")], nextCursor: null };
      }
      else if (url.pathname === `${root}/roles`) value = { items: roles, nextCursor: paged ? "page-2" : null };
      else if (url.pathname === `${root}/role-templates`) value = { templates: initialRoleTemplates.map(item => item.key === "functional-development"
        ? { ...item, state: "established", roleIds: [id(1)] } : { ...item, state: "not-established", roleIds: [] }), roles: [{ ...roles[0], proposal: { ...roles[0]!.proposal, templateKey: "functional-development" } }], nextCursor: null };
      else if (url.pathname === `${root}/roles/${id(1)}/hosts`) value = [];
      else if (url.pathname === `${root}/domains`) value = [];
      else if (url.pathname === `${root}/roles/${id(1)}/runtime`) value = runtimeView;
      else if (url.pathname === `${root}/roles/${id(1)}/revisions`) value = [{ projectId, roleId: id(1), id: id(31), version: 3, state: "trial", proposal: roles[0]!.proposal, actorId: "lead", reason: "接受有限试行", createdAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null }];
      else if (url.pathname === `${root}/roles/${id(1)}/reviews`) value = [];
      else if (url.pathname === `${root}/roles/${id(1)}/handoffs`) value = [{ projectId, id: id(32), roleId: id(1), kind: "task", sourceRef: id(90), targetRoleId: id(3), observedTaskVersion: 2, state: "prepared", preparedAtUtc: stamp, acknowledgedAtUtc: null }];
      else if (url.pathname === `${root}/roles/${id(1)}/bindings`) value = [{ projectId, id: id(33), roleId: id(1), sessionId: id(11), roleRevisionId: id(31), actorId: "lead", note: "主承载", createdAtUtc: stamp }];
      else if (url.pathname.startsWith(`${root}/roles/`)) value = roles.find(item => url.pathname.endsWith(item.id)) ?? [];
      else if (url.pathname === `${root}/runtime`) value = { available, error: available ? null : "执行服务未连接", allowedCwds: [], grants: [grant] };
      else if (url.pathname === `${root}/runtime/recover` && req.method === "POST") { recovered += 1; available = true; value = { available: true }; }
      else if (url.pathname === `${root}/runtime/models`) value = { status: "available", models: ["gpt-6-sol"] };
      else if (url.pathname === `${root}/runtime/sessions`) value = sessions;
      else if (url.pathname === `${root}/runtime/runs`) value = runs;
      else if (url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const noOverflow = () => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");

  // An old 职责 link lands on /roles with the Role selected.
  await page.goto(`${base}/p/${projectId}/runtime?view=roles&role=${id(1)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const detail = page.locator(`#role-${id(1)}`);
  await detail.getByRole("heading", { name: "前端实现" }).waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, `/p/${projectId}/roles?role=${id(1)}`);
  const directory = page.getByRole("navigation", { name: "职责目录" });
  assert.equal(await directory.getByRole("link", { name: /前端实现/ }).getAttribute("aria-current"), "page");
  assert.match(await detail.innerText(), /试行中.*业务职责/s);
  assert.match(await detail.getByRole("region", { name: "提出依据与比较" }).innerText(), /反复返工.*三次返工.*备选：同职责增实例/s);
  assert.doesNotMatch(await detail.innerText(), /\brework\b|another-instance/, "service values never reach the screen raw");
  // Right column: trial facts and review time, runtime and skills.
  const side = page.getByRole("complementary", { name: "右栏" });
  await side.getByRole("region", { name: "试行与回看" }).getByText("每周不超过一次").waitFor();
  await side.getByRole("region", { name: "运行时与 skill" }).getByText(/Codex · 未绑定/).waitFor();
  // A skill says in Chinese what it is for; its SKILL.md description (English here) is folded under 原文与位置.
  const runtime = side.getByRole("region", { name: "运行时与 skill" });
  await runtime.getByText(/用 evoLoop 业务命令行承接已授权的工作/).waitFor();
  assert.doesNotMatch(await runtime.innerText(), /Use the evoLoop business CLI/);
  await runtime.locator("summary", { hasText: "原文与位置" }).first().click();
  await runtime.getByText(/^Use the evoLoop business CLI/).waitFor();
  // History on request, with the prepared handoff's confirmation form and the binding's agent link.
  const history = detail.getByRole("region", { name: "修订与交接历史" });
  await history.getByRole("button", { name: "阅读修订与交接历史" }).click();
  await history.getByText("第 3 版 · 试行中").waitFor();
  await history.getByText("未完成任务 · 待接收确认").waitFor();
  assert.equal(await history.getByRole("link", { name: "受管智能体 · 前端甲" }).getAttribute("href"), `/p/${projectId}/runtime?session=${id(11)}`);
  assert.doesNotMatch(await history.innerText(), /受管智能体 35000000/, "the binding names the agent, not its identifier");
  // Register an external chat (a live Role only).
  const presence = detail.getByRole("region", { name: "承载与业务领域" });
  await presence.getByText("尚无已登记的承载或业务领域。").waitFor();
  await presence.getByText("登记已有 Codex 聊天").click();
  await presence.getByLabel("原聊天完整引用").fill("01a158d7-f842-7ca3-9899-ce1efc33c030");
  await presence.getByLabel("理由与依据").fill("人工核对过原聊天");
  await presence.getByRole("button", { name: "登记外部聊天" }).click();
  for (let i = 0; i < 50 && !commands.some(item => item.type === "host.register"); i++) await page.waitForTimeout(50);
  const host = commands.find(item => item.type === "host.register")!;
  assert.deepEqual([host.roleId, host.expectedRoleVersion, (host.host as { ref: string }).ref], [id(1), 3, "codex://threads/01a158d7-f842-7ca3-9899-ce1efc33c030"]);
  if (shots) await page.screenshot({ path: `${shots}/team-role-1440.png`, fullPage: true });
  // The discussion links are new markup inside the role's old region; this shot shows how they look there.
  if (shots) await page.getByRole("region", { name: "相关讨论与决定" }).screenshot({ path: `${shots}/team-role-backlinks-1440.png` });

  // A candidate Role offers only the decision; the decision is sent with the Role's version.
  await directory.getByRole("link", { name: /测试验收/ }).click();
  const candidate = page.locator(`#role-${id(2)}`);
  await candidate.getByRole("heading", { name: "测试验收" }).waitFor();
  const next = candidate.getByRole("region", { name: "下一步" });
  assert.deepEqual(await next.locator("summary").allTextContents(), ["决定是否试行"]);
  await next.locator("summary", { hasText: "决定是否试行" }).click();
  await next.getByLabel("决定", { exact: true }).selectOption("accept-trial");
  await next.getByLabel("理由与依据").fill("证据充分，接受两周试行");
  await next.getByRole("button", { name: "决定是否试行" }).click();
  for (let i = 0; i < 50 && !commands.some(item => item.type === "role.decide"); i++) await page.waitForTimeout(50);
  const decide = commands.find(item => item.type === "role.decide")!;
  assert.deepEqual([decide.roleId, decide.expectedVersion, decide.decision], [id(2), 3, "accept-trial"]);

  // The overview: base templates, every Role, and the proposal form.
  await page.getByRole("link", { name: "全部职责", exact: true }).click();
  await page.getByRole("heading", { name: "职责", exact: true }).waitFor();
  const templates = page.getByRole("region", { name: "基础职责" });
  await templates.getByRole("link", { name: "前端实现" }).waitFor();
  assert.equal(await templates.getByRole("listitem").count(), 7);
  await page.getByRole("button", { name: "提出职责试行" }).click();
  await page.getByRole("region", { name: "提出有证据的职责试行" }).getByLabel("职责名称").waitFor();
  if (shots) await page.screenshot({ path: `${shots}/team-roles-overview-1440.png` });

  // 1024: the right column is a drawer that never opens on its own; 390: no horizontal overflow.
  await page.goto(`${base}/p/${projectId}/roles?role=${id(1)}`);
  await page.getByLabel("访问令牌").fill("fixture-token").catch(() => undefined);
  if (await page.getByRole("button", { name: "进入", exact: true }).count()) await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.locator(`#role-${id(1)}`).waitFor();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole("dialog").count(), 0, "the drawer does not open by itself");
  if (shots) await page.screenshot({ path: `${shots}/team-role-1024.png` });
  await page.getByRole("button", { name: "展开右栏" }).click();
  await page.getByRole("dialog").getByRole("region", { name: "运行时与 skill" }).waitFor();
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/team-role-1024-drawer.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`#role-${id(1)}`).waitFor();
  assert.equal(await noOverflow(), true, "no horizontal overflow at 390px on 职责");
  if (shots) await page.screenshot({ path: `${shots}/team-role-390.png`, fullPage: true });

  // 分工与运行: agents listed; the busy one names its blocker; the idle one sends a close.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(hash => { location.hash = hash; }, `/p/${projectId}/runtime`);
  await page.getByRole("heading", { name: "分工与运行", exact: true }).waitFor();
  const agents = page.getByRole("navigation", { name: "受管智能体" });
  await agents.getByRole("link", { name: /前端实现/ }).first().waitFor();
  assert.equal(await page.locator("[data-session-id]").count(), 2);
  await page.locator(`[data-run-id="${id(21)}"]`).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/team-runtime-1440.png`, fullPage: true });
  await page.locator(`[data-session-id="${id(11)}"]`).getByRole("link").click();
  const busy = page.locator(`#runtime-session-${id(11)}`);
  await busy.waitFor();
  const blockers = busy.locator("[data-close-blockers]");
  await blockers.getByText("仍有在途或结果未知的运行（1 项）").waitFor();
  assert.equal(await busy.getByRole("button", { name: "请求关闭受管智能体" }).count(), 0);
  await page.getByRole("complementary", { name: "右栏" }).getByRole("region", { name: "受管智能体" }).getByText("1 项已登记").waitFor();
  if (shots) await page.screenshot({ path: `${shots}/team-agent-1440.png`, fullPage: true });
  assert.equal(await agents.getByText(/35000000/).count(), 0, "the rail names agents, not identifiers");
  await agents.getByRole("link", { name: /前端乙/ }).click();
  const idle = page.locator(`#runtime-session-${id(12)}`);
  await idle.waitFor();
  await idle.getByText(/没有发现在途运行或占用/).waitFor();
  await idle.getByLabel("关闭理由与核对依据").fill("工作已全部交付");
  await idle.getByRole("button", { name: "请求关闭受管智能体" }).click();
  for (let i = 0; i < 50 && !commands.some(item => item.type === "runtime.session.close"); i++) await page.waitForTimeout(50);
  const close = commands.find(item => item.type === "runtime.session.close")!;
  assert.deepEqual([close.sessionId, close.expectedVersion], [id(12), 4]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await noOverflow(), true, "no horizontal overflow at 390px on 分工与运行");
  if (shots) await page.screenshot({ path: `${shots}/team-agent-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Recovering the execution connection when it is down.
  available = false;
  await page.evaluate(hash => { location.hash = hash; }, `/p/${projectId}/runtime`);
  await page.getByRole("button", { name: "读取运行状态" }).click();
  await page.getByRole("button", { name: "受控恢复执行连接" }).click();
  await page.getByText("执行服务已接通。", { exact: false }).waitFor();
  assert.equal(recovered, 1);

  // Old runtime links: a conversation key opens the agents space; a bare id selects the agent here.
  await page.evaluate(hash => { location.hash = hash; }, `/p/${projectId}/runtime?session=owned%3A${id(11)}&tab=queue`);
  await page.waitForURL(url => url.pathname === `/p/${projectId}/sessions`);
  assert.equal(new URL(page.url()).searchParams.get("session"), `owned:${id(11)}`);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "queue");
  await page.evaluate(hash => { location.hash = hash; }, `/p/${projectId}/runtime?session=${id(12)}`);
  await page.locator(`#runtime-session-${id(12)}`).waitFor();

  // A reader with write but no review permission can propose a Role (role.propose needs write only) but not decide.
  permissions = ["read", "write"]; paged = true;
  const writer = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  writer.on("pageerror", error => errors.push(error.message));
  await writer.goto(`${base}/p/${projectId}/roles`);
  await writer.getByLabel("访问令牌").fill("fixture-token");
  await writer.getByRole("button", { name: "进入", exact: true }).click();
  const all = writer.getByRole("region", { name: "全部职责" });
  await all.getByRole("link", { name: /前端实现/ }).waitFor();
  // Loading more reads only the next page; when it fails the Roles already shown stay and the failure is its own.
  await all.getByRole("button", { name: "加载更多职责" }).click();
  await writer.getByText(/下一页职责未读回/).waitFor();
  assert.equal(await all.getByRole("link", { name: /前端实现/ }).count(), 1);
  assert.match(await writer.getByRole("status").filter({ hasText: "职责读于" }).innerText(), /已读 3 项，还有更多/);
  failNextPage = false;
  await all.getByRole("button", { name: "重新加载下一页" }).click();
  await all.getByRole("link", { name: /第二页职责/ }).waitFor();
  assert.equal(await all.getByRole("link", { name: /前端实现/ }).count(), 1);
  await writer.getByRole("button", { name: "提出职责试行" }).first().click();
  const proposalForm = writer.getByRole("region", { name: "提出有证据的职责试行" });
  await proposalForm.getByLabel("职责名称").waitFor();
  assert.equal(await proposalForm.getByRole("button", { name: "提出职责试行" }).isEnabled(), true, "write permission is enough to propose");
  assert.equal(await proposalForm.getByText("当前身份没有审阅权限").count(), 0);
  await writer.getByRole("navigation", { name: "职责目录" }).getByRole("link", { name: /测试验收/ }).click();
  const decision = writer.locator(`#role-${id(2)}`).getByRole("region", { name: "下一步" });
  await decision.locator("summary", { hasText: "决定是否试行" }).click();
  await decision.getByText("当前身份没有审阅权限。").waitFor();
  assert.equal(await decision.getByRole("button", { name: "决定是否试行" }).isDisabled(), true, "deciding still needs review permission");
  assert.deepEqual(errors, []);
});
