// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 评价与后果: the list (rail and middle) with its task and knowledge filters and the create form; one frozen evaluation
// with its attempts, deliveries, judgements and conclusion in the middle and its sources and IDs in the right column;
// dispatching a run, a judgement whose result is unknown, and reads that fail. Screenshots at 1440, 1024 and 390 go to
// EVOLOOP_EVALUATIONS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_EVALUATIONS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE";
const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2), ownerTaskId = id(3), roleId = id(4), evaluationId = id(101), revisionId = id(201), brokenId = id(102);
const caseId = id(5), directId = id(6), wikiId = id(7), protocolId = id(8), protocolRevision = id(9), wikiPage = id(10), wikiRevision = id(11);
const sourceRevision = id(12), actualRevision = id(13), registeredRevision = id(14), deliveryId = id(15), observationId = id(16);
const usedAgent = id(17), freshAgent = id(18), assessmentId = id(19), conclusionId = id(20), artifactDocument = id(21), artifactRevision = id(22);
const stamp = "2026-11-09T08:00:00.000Z";
const hash = (c: string) => c.repeat(64);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const environment = { cwd: "/work/case", authorizationScope: "本案例目录", sandbox: "danger-full-access", approvalPolicy: "never" };
const protocol = { kind: "document", id: protocolId, revision: protocolRevision, contentHash: hash("a") };
const definition = {
  ownerTaskId, question: "加入固定 Wiki 后首轮修复是否更快？", protocol,
  case: { id: caseId, taskId, sourceTaskRevisionId: sourceRevision, commonInput: "修复首轮回归并说明原因", criteria: "同一回归测试通过；记录耗时",
    materials: [{ kind: "git", id: "evoLoop", revision: "abc1234", contentHash: hash("b") }],
    sourceSignature: { title: "修复首轮回归", contentDocumentId: id(23), contentRevisionId: id(24), acceptance: "回归测试通过", owner: roleId, kind: "implementation",
      basis: [{ documentId: id(25), revisionId: id(26), contentHash: hash("c") }], retentions: [], external: [] } },
  conditions: [{ id: directId, kind: "direct", wikiRefs: null, model: "gpt-6-sol", environment },
    { id: wikiId, kind: "wiki", wikiRefs: [{ kind: "wiki", id: wikiPage, revision: wikiRevision, contentHash: hash("d") }], model: "gpt-6-sol", environment }],
  limits: "同一用户环境下工具访问隔离未验证；单例不能推断因果知识收益。",
};
const revision = { projectId, evaluationId, id: revisionId, version: 1, definition, actorId: "reviewer", reason: "建立", createdAt: stamp };
const listItem = (n: number, question: string, title: string) => ({ ...revision, evaluationId: id(100 + n), id: id(200 + n),
  definition: { ...definition, question, case: { ...definition.case, sourceSignature: { ...definition.case.sourceSignature, title } } } });
const attempt = (n: number, conditionId: string, ordinal: number) => ({ projectId, id: id(300 + n), evaluationId, revisionId, caseId, conditionId, ordinal,
  runId: id(400 + n), sourceTaskRevisionId: sourceRevision, actualTaskRevisionId: actualRevision, sessionId: usedAgent, actorId: "reviewer", createdAt: stamp });
const run = (n: number, state: string) => ({ projectId, id: id(400 + n), taskId, taskRevisionId: actualRevision, basisSetId: id(27), sessionId: usedAgent,
  operationId: id(500 + n), input: definition.case.commonInput, inputHash: hash("e"), state, version: 2, interruptRequested: false, actorId: "reviewer",
  createdAt: stamp, updatedAt: stamp, nativeTurnId: state === "completed" ? "turn-1" : null, resultSummary: state === "completed" ? "回归测试已通过" : null,
  evaluationPacket: state === "completed" ? { payloadRef: "blob:1", contentHash: hash("f"), manifestHash: hash("1"), builderVersion: "packet-v1", sources: [protocol] } : null,
  costUsd: state === "completed" ? 0.42 : null, usage: state === "completed" ? { inputTokens: 1200, outputTokens: 300 } : null });
