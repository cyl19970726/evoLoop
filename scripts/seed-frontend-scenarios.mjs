// Seeds clearly labeled synthetic data for walking the workbench scenarios in docs/frontend/scenarios.md.
// Local test instances only. Usage:
//   EVOLOOP_API_URL=http://127.0.0.1:<port> EVOLOOP_TOKEN=<owner token> EVOLOOP_CONSUMER_TOKEN=<consumer token> \
//   node scripts/seed-frontend-scenarios.mjs --project <uuid> [--second-project <uuid>] --consumer <actorId> \
//     [--projects-only | --skip-projects --owner-role <trial or active Role id>]
// A brand-new project has no Role yet, and task.create needs one; create the projects first, give the test
// project one trial Role, then run again with --skip-projects --owner-role.
import { createHash, randomUUID } from "node:crypto";

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const projectId = arg("--project");
const secondProjectId = arg("--second-project");
const consumer = arg("--consumer");
const ownerRole = arg("--owner-role");
const projectsOnly = process.argv.includes("--projects-only");
const skipProjects = process.argv.includes("--skip-projects");
if (!projectsOnly && !ownerRole) throw new Error("--owner-role is required unless --projects-only is set.");
if (!projectId || !consumer) throw new Error("Explicit opt-in required: --project <uuid> --consumer <actorId>");
const ownerToken = process.env.EVOLOOP_TOKEN;
const consumerToken = process.env.EVOLOOP_CONSUMER_TOKEN;
if (!ownerToken || !consumerToken) throw new Error("Set EVOLOOP_TOKEN and EVOLOOP_CONSUMER_TOKEN for the test instance.");
const base = new URL(process.env.EVOLOOP_API_URL ?? "http://127.0.0.1:4318");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Seeding is limited to a local API.");

const LABEL = "【合成示例】";
const report = [];

async function command(payload, { token = ownerToken, project = projectId } = {}) {
  const operationId = randomUUID();
  const response = await fetch(new URL("/api/commands", base), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, projectId: project, operationId }),
  }).catch(() => { throw new Error(`Result unknown for ${payload.type} ${operationId}; query the operation before rerunning.`); });
  const result = await response.json();
  if (result.status !== "applied") throw new Error(`${payload.type}: ${JSON.stringify(result).slice(0, 400)}`);
  return result;
}

/** Runs one scenario section; a failure is recorded and the next section continues. */
async function section(name, run) {
  try { report.push({ section: name, ok: true, detail: await run() }); }
  catch (error) { report.push({ section: name, ok: false, error: String(error.message ?? error) }); }
}

const hash = text => createHash("sha256").update(text).digest("hex");
const ids = {};

async function createDocument(title, body, kind = null) {
  const documentId = randomUUID();
  const created = await command({ type: "document.create", documentId, title: `${LABEL}${title}`, body, kind });
  return { documentId, revisionId: created.revisionId, contentHash: hash(body) };
}

async function createTask(title, fields = {}) {
  const taskId = fields.taskId ?? randomUUID();
  await command({
    type: "task.create", taskId, title: `${LABEL}${title}`,
    content: fields.content ?? `## 目标\n${title}\n\n## 背景\n这是用于走查工作台场景的合成任务。`,
    acceptance: fields.acceptance ?? "按任务正文完成，并能从工作台读回结果。",
    owner: fields.owner ?? ids.devRole ?? ownerRole, ...fields.extra,
  });
  return taskId;
}

async function taskDetail(taskId) {
  const response = await fetch(new URL(`/api/projects/${projectId}/tasks/${taskId}`, base), { headers: { Authorization: `Bearer ${ownerToken}` } });
  return response.json();
}
const taskVersion = async taskId => (await taskDetail(taskId)).task.version;
/** The command result names the Task; the Delivery ID is read back from the Task detail. */
const latestDeliveryId = async taskId => (await taskDetail(taskId)).deliveries.at(-1).id;

if (!skipProjects) await section("项目", async () => {
  await command({ type: "project.create", title: `${LABEL}工作台改版走查项目` });
  if (secondProjectId) await command({ type: "project.create", title: `${LABEL}第二个项目` }, { project: secondProjectId });
  return { projectId, secondProjectId };
});

