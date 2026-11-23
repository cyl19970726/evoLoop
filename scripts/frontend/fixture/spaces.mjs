// Knowledge, schedules, evaluations and the WeChat connector of the screenshot fixture.
import { actorId, agents, ago, hash, id, later, projectId, roles } from "./common.mjs";
import { docs, revisionIdOf, runIdOf, tasks } from "./work.mjs";

// ---------- knowledge (知识空间) ----------
const pageIds = { topic: id(1300), right: id(1301), narrow: id(1302), coverage: id(1303) };
const pages = {
  [pageIds.topic]: { title: "布局专题", type: "topic", body: "# 布局专题\n\n布局相关的认识都收在这个专题下：双左栏、中间内容、右栏信息。" },
  [pageIds.right]: { title: "右栏只在要时打开", type: "concept",
    body: "# 右栏只在要时打开\n\n1100px 以下右栏是抽屉，只在用户点“展开右栏”时打开，不会自己弹出。\n\n## 适用条件\n\n- 页面有右栏内容。\n- 宽度小于 1100px。\n\n## 反例\n\n窄屏下自动弹出的右栏会遮住正文，试用时三人反映找不到关闭按钮。" },
  [pageIds.narrow]: { title: "窄屏不能换组件树", type: "concept", body: "# 窄屏不能换组件树\n\n跨 760px 换组件树会卸载页面，草稿和滚动位置都会丢。" },
  [pageIds.coverage]: { title: "列表要写明覆盖范围", type: "decision", body: "# 列表要写明覆盖范围\n\n列表写明已载入多少；还有未读的后续页时，只说已载入范围内的结论。" },
};
const revisionOf = knowledgeId => `${knowledgeId.slice(0, 19)}9${knowledgeId.slice(20)}`;
const summary = knowledgeId => ({ knowledgeId, revision: revisionOf(knowledgeId), title: pages[knowledgeId].title, pageType: pages[knowledgeId].type, validity: "valid" });
const sourceKey = `document:${docs.report.id}`;
const relation = (edgeId, from, to, type) => ({ edgeId, fromKnowledgeId: from, fromRevision: revisionOf(from), toKnowledgeId: to,
  toRevision: revisionOf(to), type, sourceKeys: [sourceKey], state: "active" });
const relations = [relation("e-member", pageIds.right, pageIds.topic, "member_of"), relation("e-narrow", pageIds.narrow, pageIds.topic, "member_of"),
  relation("e-challenge", pageIds.narrow, pageIds.right, "contradicts")];
export const knowledge = {
  capabilities: { backendVersion: "fixture", backendReachable: true, fixedRevisionRead: "adapter_verified", conditionalPublish: "single_maintainer_adapter",
    boundedRelations: "adapter_verified", migration: "unsupported", semanticIndex: "unverified" },
  pages: () => ({ items: Object.keys(pages).map(summary), nextCursor: null, watermark: 3 }),
  page: knowledgeId => pages[knowledgeId] ? { projectId, knowledgeId, revision: revisionOf(knowledgeId), previousRevision: null,
    title: pages[knowledgeId].title, body: pages[knowledgeId].body, contentHash: hash("a"), pageType: pages[knowledgeId].type,
    epistemicStatus: "adopted", validity: "valid", observedValidity: "valid", createdAt: ago(60 * 24 * 2),
    sources: knowledgeId === pageIds.topic ? [] : [{ sourceKey, originRevision: docs.report.rev, contentHash: hash("a"), fragment: "主要发现", state: "reachable" }],
    relations: relations.filter(r => r.fromKnowledgeId === knowledgeId) } : null,
  history: knowledgeId => ({ items: [summary(knowledgeId)], nextCursor: null, watermark: 3 }),
  graph: knowledgeId => {
    const edges = relations.filter(r => r.fromKnowledgeId === knowledgeId || r.toKnowledgeId === knowledgeId);
    const nodes = [...new Set([knowledgeId, ...edges.flatMap(r => [r.fromKnowledgeId, r.toKnowledgeId])])].map(summary);
    return { status: "complete", watermark: 3, nodes, edges };
  },
  candidates: () => ({ items: [{ projectId, knowledgeId: id(1310), candidateId: id(1311), candidateRevision: id(1312), expectedRevision: null,
    contentHash: hash("a"), title: "窄屏右栏是底部速览", pageType: "concept", epistemicStatus: "observation", operationId: id(1313),
    actorId: "agent-design", status: "pending", decision: null }], nextCursor: null, watermark: 3 }),
  sources: () => ({ items: [{ documentId: docs.report.id, title: docs.report.title, revisionId: docs.report.rev, sourceKey, state: "reachable" }], nextCursor: null }),
  firstPage: pageIds.right,
};

