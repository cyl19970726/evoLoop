// Tasks, documents, goals and stages of the screenshot fixture.
import { actorId, agents, ago, hash, id, later, projectId, roles } from "./common.mjs";

// ---------- documents ----------
const markdownBody = [
  "# 工作台改版：本轮需求总图", "",
  "这一轮把任务、文档和团队三个空间换到新的布局：双左栏导航、中间内容、右栏信息。", "",
  "## 本轮切片", "",
  "1. 任务列表与任务页：列表进内层栏，表格视图给统筹对账。",
  "2. 文档阅读：原件按固定版本读出，右栏放版本、来源和引用它的任务。",
  "3. 团队：职责、分工与运行、分工讨论分开成页。", "",
  "## 完成条件", "",
  "| 条件 | 怎样核对 |", "| --- | --- |",
  "| 三个宽度都能读 | 1440、1024、390 截图，窄屏没有横向滚动 |",
  "| 读取失败不下结论 | 断开接口后写“无法判断”，不写“没有” |",
  "| 旧功能都在 | 按功能对照表逐项核对 |", "",
  "## 不做什么", "",
  "- 不改服务端接口。",
  "- 不在这一轮做实时事件流。", "",
  "## 风险", "",
  "旧样式没有分层，会压过新组件；每迁移一页就删掉那一页的旧样式。",
].join("\n");

export const docs = {
  map: { id: id(100), rev: id(101), title: "本轮需求总图", kind: "spec", status: "published", body: markdownBody },
  rule: { id: id(102), rev: id(104), oldRev: id(103), title: "对账规则", kind: "spec", status: "published",
    body: "# 对账规则\n\n## 第 2 版\n\n已分派、已接受、正在运行分开写；交付通过不等于已验收。\n\n- 读取失败写“无法判断”。\n- 只说记录能证明的事。",
    oldBody: "# 对账规则\n\n## 第 1 版\n\n已分派与已接受分开写。" },
  taskBody: { id: id(105), rev: id(106), title: "右栏信息核对：任务正文", kind: "task", status: "published",
    body: "# 右栏信息核对\n\n右栏要和中间说同一件事：选中哪一项，右栏就换成这一项的状态、承接和关联文档。" },
  report: { id: id(107), rev: id(108), title: "试用反馈汇总", kind: "report", status: "published",
    body: "# 试用反馈汇总\n\n五位试用者用了三天。\n\n## 主要发现\n\n- 表格视图适合统筹对账。\n- 窄屏下右栏要从底部升起。\n- 文档页需要返回来源。" },
  review: { id: id(109), rev: id(110), title: "十一月第一周组织复盘", kind: "organization_review", status: "published",
    body: "# 十一月第一周组织复盘\n\n本周三个职责都按时交付，验收排队偏长。" },
  issue: { id: id(111), rev: id(112), title: "窄屏下内层栏遮住正文", kind: "issue", status: "draft",
    body: "# 窄屏下内层栏遮住正文\n\n390 宽度下打开内层栏后，关闭按钮不明显。" },
  discussion: { id: id(113), rev: id(114), title: "验收排队怎样分担", kind: "discussion", status: "draft",
    body: "# 验收排队怎样分担\n\n两种做法：增加一位常驻验收，或让设计走查分担界面验收。" },
  html: { id: id(115), rev: id(116), title: "首轮试用报告", kind: "report", status: "published", html: [
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>首轮试用报告</title><style>",
    "body{font-family:system-ui,sans-serif;margin:0;padding:32px 40px;color:#1f2a2e;line-height:1.7}h1{font-size:26px;margin:0 0 8px}",
    "h2{font-size:19px;margin:28px 0 8px}.meta{color:#5d6b70;font-size:13px}table{border-collapse:collapse;margin:12px 0}",
    "td,th{border:1px solid #d5dcdf;padding:6px 12px;text-align:left}th{background:#eef2f3}.bar{height:10px;background:#5b7fd6;border-radius:4px}",
    "</style></head><body><h1>首轮试用报告</h1><p class=\"meta\">五位试用者 · 三天 · 合成示例</p>",
    "<h2>每天打开工作台的人数</h2><table><tr><th>日期</th><th>人数</th><th></th></tr>",
    "<tr><td>第 1 天</td><td>3</td><td><div class=\"bar\" style=\"width:120px\"></div></td></tr>",
    "<tr><td>第 2 天</td><td>4</td><td><div class=\"bar\" style=\"width:160px\"></div></td></tr>",
    "<tr><td>第 3 天</td><td>5</td><td><div class=\"bar\" style=\"width:200px\"></div></td></tr></table>",
    "<h2>主要发现</h2><ul><li>表格视图适合统筹对账，列设置用得最多。</li><li>窄屏下右栏要从底部升起，不能遮住正文。</li>",
    "<li>文档页需要“返回来源”，从任务进入后能回到原处。</li></ul>",
    "<h2>下一步</h2><p>按发现调整右栏与返回入口，第二轮试用加入周末数据。</p></body></html>",
  ].join("") },
};
const docList = Object.values(docs);