async function createRole(title, templateKey, firstTaskId) {
  const roleId = randomUUID();
  const now = new Date().toISOString();
  const proposed = await command({ type: "role.propose", roleId, proposal: {
    title: `${LABEL}${title}`, roleClass: "business", templateKey, goal: `${title}：按场景完成工作并回报结果。`,
    independentResponsibility: "在本职责内独立判断与执行。", ownerScope: "工作台改版走查",
    inputs: ["场景文档", "页面说明"], writableAssets: ["过程文档"], deliverables: ["可读回的交付"], triggers: ["收到分派的任务"],
    workflow: "读取任务正文与依据，执行后登记交付。", handoffBoundary: "跨职责的问题交给 Leader。",
    evidence: [
      { kind: "backlog", observation: "合成：待处理工作需要承接者。", sourceRef: "合成示例", observedAtUtc: now },
      { kind: "effect", observation: "合成：有承接者时交付更快。", sourceRef: "合成示例", observedAtUtc: now },
      { kind: "cost", observation: "合成：维护一个职责每周约两小时。", sourceRef: "合成示例", observedAtUtc: now }],
    alternatives: [
      { kind: "method", assessment: "合成：改进方法不足以承接。", estimatedCost: "低" },
      { kind: "knowledge", assessment: "合成：补充知识不足以承接。", estimatedCost: "低" },
      { kind: "another-instance", assessment: "合成：暂无同职责实例。", estimatedCost: "中" },
      { kind: "temporary-assignment", assessment: "合成：临时分派难以持续。", estimatedCost: "中" }],
    firstTaskId, baseline: "合成基线", expectedEffect: "工作有明确承接者。", costLimit: "合成：每周两小时",
    trialDays: 14, reviewAtUtc: new Date(Date.now() + 14 * 864e5).toISOString(), exitCriteria: "两周内无承接空档。" } });
  await command({ type: "role.decide", roleId, expectedVersion: proposed.version ?? 1, decision: "accept-trial", reason: "合成：试行两周。" });
  return roleId;
}

if (projectsOnly) {
  console.log(JSON.stringify({ projectId, report }, null, 2));
  process.exit(report.every(item => item.ok) ? 0 : 1);
}

await section("职责与试行（场景 8）", async () => {
  ids.firstTaskId = await createTask("职责试行的首个任务：梳理走查路线", { owner: ownerRole });
  ids.devRole = await createRole("功能开发", "functional-development", ids.firstTaskId);
  ids.reviewRole = await createRole("产品体验", "product", ids.firstTaskId);
  return { devRole: ids.devRole, reviewRole: ids.reviewRole };
});

await section("目标与阶段（场景 10、总览）", async () => {
  ids.goalId = randomUUID();
  await command({ type: "goal.create", goalId: ids.goalId, outcome: "负责人能在工作台看清每项工作的承接、交付与使用结果。",
    constraints: "只用合成数据；不连接真实运行时。", consumer: "项目负责人", authority: "测试身份 test-owner", scope: "工作台改版走查", owner: "test-owner" });
  ids.stageId = randomUUID();
  const stage = await command({ type: "stage.propose", stageId: ids.stageId, goalId: ids.goalId,
    deliverable: "新外壳与任务页可用于日常对账。", learningQuestion: "双左栏加右侧信息栏能否减少来回跳转？", reason: "合成阶段，用于走查总览。" });
  await command({ type: "stage.accept", stageId: ids.stageId, expectedVersion: stage.version ?? 1, reason: "合成阶段接受。" });
  return { goalId: ids.goalId, stageId: ids.stageId };
});

await section("需求总图与一批任务（场景 1）", async () => {
  const plan = await createDocument("本轮需求总图：任务页改版", "# 本轮需求总图\n\n## 用户与目标\n负责人从任务列表找到要看的工作，读懂约定和结果。\n\n## 本轮切片\n1. 任务列表与筛选\n2. 任务正文与右栏事实\n3. 交付与使用记录\n\n## 建议顺序\n1 → 2 → 3，3 依赖 2 的右栏。", "spec");
  ids.plan = plan;
  ids.batch = [];
  for (const title of ["任务列表与筛选", "任务正文与右栏事实", "交付与使用记录"]) {
    ids.batch.push(await createTask(`总图切片：${title}`, { extra: { documentIds: [plan.documentId], stageId: ids.stageId,
      consumer, evidence: "合成：总图列出的切片。", stopCondition: "总图被取代或本轮取消时停止。" } }));
  }
  return { planDocumentId: plan.documentId, tasks: ids.batch.length };
});