const agent = (agentId: string) => ({ projectId, id: agentId, roleId, cwd: environment.cwd, authorizationScope: environment.authorizationScope, model: "gpt-6-sol",
  sandbox: "danger-full-access", approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: null, nativeSessionId: null, operationId: id(600),
  actorId: "reviewer", createdAt: stamp, updatedAt: stamp, executionProfile: { activationState: "active", activeRevisionId: "profile-1", activationOperationId: null,
    attemptedAt: null, activationEvidence: null, revision: { revisionId: "profile-1", sandbox: "danger-full-access", approvalPolicy: "never", model: "gpt-6-sol",
      cwd: environment.cwd, authorizationScope: environment.authorizationScope } } });
const task = { task: { projectId, id: taskId, version: 7, currentRevisionId: sourceRevision, title: "修复首轮回归", content: "", contentDocumentId: id(23),
  contentRevisionId: id(24), kind: null, acceptance: "回归测试通过", owner: roleId, state: "in_progress" },
  revision: { projectId, taskId, id: sourceRevision, version: 7 }, basis: null, links: [], impacts: [], decisions: [],
  deliveries: [{ projectId, id: deliveryId, taskId, taskRevisionId: registeredRevision, runId: id(401), artifactRef: `/p/${projectId}/documents/${artifactDocument}?revision=${artifactRevision}`,
    artifactRevision, contentHash: hash("2"), technicalResult: "passed", technicalEvidence: "测试通过", reason: "交付", actorId: "reviewer", createdAt: stamp }],
  observations: [{ projectId, id: observationId, taskId, deliveryId, observer: "consumer", observerKind: "human", result: "used", evidence: "回归不再出现", reason: "使用", actorId: "consumer", createdAt: stamp }] };
const assessment = { projectId, id: assessmentId, evaluationId, revisionId, attemptId: id(301), deliveryId, observationId, supersedesId: null,
  values: { sourceFidelity: "qualified", knowledgeAdoption: "not_applicable", deliveryQuality: "qualified", humanEffect: "observed" },
  costs: [{ phase: "运行", unit: "min", amount: 12, source: "计时器", evidence: null }], evidence: [], assessorKind: "human", actorId: "reviewer", reason: "按公开条件核对", createdAt: stamp };
const conclusion = { projectId, id: conclusionId, evaluationId, revisionId, assessmentIds: [assessmentId], supersedesId: null, finding: "直接材料首轮完成",
  limits: "只有一次尝试", comparability: "with_limits", comparabilityReason: "加入 Wiki 的条件还没有判定", nextChoice: "adopt_with_limits", affectedRefs: [], nextActionRef: null,
  actorId: "reviewer", createdAt: stamp };

type Handler = (url: URL, req: IncomingMessage, body: string) => { status?: number; value: unknown } | undefined;
async function start(t: TestContext, handle: Handler) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const body = await new Promise<string>(done => { let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => done(text)); });
      const root = `/api/projects/${projectId}`;
      let answer = handle(url, req, body);
      if (!answer) {
        if (url.pathname === "/api/session") answer = { value: { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} } };
        else if (url.pathname === root) answer = { value: { id: projectId, title: "评价回归项目", createdAt: stamp } };
        else if (url.pathname.endsWith("/impacts")) answer = { value: [] };
        else answer = { value: { items: [], nextCursor: null } };
      }
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.status && answer.status >= 400 ? { error: "fixture failure", message: "测试服务暂不可用" } : answer.value)); return;
    }
    try {
      const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const file = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(file);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const open = async (path: string) => {
    await page.goto(`${base}${path}`);
    if (await page.getByLabel("访问令牌").count()) {
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
    }
  };
  return { page, errors, open };
}
const noOverflow = "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1";