export function documentRecord(d) {
  return { projectId, id: d.id, title: d.title, version: d.oldRev ? 2 : 1, currentRevisionId: d.rev,
    adoptedRevisionId: d.status === "published" ? d.rev : null, kind: d.kind, status: d.status,
    primaryTaskId: d === docs.taskBody ? tasks.t1.id : null, createdAt: ago(60 * 24 * 4), updatedAt: ago(90), origin: null };
}
export function revisionRecord(d, revisionId = d.rev) {
  const old = revisionId === d.oldRev;
  // An HTML report is kept only as its original (no inline body); the page reads it from /original.
  const html = d.html ? { body: null, format: "html", mediaType: "text/html", originalName: "report.html", payloadRef: revisionId, entrypoint: "report.html" }
    : { body: old ? d.oldBody : d.body, format: "markdown", mediaType: "text/markdown", originalName: `${d.title}.md`, payloadRef: null, entrypoint: null };
  return { projectId, documentId: d.id, id: revisionId, ...html, assetsManifest: [], contentHash: hash(old ? "b" : "a"),
    author: actorId, createdAt: old ? ago(60 * 24 * 3) : ago(90), previousRevisionId: !old && d.oldRev ? d.oldRev : null,
    reason: old ? "建立对账规则" : "补充交付与验收的区分" };
}
export const documentList = () => docList.map(documentRecord);
/** The tasks that reference a document (文档页右栏 “引用它的任务”). */
export const documentReferences = d => references(d).map(ref => {
  const t = findTask(ref.taskId);
  return { projectId, id: t.id, title: t.title, state: t.state, owner: roles[t.owner].id, kind: t.kind, version: 2,
    currentRevisionId: revisionId(t), relations: ref.relations };
});
const references = d => d === docs.map ? [{ taskId: tasks.t1.id, title: tasks.t1.title, state: "in_progress", relations: ["basis"] },
    { taskId: tasks.t2.id, title: tasks.t2.title, state: "in_progress", relations: ["link"] }]
    : d === docs.rule ? [{ taskId: tasks.t1.id, title: tasks.t1.title, state: "in_progress", relations: ["basis"] }]
      : d === docs.taskBody ? [{ taskId: tasks.t1.id, title: tasks.t1.title, state: "in_progress", relations: ["content"] }]
        : d === docs.report ? [{ taskId: tasks.t1.id, title: tasks.t1.title, state: "in_progress", relations: ["link"] }] : [];
/** The documents view of the work index: use and referencing tasks of each document. */
export const documentWorkIndex = () => {
  const items = docList.map((d, n) => ({ kind: "document", documentId: d.id, version: d.oldRev ? 2 : 1, title: d.title, documentKind: d.kind,
    status: d.status, currentRevisionId: d.rev, adoptedRevisionId: d.status === "published" ? d.rev : null,
    nextAction: d.status === "draft" ? "补充后发布" : "", dates: { createdAt: ago(60 * 24 * 4), currentRevisionAt: ago(90 + n * 60),
      adoptedAt: d.status === "published" ? ago(90 + n * 60) : null, changedAt: ago(90 + n * 60), observedAt: ago(1) },
    references: references(d), actionKey: `document:${d.id}` }));
  return { items, nextCursor: null, total: items.length, counts: {}, changeSequence: 48, observedAt: ago(1), partial: false };
};
export const findDocument = documentId => docList.find(d => d.id === documentId) ?? null;