await section("各阶段的任务（场景 2 对账）", async () => {
  const basis = await createDocument("任务依据：对账规则", "# 对账规则 · 第一版\n\n- 每项工作写清下一责任。\n- 运行结束不等于已验收。", "spec");
  await command({ type: "document.adopt", documentId: basis.documentId, expectedVersion: 1, revisionId: basis.revisionId, reason: "合成依据第一版。" });
  ids.basis = basis;
  ids.todo = await createTask("待开始：整理导航入口");
  ids.running = await createTask("进行中：右栏信息核对", { extra: { documentIds: [basis.documentId] } });
  await command({ type: "task.start", taskId: ids.running, expectedVersion: await taskVersion(ids.running), reason: "合成：开始执行。",
    basis: [{ documentId: basis.documentId, revisionId: basis.revisionId }] });
  ids.cancelled = await createTask("已取消：旧版侧栏微调");
  await command({ type: "task.cancel", taskId: ids.cancelled, expectedVersion: await taskVersion(ids.cancelled), reason: "合成：被新外壳取代。" });
  return { todo: ids.todo, running: ids.running, cancelled: ids.cancelled };
});

await section("交付、使用与返工（场景 4）", async () => {
  const fields = { extra: { consumer, useRequired: true, acceptanceMode: "independent_agent", acceptanceTarget: "business_session" } };
  const delivered = [];
  for (const [title, result] of [["待验收：任务页截图说明", null], ["已验收：文档页阅读回归", "used"], ["待返工：Session 返回入口", "failed"]]) {
    const taskId = await createTask(title, fields);
    await command({ type: "task.start", taskId, expectedVersion: await taskVersion(taskId), reason: "合成：开始执行。" });
    const artifact = await createDocument(`交付物：${title}`, `# ${title}\n\n合成交付正文。`, "report");
    await command({ type: "delivery.record", taskId, expectedVersion: await taskVersion(taskId),
      artifactRef: `document:${artifact.documentId}@${artifact.revisionId}`, artifactRevision: artifact.revisionId, contentHash: artifact.contentHash,
      technicalResult: "passed", technicalEvidence: "合成：类型检查与单元测试通过。", reason: "合成交付。" });
    if (result) {
      await command({ type: "observation.record", taskId, deliveryId: await latestDeliveryId(taskId), observer: consumer, observerKind: "agent",
        result, evidence: result === "used" ? "合成：沿原路径读完全文。" : "合成：从任务进入 Session 后无法返回。", reason: "合成使用观察。" }, { token: consumerToken });
    }
    if (result === "used") {
      await command({ type: "task.close", taskId, expectedVersion: await taskVersion(taskId), deliveryId: await latestDeliveryId(taskId),
        acceptanceResult: "met", acceptanceEvidence: "合成：消费者已使用当前交付。", reason: "合成关闭。" });
    }
    delivered.push({ taskId, result: result ?? "pending" });
  }
  return delivered;
});

await section("需求纠正与影响复核（场景 5）", async () => {
  const revised = await command({ type: "document.revise", documentId: ids.basis.documentId, expectedVersion: 2,
    body: "# 对账规则 · 第二版\n\n- 每项工作写清下一责任。\n- 运行结束不等于已验收。\n- 新增：待验收超过两天要提醒。", reason: "合成：新增提醒规则。" });
  await command({ type: "document.adopt", documentId: ids.basis.documentId, expectedVersion: 3, revisionId: revised.revisionId, reason: "合成：采纳第二版，进行中的任务需复核。" });
  return { documentId: ids.basis.documentId };
});

console.log(JSON.stringify({ projectId, report, url: `${base.origin}/#/p/${projectId}/work` }, null, 2));