// ---------- schedules (日程) ----------
const scheduleIds = { daily: id(1400), weekly: id(1401), direct: id(1402), skipping: id(1403) };
/** FIXTURE_ROUTINES=1 adds two more schedules (a direct one whose last task is closed, one that skipped three times in a row); the default lists stay as they are. */
const extra = () => process.env.FIXTURE_ROUTINES === "1";
const scheduleRevision = (scheduleId, title, localTime, state) => ({ projectId, scheduleId, id: scheduleId, version: 1, timezone: "Asia/Shanghai",
  rule: { kind: "daily", localTime }, misfire: { kind: "latest" }, overlap: "skip",
  template: { title, content: `${title}：核对来源并留下报告`, acceptance: "报告写明读到的范围", owner: roles.verify.id, acceptanceMode: "human_required", consumer: actorId },
  authorization: { scopeId: "scope-verify", roleId: roles.verify.id, authorizedBy: actorId, expiresAtUtc: null },
  reason: state === "stopped" ? "试用期结束" : "首次建立", actorId, createdAtUtc: ago(60 * 24 * 6) });
export const schedules = {
  list: () => [
    { projectId, id: scheduleIds.daily, version: 1, currentRevisionId: scheduleIds.daily, state: "active", watermarkUtc: ago(60 * 2),
      revision: scheduleRevision(scheduleIds.daily, "每日验收巡检", "09:00", "active") },
    { projectId, id: scheduleIds.weekly, version: 2, currentRevisionId: scheduleIds.weekly, state: "stopped", watermarkUtc: ago(60 * 24 * 2),
      revision: scheduleRevision(scheduleIds.weekly, "试用反馈汇总", "18:00", "stopped") },
    ...extra() ? [
      { projectId, id: scheduleIds.direct, version: 1, currentRevisionId: scheduleIds.direct, state: "active", watermarkUtc: ago(60 * 2), revision: scheduleRevision(scheduleIds.direct, "直派整理巡检", "10:00", "active") },
      { projectId, id: scheduleIds.skipping, version: 1, currentRevisionId: scheduleIds.skipping, state: "active", watermarkUtc: ago(60 * 2), revision: scheduleRevision(scheduleIds.skipping, "连跳巡检", "11:00", "active") },
    ] : [],
  ],
  /** GET /schedules/:id/dispatch: a policy for the direct sample, none (交 Leader) for the others. */
  dispatch: scheduleId => scheduleId === scheduleIds.direct ? { projectId, scheduleId, version: 1, mode: "direct", state: "active", waitLimitMinutes: 30, dailyRunBudget: null,
    setRevisionId: id(1420), roleRevisionId: id(1421), consecutiveFailures: 0, consecutiveSkips: 0, revertReason: null, actorId, reason: "直派整理", updatedAt: ago(60 * 24) }
    : scheduleId === scheduleIds.skipping ? { projectId, scheduleId, version: 1, mode: "leader", state: "active", waitLimitMinutes: 30, dailyRunBudget: null,
      setRevisionId: id(1422), roleRevisionId: id(1423), consecutiveFailures: 0, consecutiveSkips: 3, revertReason: null, actorId, reason: "交 Leader", updatedAt: ago(60 * 24) } : null,
  dispatches: scheduleId => ({ items: scheduleId !== scheduleIds.direct ? [] : [{ scheduleId, plannedAtUtc: ago(60 * 3), state: "dispatched", reason: "", taskId: tasks.t7.id, sessionId: agents.design.sessionId,
    entryId: id(1430), templateHash: hash("a"), roleRevisionId: id(1421), executionConfig: {}, decidedAt: ago(60 * 3), dispatchedAt: ago(60 * 3), escalatedAt: null }], nextCursor: null }),
  status: () => ({ state: "running", lastTickAt: ago(1), lastError: null, lastCreated: 1,
    grants: [{ projectId, actorId, scopeId: "scope-verify", roleId: roles.verify.id }] }),
  revisions: scheduleId => [schedules.list().find(s => s.id === scheduleId)?.revision].filter(Boolean),
  occurrences: scheduleId => scheduleId !== scheduleIds.daily ? [] : [
    { projectId, scheduleId, revisionId: scheduleId, plannedAtUtc: ago(60 * 2), observedAtUtc: ago(60 * 2 - 1), state: "created", taskId: tasks.t6.id,
      operationId: id(1410), reason: "scheduled" },
    { projectId, scheduleId, revisionId: scheduleId, plannedAtUtc: ago(60 * 26), observedAtUtc: ago(60 * 26 - 1), state: "skipped", taskId: null,
      operationId: id(1411), reason: "overlap skipped" },
  ],
};