// ---------- tasks ----------
const task = (n, title, state, owner, extra = {}) => ({ id: id(200 + n), n, title, state, owner, kind: "implementation", ...extra });
export const tasks = {
  t1: task(1, "右栏信息核对", "in_progress", "dev", { phase: "awaiting_acceptance", agent: "dev", ack: "accepted", priority: 1, due: 1,
    run: "completed", delivery: true, impact: true, stage: "s1" }),
  t2: task(2, "任务列表与筛选", "in_progress", "dev", { phase: "running", agent: "dev", ack: "accepted", priority: 2, due: 3, run: "running", stage: "s1" }),
  t3: task(3, "智能体返回入口", "in_progress", "dev", { phase: "rework", agent: "dev", ack: "accepted", priority: 1, due: -1, stage: "s1" }),
  t4: task(4, "日程提醒接入", "in_progress", "dev", { phase: "blocked", priority: 2, dependsOn: 2, stage: "s1" }),
  t5: task(5, "页面截图由脚本生成", "todo", "docs", { phase: "unassigned", priority: 3, kind: "validation" }),
  t6: task(6, "验收新版外壳", "in_progress", "verify", { phase: "awaiting_delivery", agent: "verify", ack: "assigned", stage: "s1" }),
  t7: task(7, "汇总试用反馈", "done", "design", { phase: "closed", agent: "design", ack: "accepted", kind: "research", stage: "s2" }),
  t8: task(8, "整理旧文档", "todo", "docs", { phase: "ready", agent: "docs", ack: "accepted", priority: 3 }),
};
const taskList = Object.values(tasks);
export const findTask = taskId => taskList.find(t => t.id === taskId) ?? null;
const revisionId = t => id(300 + t.n);
const runId = t => id(400 + t.n);
const deliveryId = t => id(500 + t.n);

export function taskRecord(t) {
  return { projectId, id: t.id, version: 2, currentRevisionId: revisionId(t), title: t.title,
    content: t === tasks.t1 ? docs.taskBody.body : `# ${t.title}\n\n${t.title}的正文：说明要做什么、为什么做。`,
    contentDocumentId: t === tasks.t1 ? docs.taskBody.id : id(600 + t.n), contentRevisionId: t === tasks.t1 ? docs.taskBody.rev : id(650 + t.n),
    kind: t.kind, acceptance: "1. 选中哪一项，右栏就换成这一项。\n2. 1024 以下右栏是抽屉，不会自己弹出。\n3. 读取失败写“无法判断”。",
    owner: roles[t.owner].id, state: t.state };
}

export const stages = {
  s1: { id: id(700), goal: "g1", deliverable: "新版任务与文档页", state: "active", version: 2 },
  s2: { id: id(701), goal: "g1", deliverable: "试用反馈", state: "reviewed", version: 3 },
  s3: { id: id(702), goal: "g2", deliverable: "对外说明初稿", state: "proposed", version: 1 },
};
export const goals = {
  g1: { id: id(710), outcome: "让试用团队每天用上新版工作台" },
  g2: { id: id(711), outcome: "整理第二季度的对外说明" },
};

export function projection(t) {
  const agent = t.agent ? agents[t.agent] : null;
  const stage = t.stage ? stages[t.stage] : null;
  const nextAction = { awaiting_acceptance: "由声明验收责任者核对当前交付与实际使用", running: "等待当前运行的真实终态",
    rework: "按验收意见返工后重新交付", blocked: "等待前置任务通过验收", unassigned: "负责人选择真实职责并按当前版本正式分派",
    awaiting_delivery: "核对运行终态与本人提交", closed: "", ready: "可以开始" }[t.phase] ?? "";
  const responsible = t.phase === "awaiting_acceptance" ? { kind: "consumer", id: agents.verify.sessionId, label: "独立验收" }
    : t.phase === "unassigned" ? { kind: "leader", id: null, label: "统筹" } : { kind: "role", id: roles[t.owner].id, label: roles[t.owner].title };
  return {
    kind: "task", taskId: t.id, version: 2, currentRevisionId: revisionId(t), workChangeSequence: 40 + t.n, title: t.title,
    taskKind: t.kind, taskState: t.state, phase: t.phase, nextAction, responsible,
    assignment: agent ? { state: t.ack, targetKind: "owned", targetId: agent.sessionId, recipientActorId: `agent-${t.agent}` } : null,
    latestRun: t.run ? { runId: runId(t), state: t.run } : null,
    delivery: t.delivery ? { deliveryId: deliveryId(t), taskRevisionId: revisionId(t), technicalResult: "passed", consumer: "独立验收",
      useRequired: true, observationResult: null, observationActorId: null, observationKind: null } : null,
    pendingImpactCount: t.impact ? 1 : 0, queueHold: null,
    goal: stage ? { goalId: goals[stage.goal].id, outcome: goals[stage.goal].outcome } : null,
    stage: stage ? { stageId: stage.id, deliverable: stage.deliverable } : null,
    plan: t.priority || t.due !== undefined ? { plannedStartAt: null, dueAt: t.due !== undefined ? later(t.due) : null, priority: t.priority ?? null } : null,
    dependencies: t.dependsOn ? [{ taskId: tasks[`t${t.dependsOn}`].id, title: tasks[`t${t.dependsOn}`].title, state: "in_progress",
      currentRevisionId: revisionId(tasks[`t${t.dependsOn}`]), acceptanceSatisfied: false }] : [],
    dependencyVersion: t.dependsOn ? 1 : 0, review: null,
    dates: { createdAt: ago(60 * 24 * (9 - t.n)), businessChangedAt: ago(15 * t.n), startedAt: t.state === "todo" ? null : ago(60 * 24 * 2),
      completedAt: t.state === "done" ? ago(60 * 20) : null, observedAt: ago(1) },
    latestProgress: { sequence: 40 + t.n, entityKind: "task", entityId: t.id, eventName: "task.revised", changedAt: ago(15 * t.n) },
    timing: timingOf(t), actionKey: `task:${t.id}:v2:${t.phase}`,
  };
}
const timingStage = { awaiting_acceptance: "awaiting_acceptance", running: "running", rework: "rework", blocked: "blocked", unassigned: "unassigned",
  awaiting_delivery: "awaiting_delivery", closed: "closed", ready: "awaiting_run" };