test("评价与后果 lists evaluations by task name in the rail and the middle, keeps both filters and the create form",
  { skip }, async t => {
    const requests: string[] = [];
    const { page, errors, open } = await start(t, url => {
      if (url.pathname === `/api/projects/${projectId}/evaluations`) {
        requests.push(url.search);
        return { value: { items: [listItem(1, "加入固定 Wiki 后首轮修复是否更快？", "修复首轮回归"), listItem(2, "直接材料能否独立完成？", "整理发布说明")], nextCursor: null } };
      }
      return undefined;
    });
    await open(`/p/${projectId}/evaluations?taskId=${taskId}`);
    await page.getByRole("heading", { name: "评价与后果", exact: true }).waitFor();
    const list = page.getByRole("list", { name: "评价" });
    await list.getByRole("link").first().waitFor();
    assert.equal(await list.getByRole("link").count(), 2);
    const text = await list.innerText();
    assert.match(text, /加入固定 Wiki 后首轮修复是否更快？[\s\S]*匹配定义 v1 · 共同任务《修复首轮回归》/);
    assert.doesNotMatch(text, uuid, "the list names tasks, not IDs");
    assert.ok(requests.some(search => search.includes(`taskId=${taskId}`)), "the list is read for the source task only");
    assert.equal(await page.getByRole("link", { name: "返回来源任务" }).getAttribute("href"), `/p/${projectId}/tasks/${taskId}`);
    const rail = page.locator("aside[aria-label=项目导航]").getByRole("navigation", { name: "评价目录" });
    assert.match(await rail.innerText(), /当前范围的评价 · 2[\s\S]*直接材料能否独立完成？[\s\S]*《整理发布说明》 · v1/);
    await page.getByText("需要时建立新的冻结评价").click();
    await page.getByRole("button", { name: "读取固定来源" }).waitFor();
    assert.equal(await page.getByLabel("共同任务 ID").count(), 1);
    if (shots) await page.screenshot({ path: `${shots}/evaluations-list-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(noOverflow), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/evaluations-list-390.png`, fullPage: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await open(`/p/${projectId}/evaluations?knowledgePageId=${wikiPage}`);
    await page.getByRole("link", { name: "返回知识页" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "返回知识页" }).getAttribute("href"), `/p/${projectId}/knowledge?knowledgeId=${wikiPage}`);
    assert.ok(requests.some(search => search.includes(`knowledgePageId=${wikiPage}`)), "the list is read for the knowledge page only");
    assert.deepEqual(errors, []);
  });

test("评价详情 shows attempts, evidence and the conclusion, dispatches a run and keeps an unknown judgement result",
  { skip }, async t => {
    const commands: Array<Record<string, unknown>> = [];
    let dispatched = false;
    let detailReads = 0;
    const { page, errors, open } = await start(t, (url, req, body) => {
      const root = `/api/projects/${projectId}`;
      if (url.pathname === `${root}/evaluations`) return { value: { items: [revision, listItem(2, "直接材料能否独立完成？", "整理发布说明")], nextCursor: null } };
      if (url.pathname === `${root}/evaluations/${evaluationId}`) {
        detailReads++;
        const attempts = [attempt(1, directId, 1), attempt(2, wikiId, 1), ...dispatched ? [attempt(3, wikiId, 2)] : []];
        return { value: { revision, revisions: [revision], attempts, assessments: [assessment], conclusions: [conclusion] } };
      }
      if (url.pathname === `${root}/evaluations/${evaluationId}/attempts/${id(301)}/packet`)
        return { value: { content: "固定输入包正文", contentHash: hash("f"), manifestHash: hash("1"), builderVersion: "packet-v1", sources: [protocol] } };
      if (url.pathname === `${root}/tasks/${taskId}`) return { value: task };
      if (url.pathname === `${root}/tasks/${ownerTaskId}`) return { value: { ...task, task: { ...task.task, id: ownerTaskId, title: "评价首轮修复" } } };
      if (url.pathname === `${root}/runtime/runs`) return { value: [run(1, "completed"), run(2, "failed"), ...dispatched ? [run(3, "unknown")] : []] };
      if (url.pathname === `${root}/runtime/sessions`) return { value: [agent(usedAgent), agent(freshAgent)] };
      if (url.pathname === `${root}/runtime/runs/${id(401)}/result`) return { value: { messages: ["已修复并说明原因"], source: "owned-native-history", finalPhaseConfirmed: true, observedAt: stamp } };
      if (url.pathname === `${root}/roles/${roleId}`) return { value: { projectId, id: roleId, version: 1, proposal: { title: "修复负责人" } } };
      if (url.pathname === `${root}/documents/${protocolId}`) return { value: { document: { projectId, id: protocolId, title: "评价协议 v2" }, current: { projectId, documentId: protocolId, id: protocolRevision }, adopted: null } };
      if (url.pathname === `${root}/documents/${protocolId}/revisions/${protocolRevision}`) return { value: { projectId, documentId: protocolId, id: protocolRevision, contentHash: hash("a") } };
      if (url.pathname === "/api/commands" && req.method === "POST") {
        const command = JSON.parse(body) as Record<string, unknown>;
        commands.push(command);
        if (command.type === "runtime.run.reserve") { dispatched = true; return { value: { status: "applied", operationId: command.operationId, entityId: command.runId } }; }
        return { status: 500, value: null };
      }
      return undefined;
    });
    await open(`/p/${projectId}/evaluations/${evaluationId}`);
    const main = page.locator("main");
    await page.getByRole("heading", { name: "加入固定 Wiki 后首轮修复是否更快？", level: 1 }).waitFor();
    const glance = page.getByRole("navigation", { name: "评价概览" });
    await glance.getByText("1 次尝试 · 失败 · 0 项判定").waitFor();
    assert.match(await glance.innerText(), /直接材料\s*1 次尝试 · 已完成 · 1 项判定[\s\S]*加入固定 Wiki\s*1 次尝试 · 失败 · 0 项判定[\s\S]*结论与下一步\s*有限比较 · 带限制采用/);
    const direct = main.getByRole("region", { name: "直接材料" });
    await direct.getByText("本次交付的使用记录", { exact: true }).waitFor();
    const directText = await direct.innerText();
    assert.match(directText, /冻结执行配置\s*模型 gpt-6-sol · 完整本机权限 · 无需逐次审批/);
    assert.match(directText, /尝试 1[\s\S]*已完成[\s\S]*服务商报告费用 0.42 美元[\s\S]*实际发送包已封存/);
    assert.match(directText, /本次交付的使用记录\s*真人 consumer · 已使用 · 回归不再出现/);
    assert.match(directText, /署名判定 · 真人 reviewer[\s\S]*来源：符合固定来源 · 知识：不适用 · 交付：交付合格 · 真人后果：已观察到真人后果[\s\S]*运行 · 12 min · 来源：计时器/);
    assert.match(await main.getByRole("region", { name: "结论与下一步" }).innerText(), /结论 · 有限比较[\s\S]*带限制采用（尚无实际后续动作引用）[\s\S]*直接材料 · 尝试 1 · 真人 reviewer/);
    await page.getByRole("complementary", { name: "右栏" }).getByText("《评价协议 v2》 · 固定版 ↗").waitFor();
    if (shots) await page.screenshot({ path: `${shots}/evaluation-detail-1440-top.png` });
    await direct.getByRole("button", { name: "读取固定输入包" }).click();
    await direct.getByText("实际输入内容与来源清单").click();
    await direct.getByText("固定输入包正文").waitFor();
    assert.match(await direct.innerText(), /实际输入内容与来源清单\s*《评价协议 v2》 · 固定版/, "the packet names its verified source");
    await direct.getByRole("button", { name: "读取原始输出" }).click();
    await direct.getByText("已修复并说明原因").waitFor();

    const centre = await main.innerText();
    assert.doesNotMatch(centre, uuid, "raw IDs stay in the 完整标识 layer");
    assert.doesNotMatch(centre, /\b(Run|Session|Agent|Task|completed|failed|unknown|danger-full-access|never|with_limits|adopt_with_limits)\b/, "no implementation words or English states");

    const panel = page.getByRole("complementary", { name: "右栏" });
    await panel.getByText("《评价协议 v2》 · 固定版 ↗").waitFor();
    const facts = await panel.innerText();
    assert.match(facts, /共同任务\s*《修复首轮回归》 · 来源修订 ↗[\s\S]*当前进行中[\s\S]*负责这次评价：《评价首轮修复》/);
    assert.match(facts, /材料[\s\S]*协议[\s\S]*《评价协议 v2》[\s\S]*Git 来源 evoLoop · 固定版[\s\S]*Wiki 修订[\s\S]*Wiki 页（名称未核实） · 固定版[\s\S]*来源[\s\S]*固定依据\s*1 项[\s\S]*定义版本[\s\S]*v1 · 最新[\s\S]*完整标识/);
    assert.doesNotMatch(facts, uuid, "IDs are collapsed until asked for");
    await panel.getByText("展开全部标识与哈希").click();
    assert.match(await panel.innerText(), new RegExp(`评价 ID\\s*${evaluationId}[\\s\\S]*定义修订 ID\\s*${revisionId}`));
    assert.equal(await main.getByRole("complementary", { name: "右栏" }).count(), 0, "facts are not in the middle column");
    if (shots) await page.screenshot({ path: `${shots}/evaluation-detail-1440.png` });

    // 派发运行: the next attempt of the Wiki condition goes to the one fresh agent, against the task version that was read.
    const wiki = main.getByRole("region", { name: "加入固定 Wiki" });
    await wiki.locator("summary", { hasText: "派发第 2 次真实运行" }).click();
    const runForm = wiki.getByRole("form", { name: "派发第 2 次真实运行" });
    const choice = runForm.getByLabel("全新的自有智能体");
    assert.equal(await choice.locator("option").count(), 2, "only the unused, activated agent is offered");
    assert.match(await choice.innerText(), /修复负责人 · gpt-6-sol/);
    await choice.selectOption({ index: 1 });
    const readsBefore = detailReads;
    await runForm.getByRole("button", { name: "派发第 2 次真实运行" }).click();
    await glance.getByText("2 次尝试 · 结果未知 · 0 项判定").waitFor();
    const reserve = commands.find(command => command.type === "runtime.run.reserve")!;
    assert.equal(reserve.sessionId, freshAgent);
    assert.equal(reserve.expectedVersion, 7);
    assert.equal(reserve.taskId, taskId);
    assert.equal(reserve.input, definition.case.commonInput);
    assert.deepEqual(reserve.evaluation, { evaluationId, revisionId, caseId, conditionId: wikiId });
    assert.match(String(reserve.operationId), uuid);
    assert.ok(detailReads > readsBefore, "the evaluation is read again after the write");
    await wiki.getByText("共同任务已有运行中或结果未知的尝试。先核对同一运行，不能重发。").waitFor();
    assert.match(await wiki.innerText(), /尝试 2\s*结果未知[\s\S]*结果未知；先沿同一运行与智能体核对/);

    // 判定: a server failure leaves the result unknown; the draft and the recovery receipt stay and further writes wait.
    const attemptOne = direct.getByRole("article", { name: "尝试 1" });
    await attemptOne.locator("summary", { hasText: "追加更正判定" }).click();
    const judge = attemptOne.getByRole("form", { name: "追加更正判定" });
    await judge.getByLabel("固定来源使用").selectOption("qualified");
    await judge.getByLabel("交付质量").selectOption("qualified");
    await judge.getByLabel("真人使用后果").selectOption("unknown");
    await judge.getByLabel("本次判定者身份").selectOption("human");
    await judge.getByLabel("理由与依据").fill("复核后真人后果改为未知");
    await judge.getByRole("button", { name: "追加更正判定" }).click();
    await judge.getByText(/请在上方按原操作 ID 核对，确认前不要再次提交/).waitFor();
    const recorded = commands.find(command => command.type === "evaluation.assessment.record")!;
    assert.equal(recorded.attemptId, id(301));
    assert.deepEqual(recorded.values, { sourceFidelity: "qualified", knowledgeAdoption: "not_applicable", deliveryQuality: "qualified", humanEffect: "unknown" });
    assert.equal(await judge.getByLabel("理由与依据").inputValue(), "复核后真人后果改为未知", "the draft stays");
    await judge.getByText("本项目仍有结果未确认的操作，请先核对上方回执。").waitFor();
    assert.equal(await judge.getByRole("button", { name: "追加更正判定" }).isDisabled(), true);

    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("complementary", { name: "右栏" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0, "the right column does not open by itself below 1100px");
    if (shots) await page.screenshot({ path: `${shots}/evaluation-detail-1024.png` });
    await page.getByRole("button", { name: "展开右栏" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("region", { name: "共同任务" }).waitFor();
    if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/evaluation-detail-1024-panel.png` }); }
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(noOverflow), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/evaluation-detail-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });

test("评价 reads that fail say what cannot be judged instead of claiming there is nothing", { skip }, async t => {
  const { page, errors, open } = await start(t, url => {
    const root = `/api/projects/${projectId}`;
    if (url.pathname === `${root}/evaluations`) return { status: 500, value: null };
    if (url.pathname === `${root}/evaluations/${evaluationId}`)
      return { value: { revision, revisions: [revision], attempts: [attempt(1, directId, 1)], assessments: [], conclusions: [] } };
    if (url.pathname === `${root}/evaluations/${brokenId}`) return { status: 500, value: null };
    if (url.pathname === `${root}/tasks/${taskId}` || url.pathname === `${root}/runtime/runs`) return { status: 500, value: null };
    if (url.pathname === `${root}/runtime/sessions`) return { value: [] };
    return undefined;
  });
  await open(`/p/${projectId}/evaluations/${evaluationId}`);
  const main = page.locator("main");
  await page.getByRole("heading", { name: "加入固定 Wiki 后首轮修复是否更快？", level: 1 }).waitFor();
  await main.getByText("任务或运行旁证没有读回").waitFor({ timeout: 20000 });
  const direct = main.getByRole("region", { name: "直接材料" });
  await direct.getByText("运行记录没有读回，不能推断执行或成本。").waitFor({ timeout: 20000 });
  await direct.getByText("共同任务没有读回，无法判断这次有没有交付与使用记录。").waitFor();
  await direct.getByText("任务或运行记录没有读回，无法判断能否派发下一次尝试。").waitFor();
  assert.match(await page.getByRole("navigation", { name: "评价概览" }).innerText(), /1 次尝试 · 运行状态无法判断/);
  const text = await main.innerText();
  assert.doesNotMatch(text, /运行记录未读到|未读到明确归属|未读到本次交付的使用记录/, "no claim of absence while reads failed");
  const rail = page.locator("aside[aria-label=项目导航]").getByRole("navigation", { name: "评价目录" });
  await rail.getByText("评价列表没有读回，无法判断有没有其他评价。").waitFor({ timeout: 20000 });
  if (shots) await page.screenshot({ path: `${shots}/evaluation-read-failed-1440.png` });

  await open(`/p/${projectId}/evaluations/${brokenId}`);
  await main.getByText("评价没有读回").waitFor({ timeout: 20000 });
  assert.doesNotMatch(await main.innerText(), /尚无真实尝试|尚无结论|尚无逐次判定/);
  await open(`/p/${projectId}/evaluations`);
  await main.getByText("评价列表没有读回").first().waitFor({ timeout: 20000 });
  assert.doesNotMatch(await main.innerText(), /还没有评价/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(noOverflow), true, "no horizontal overflow at 390px");
  assert.deepEqual(errors, []);
});