// 定时任务: Tasks with their own execution time on 日程 — a one-time Task, a running daily series and a stopped one.
// 页面截图由脚本生成 and 汇总试用反馈 have no timing of their own besides these; 右栏信息核对 has none and must not appear.
const timedItem = (n, rootTask, latestTask, over) => ({ projectId, seriesId: id(1600 + n), rootTaskId: rootTask.id, version: 1, seriesState: "active",
  title: latestTask.title, timezone: "Asia/Shanghai", repeat: "none", executeAtUtc: later(2), nextAtUtc: null, skippedCount: 0, occurrenceCount: 1,
  latestTask: { taskId: latestTask.id, title: latestTask.title, state: latestTask.state, plannedAtUtc: later(2) }, ...over });
export const timedTasks = () => [
  timedItem(1, tasks.t5, tasks.t5, { executeAtUtc: later(2), latestTask: { taskId: tasks.t5.id, title: tasks.t5.title, state: "todo", plannedAtUtc: later(2) } }),
  timedItem(2, tasks.t2, tasks.t6, { repeat: "daily", executeAtUtc: ago(60 * 24 * 2), nextAtUtc: later(1), occurrenceCount: 3,
    latestTask: { taskId: tasks.t6.id, title: tasks.t6.title, state: "in_progress", plannedAtUtc: ago(60 * 2) } }),
  timedItem(3, tasks.t7, tasks.t7, { repeat: "daily", seriesState: "stopped", executeAtUtc: ago(60 * 24 * 6), occurrenceCount: 4, skippedCount: 1,
    latestTask: { taskId: tasks.t7.id, title: tasks.t7.title, state: "done", plannedAtUtc: ago(60 * 24 * 3) } }),
];
// 例行健康: the schedules and timed series above as one table, in the order the server gives it.
export const routineHealth = () => {
  const item = over => ({ kind: "schedule", rule: null, timezone: "Asia/Shanghai", repeat: null, rootTaskId: null, misfire: "latest", lastTrigger: null,
    consecutiveSkips: 0, skippedTotal: null, nextAtUtc: null, overdue: null, lastTaskOpen: false, watermarkUtc: null, ...over });
  const [daily, weekly] = schedules.list();
  return { projectId, observedAt: ago(1), complete: true, items: [
    item({ id: daily.id, title: daily.revision.template.title, state: "active", rule: daily.revision.rule, watermarkUtc: daily.watermarkUtc, nextAtUtc: later(0.9), lastTaskOpen: true,
      lastTrigger: { plannedAtUtc: ago(60 * 2), observedAtUtc: ago(60 * 2 - 1), outcome: "created", reason: "scheduled", task: { taskId: tasks.t6.id, title: tasks.t6.title, state: "in_progress" } } }),
    ...timedTasks().map(series => item({ kind: "timed_series", id: series.seriesId, title: series.title, state: series.seriesState, repeat: series.repeat, rootTaskId: series.rootTaskId,
      misfire: null, skippedTotal: series.skippedCount, nextAtUtc: series.seriesState === "stopped" ? null : series.nextAtUtc ?? series.executeAtUtc,
      lastTaskOpen: series.latestTask.state !== "done", lastTrigger: { plannedAtUtc: series.latestTask.plannedAtUtc, observedAtUtc: null, outcome: "created", reason: "scheduled",
        task: { taskId: series.latestTask.taskId, title: series.latestTask.title, state: series.latestTask.state } } })),
    item({ id: weekly.id, title: weekly.revision.template.title, state: "stopped", rule: weekly.revision.rule, watermarkUtc: weekly.watermarkUtc }),
    ...extra() ? [
      item({ id: scheduleIds.direct, title: "直派整理巡检", state: "active", rule: { kind: "daily", localTime: "10:00" }, nextAtUtc: later(0.5),
        lastTrigger: { plannedAtUtc: ago(60 * 3), observedAtUtc: ago(60 * 3 - 1), outcome: "created", reason: "scheduled", task: { taskId: tasks.t7.id, title: tasks.t7.title, state: "done" } } }),
      item({ id: scheduleIds.skipping, title: "连跳巡检", state: "active", rule: { kind: "daily", localTime: "11:00" }, nextAtUtc: later(0.6), consecutiveSkips: 3,
        lastTrigger: { plannedAtUtc: ago(60 * 3), observedAtUtc: ago(60 * 3 - 1), outcome: "skipped", reason: "PREVIOUS_STILL_OPEN", task: null } }),
    ] : [],
  ] };
};
export const timedFocus = tasks.t2.id;