const waitingFor = { awaiting_acceptance: "consumer", running: "session", rework: "session", blocked: "task", unassigned: "leader",
  awaiting_delivery: "session", closed: "unknown", ready: "session" };
function timingOf(t) {
  const started = ago(15 * t.n + 30);
  const current = { stage: timingStage[t.phase], startedAt: started, endedAt: null, source: { kind: "task", id: t.id },
    waitingFor: { kind: waitingFor[t.phase], id: null }, elapsedMs: (15 * t.n + 30) * 60000 };
  return { createdAt: ago(60 * 24 * (9 - t.n)), publication: { at: null, source: "unknown" }, current,
    rounds: [{ number: 1, startedAt: ago(60 * 24 * (9 - t.n)), endedAt: null, elapsedMs: null, intervals: [current] }],
    latestEffectiveProgress: { kind: "task.revised", sourceId: t.id, at: ago(15 * t.n) }, executionActivity: null, observedAt: ago(1) };
}
export const workIndex = (includeClosed = true) => {
  const items = taskList.filter(t => includeClosed || t.phase !== "closed").map(projection);
  const counts = {};
  for (const item of items) counts[item.phase] = (counts[item.phase] ?? 0) + 1;
  return { items, nextCursor: null, total: items.length, counts, changeSequence: 48, observedAt: ago(1), partial: false };
};

export function taskDetail(t) {
  const record = taskRecord(t);
  const featured = t === tasks.t1;
  return {
    task: record,
    revision: { ...record, taskId: t.id, id: revisionId(t), basisSetId: featured ? id(800) : null, actorId: "leader-actor",
      reason: "按本轮需求总图补充完成条件", createdAt: ago(60 * 24) },
    basis: featured ? { projectId, taskId: t.id, taskRevisionId: revisionId(t), id: id(800), sealed: true,
      members: [{ documentId: docs.map.id, revisionId: docs.map.rev }, { documentId: docs.rule.id, revisionId: docs.rule.oldRev }] } : null,
    links: featured ? [{ projectId, id: id(801), taskId: t.id, documentId: docs.report.id, actorId: "leader-actor", createdAt: ago(60 * 30) }] : [],
    impacts: featured ? [{ projectId, id: id(802), taskId: t.id, taskRevisionId: revisionId(t), documentId: docs.rule.id,
      fromRevisionId: docs.rule.oldRev, toRevisionId: docs.rule.rev, state: "pending", decisionId: null, createdAt: ago(90) }] : [],
    decisions: [],
    deliveries: t.delivery ? [{ projectId, id: deliveryId(t), taskId: t.id, taskRevisionId: revisionId(t), runId: runId(t), sourceRunVersion: 3,
      submittedByActorId: "agent-dev", artifactRef: "git:evoloop/workbench", artifactRevision: "4f1c2ab", contentHash: hash("c"),
      technicalResult: "passed", technicalEvidence: "类型检查、单元测试和三个宽度的浏览器回归通过", reason: "交付右栏信息核对",
      actorId: "agent-dev", createdAt: ago(45) }] : [],
    observations: [], closures: [],
  };
}
/** Oldest first, as the coordinator lists them (ORDER BY version). */
export const taskRevisions = t => [
  { revision: { ...taskRecord(t), taskId: t.id, id: id(350 + t.n), version: 1, state: "todo", acceptance: "选中哪一项，右栏就换成这一项。",
    basisSetId: null, actorId: "leader-actor", reason: "建立任务", createdAt: ago(60 * 24 * 3) }, basis: null },
  { revision: { ...taskRecord(t), taskId: t.id, id: revisionId(t), version: 2, basisSetId: t === tasks.t1 ? id(800) : null, actorId: "leader-actor",
    reason: "按本轮需求总图补充完成条件", createdAt: ago(60 * 24) }, basis: taskDetail(t).basis },
];
export const assignmentOf = t => t.agent ? { projectId, taskId: t.id, version: 1, taskRevisionId: revisionId(t),
  target: { kind: "owned", sessionId: agents[t.agent].sessionId }, recipientActorId: `agent-${t.agent}`, state: t.ack,
  ack: t.ack === "accepted" ? { method: "direct", actorId: `agent-${t.agent}`, observerActorId: `agent-${t.agent}`, evidence: "读过固定输入后接手", sourceRef: null, at: ago(60 * 26) } : null,
  actorId: "leader-actor", reason: "按职责安排", updatedAt: ago(60 * 26) } : null;
