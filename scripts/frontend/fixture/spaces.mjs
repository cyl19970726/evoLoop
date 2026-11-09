// Knowledge, schedules, evaluations and the WeChat connector of the screenshot fixture.
import { actorId, agents, ago, hash, id, projectId, roles } from "./common.mjs";
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
const scheduleIds = { daily: id(1400), weekly: id(1401) };
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
  ],
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