// ---------- evaluations (评价与后果) ----------
const evaluationId = id(1500), evaluationRevision = id(1501), caseId = id(1502), directId = id(1503), wikiId = id(1504);
const environment = { cwd: "/srv/evoloop/workbench", authorizationScope: "前端任务", sandbox: "workspace-write", approvalPolicy: "never" };
const protocol = { kind: "document", id: docs.rule.id, revision: docs.rule.rev, contentHash: hash("a") };
const caseTask = tasks.t1;
const definition = {
  ownerTaskId: tasks.t5.id, question: "加入固定知识页后，右栏核对是否一次通过？", protocol,
  case: { id: caseId, taskId: caseTask.id, sourceTaskRevisionId: revisionIdOf(caseTask), commonInput: "按完成条件实现右栏信息核对并交付",
    criteria: "三个宽度的浏览器回归通过；验收一次通过", materials: [{ kind: "git", id: "evoLoop", revision: "4f1c2ab", contentHash: hash("b") }],
    sourceSignature: { title: caseTask.title, contentDocumentId: docs.taskBody.id, contentRevisionId: docs.taskBody.rev, acceptance: "三个宽度都能读",
      owner: roles.dev.id, kind: "implementation", basis: [{ documentId: docs.map.id, revisionId: docs.map.rev, contentHash: hash("c") }], retentions: [], external: [] } },
  conditions: [{ id: directId, kind: "direct", wikiRefs: null, model: "gpt-6-sol", environment },
    { id: wikiId, kind: "wiki", wikiRefs: [{ kind: "wiki", id: knowledge.firstPage, revision: revisionOf(knowledge.firstPage), contentHash: hash("d") }], model: "gpt-6-sol", environment }],
  limits: "同一环境下工具访问隔离未验证；单例不能推断知识收益。",
};
const evaluation = { projectId, evaluationId, id: evaluationRevision, version: 1, definition, actorId, reason: "建立", createdAt: ago(60 * 24 * 2) };
const secondEvaluation = { ...evaluation, evaluationId: id(1510), id: id(1511),
  definition: { ...definition, question: "只给需求总图，能否独立完成任务列表？", case: { ...definition.case, taskId: tasks.t2.id,
    sourceSignature: { ...definition.case.sourceSignature, title: tasks.t2.title } } } };
export const evaluations = {
  id: evaluationId,
  list: () => ({ items: [evaluation, secondEvaluation], nextCursor: null }),
  detail: evaluationKey => evaluationKey !== evaluationId ? null : {
    revision: evaluation, revisions: [evaluation],
    attempts: [{ projectId, id: id(1520), evaluationId, revisionId: evaluationRevision, caseId, conditionId: directId, ordinal: 1, runId: runIdOf(tasks.t1),
      sourceTaskRevisionId: revisionIdOf(caseTask), actualTaskRevisionId: revisionIdOf(caseTask), sessionId: agents.dev.sessionId, actorId, createdAt: ago(160) }],
    assessments: [], conclusions: [],
  },
};

// ---------- WeChat connector (微信连接) ----------
const route = (n, label, kind, agent, state) => ({ projectId, bindingId: id(1600 + n), conversationLabel: label, conversationKind: kind,
  source: { provider: "wechat", connectionId: "wx-workbench", conversationId: `room-${n}` }, targetSessionId: agents[agent].sessionId,
  targetThreadId: `thread-${agent}`, targetActorId: `agent-${agent}`, senderActorId: `agent-${agent}-out`, owner: "wx-owner", epoch: 1,
  sessionRef: `wx-session-${n}`, senderIds: ["wx-zhang"], sendTargets: [`room-${n}`], internalTargets: [], policyHash: hash("b"), mode: "standard",
  state, version: 2, createdAt: ago(60 * 24 * 4), updatedAt: ago(60 * 3) });
export const connectors = {
  routes: () => ({ items: [route(1, "工作台改版群", "group", "dev", "active"), route(2, "张审阅（私聊）", "direct", "lead", "paused")], nextCursor: null }),
  deliveries: bindingId => bindingId !== id(1601) ? { items: [] } : { items: [
    { deliveryId: 21, eventCount: 2, unhandledCount: 0, latestMessageState: "replied", decision: { decision: "reply", state: "observed", requestId: "req-21" } },
    { deliveryId: 20, eventCount: 1, unhandledCount: 1, latestMessageState: "pending", decision: null }] },
};