export const runOf = t => t.run ? { projectId, id: runId(t), taskId: t.id, taskRevisionId: revisionId(t), sessionId: agents[t.agent].sessionId,
  state: t.run, version: 3, createdAt: ago(120), updatedAt: ago(t.run === "running" ? 3 : 50) } : null;
export const runIdOf = runId;
export const revisionIdOf = revisionId;
export const taskListPage = () => ({ items: taskList.map(taskRecord), nextCursor: null });
export const allTasks = taskList;

/** The acceptance arranged for a delivered task: sent to the verifying agent, not yet used. */
export const acceptanceRelays = t => !t.delivery ? [] : [{ relayId: id(820), version: 1, operationId: id(821), supersedesRelayId: null,
  arrangedBy: "leader-actor", taskId: t.id, taskRevisionId: revisionId(t), deliveryId: deliveryId(t), stage: "candidate", scopeKey: "human-use",
  scopeDescription: "在 1440、1024、390 三个宽度打开任务页，核对右栏", entrypoint: null, publicationRef: null, reason: "交付后安排独立验收",
  mode: "session", recipientActorId: "agent-verify", sessionId: agents.verify.sessionId, roleId: roles.verify.id, senderActorId: "leader-actor",
  state: "linked", blockedReason: null, messageId: id(822), messageOperationId: id(823), messageState: "delivered", processingState: "running",
  nativeTurnId: "turn-v1", readActorId: null, humanReadAt: null, observationId: null, observationResult: null, observationActorId: null,
  evidenceLevel: null, independenceEvidence: "distinct_runtime_session", createdAt: ago(40), updatedAt: ago(20) }];

/** The orchestration status of one task (none of the fixture's tasks is a cognition record). */
export const workStatus = taskId => {
  const t = findTask(taskId);
  return { taskId, cognition: false, dispatchId: null, dispatchState: null, outcome: null, runId: t?.run ? runId(t) : null,
    runState: t?.run ?? null, unsettledRunState: null, loopState: null, goalOutcome: null, stageDeliverable: null, sourceKind: null,
    sourceTaskId: null, sourceTaskTitle: null, decisionKind: null, decisionReason: null, useRequired: t?.delivery ? true : null,
    deliveryId: t?.delivery ? deliveryId(t) : null, technicalResult: t?.delivery ? "passed" : null, observationResult: null,
    observerKind: null, hasClosure: t?.state === "done", readyForAcceptance: t?.phase === "awaiting_acceptance" };
};

export const goalRecord =(key, version = 1) => ({ projectId, id: goals[key].id, version, outcome: goals[key].outcome,
  constraints: "保留原始证据，不改服务端接口", consumer: "试用团队", authority: "可以调整工作台读写", scope: "本季度",
  owner: roles.lead.id, actorId: "leader-actor", createdAt: ago(60 * 24 * 10) });
export const stageRecord = key => { const s = stages[key]; return { projectId, id: s.id, goalId: goals[s.goal].id, version: s.version,
  deliverable: s.deliverable, learningQuestion: `${s.deliverable}能否被真实使用？`, state: s.state, actorId: "leader-actor", createdAt: ago(60 * 24 * 8) }; };
export const stageReviews = { [stages.s2.id]: [{ projectId, id: id(720), stageId: stages.s2.id, stageVersion: 3, supersedesReviewId: null,
  adopted: "每天打开工作台的人变多", rejected: "提醒能代替使用", gap: "缺少周末数据", nextChoice: "stop", evidence: "试用反馈汇总",
  reason: "阶段目标已达成", actorId: "leader-actor", createdAt: ago(60 * 30) }] };
