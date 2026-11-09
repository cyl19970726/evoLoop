// Roles (持续职责), the runtime behind them, discussions, organization reviews and collaboration receipts.
import { actorId, agents, ago, id, projectId, roles } from "./common.mjs";
import { docs, revisionIdOf, runIdOf, tasks } from "./work.mjs";

const evidence = [
  { kind: "rework", observation: "上月任务页返工三次", sourceRef: `task://${tasks.t3.id}`, observedAtUtc: ago(60 * 24 * 12) },
  { kind: "effect", observation: "同一人连续负责后返工减少", sourceRef: `task://${tasks.t1.id}`, observedAtUtc: ago(60 * 24 * 6) },
  { kind: "cost", observation: "每周约两个工作日", sourceRef: `task://${tasks.t2.id}`, observedAtUtc: ago(60 * 24 * 6) },
];
const alternatives = [
  { kind: "method", assessment: "写进开发规范仍需有人持续判断", estimatedCost: "低" },
  { kind: "knowledge", assessment: "知识页不能代替交付", estimatedCost: "低" },
  { kind: "another-instance", assessment: "已有职责没有空余实例", estimatedCost: "中" },
  { kind: "temporary-assignment", assessment: "临时安排不能持续", estimatedCost: "中" },
];
const templateOf = { lead: "lead", dev: "functional-development", verify: null, design: "product", docs: null };
export function roleRecord(key) {
  const r = roles[key];
  const state = key === "docs" ? "candidate" : key === "design" ? "trial" : "active";
  return { projectId, id: r.id, version: 3, currentRevisionId: id(1100 + Object.keys(roles).indexOf(key)), state,
    proposal: { title: r.title, roleClass: r.roleClass, templateKey: templateOf[key], goal: r.responsibility,
      independentResponsibility: "需要持续判断交付边界", ownerScope: key === "dev" ? "工作台页面" : r.title, inputs: ["任务", "需求总图"],
      writableAssets: key === "dev" ? ["apps/workbench"] : ["docs/frontend"], deliverables: ["可核对的交付"], triggers: ["任务分派"],
      workflow: "读依据、实现、验证、交付", handoffBoundary: "服务端接口归后端职责", evidence, alternatives, firstTaskId: tasks.t1.id,
      baseline: "每周返工三次", expectedEffect: "每周不超过一次", costLimit: "两周", trialDays: 14, reviewAtUtc: ago(-60 * 24 * 5),
      exitCriteria: "两周后返工没有减少" },
    proposedBy: "leader-actor", createdAtUtc: ago(60 * 24 * 20), trialStartedAtUtc: state === "candidate" ? null : ago(60 * 24 * 9),
    reviewAtUtc: ago(-60 * 24 * 5), mergeTargetRoleId: null };
}
const roleKeys = Object.keys(roles);
export const roleList = () => roleKeys.map(roleRecord);
export const roleKeyOf = roleId => roleKeys.find(key => roles[key].id === roleId) ?? null;

const templates = [
  { key: "lead", title: "Lead", roleClass: "system" }, { key: "cognition", title: "认知", roleClass: "system" },
  { key: "division", title: "分工", roleClass: "system" }, { key: "product", title: "产品", roleClass: "business" },
  { key: "architecture", title: "架构", roleClass: "business" }, { key: "development-workflow", title: "开发流程与规范", roleClass: "business" },
  { key: "functional-development", title: "功能开发", roleClass: "business" },
];
export const roleTemplates = () => ({
  templates: templates.map(t => {
    const owner = roleKeys.find(key => templateOf[key] === t.key);
    return { ...t, state: owner ? "established" : "not-established", roleIds: owner ? [roles[owner].id] : [] };
  }),
  roles: roleKeys.filter(key => templateOf[key]).map(roleRecord), nextCursor: null,
});

export const roleRevisions = key => [{ projectId, roleId: roles[key].id, id: roleRecord(key).currentRevisionId, version: 3, state: roleRecord(key).state,
  proposal: roleRecord(key).proposal, actorId: "leader-actor", reason: "接受有限试行", createdAtUtc: ago(60 * 24 * 9), reviewAtUtc: ago(-60 * 24 * 5), mergeTargetRoleId: null }];
export const roleBindings = key => Object.entries(agents).filter(([, a]) => a.role === key).map(([, a], n) => ({ projectId, id: id(1120 + n),
  roleId: roles[key].id, sessionId: a.sessionId, roleRevisionId: roleRecord(key).currentRevisionId, actorId: "leader-actor", note: "主承载", createdAtUtc: ago(60 * 24 * 8) }));
export const roleRuntime = key => ({ projectId, roleId: roles[key].id, binding: null, history: [], provider: "codex", providerSource: "default",
  availableProviders: ["codex"], providerAvailable: true, selection: { project: true, personal: false, builtin: true, add: [], remove: [] },
  selectionSource: "default", workDirectory: { cwd: "/srv/evoloop/workbench", source: "grant" },
  skills: [{ name: "evoloop-workflow", source: "evoloop", selected: true, reason: "business", description: "业务流程：接手、交付、使用回执",
    location: ".agents/skills/evoloop-workflow", contentHash: null, delivery: "role_context" },
  { name: "frontend-design", source: "project", selected: true, reason: "project", description: "页面设计与走查",
    location: ".claude/skills/frontend-design", contentHash: null, delivery: "role_context" }],
  missing: [], skillsReportedBy: "files", plugins: [], mcpServers: [], notes: [], observedAtUtc: ago(10) });

// ---------- runtime (分工与运行) ----------
const grant = { projectId, actorId, roleId: roles.dev.id, authorizationScope: "前端任务", cwd: "/srv/evoloop/workbench", sandbox: "workspace-write",
  approvalPolicy: "never", networkAccess: true, models: ["gpt-6-sol"] };
export const runtime = () => ({ available: true, error: null, allowedCwds: ["/srv/evoloop/workbench"], grants: [grant] });
export const runtimeRuns = () => [tasks.t2, tasks.t1].map(t => ({ projectId, id: runIdOf(t), taskId: t.id, taskRevisionId: revisionIdOf(t),
  basisSetId: null, sessionId: agents.dev.sessionId, operationId: runIdOf(t), input: `执行任务：${t.title}`, inputHash: "a",
  state: t.run, version: 3, nativeTurnId: "turn", interruptRequested: false, resultSummary: t.run === "completed" ? "已交付，等待验收" : null,
  actorId: "leader-actor", createdAt: ago(t === tasks.t2 ? 40 : 160), updatedAt: ago(t === tasks.t2 ? 3 : 50) }));
export const orchestrationStatus = () => ({ state: "active", running: true, busy: false, faults: [], lastError: null, observedAt: ago(1) });

// ---------- discussions (分工讨论) ----------
export const discussionId = id(1200);
const discussion = { projectId, id: discussionId, version: 2, kind: "allocation", status: "handed_off", documentId: docs.discussion.id,
  preparedDocumentRevisionId: docs.discussion.rev, currentDocumentRevisionId: docs.discussion.rev, latestDecisionEventId: null,
  goal: { id: id(710), version: 1 }, stage: { id: id(700), version: 2 }, task: { id: tasks.t6.id, revisionId: revisionIdOf(tasks.t6) },
  adoptedDocuments: [{ documentId: docs.map.id, revisionId: docs.map.rev }], question: "验收排队偏长，谁来分担界面验收？",
  options: ["增加一位常驻验收", "设计走查分担界面验收"], authorizationBoundary: "不改验收标准，不跳过独立验收", targetSessionLabel: "统筹",
  targetSessionRef: null, actorId: "leader-actor", createdAt: ago(60 * 5), updatedAt: ago(40), collaboration: null };
const eventBase = { projectId, discussionId, documentRevisionId: docs.discussion.rev, evidence: null, reason: null, choice: null, unresolved: null,
  relookCondition: null, supersedesDecisionEventId: null, decisionEventId: null, target: null, actorId: "leader-actor" };
export const discussionList = kind => ({ items: !kind || kind === "allocation" ? [discussion] : [], nextCursor: null });
export const discussionDetail = discussionKey => discussionKey === discussionId ? discussion : null;
export const discussionEvents = () => [
  { ...eventBase, id: id(1210), version: 1, kind: "prepared", createdAt: ago(60 * 5) },
  { ...eventBase, id: id(1211), version: 2, kind: "handoff", evidence: "统筹已读讨论稿", reason: "交给统筹决定", createdAt: ago(40) },
];
export const allocationRelations = () => ({ items: [], nextCursor: null, resetRequired: false, canonicalSessionKey: null,
  metadata: { generatedAt: ago(1), sourceObservedAt: ago(1), partial: false, limitations: [] } });

// ---------- collaboration receipts (协作回执) ----------
const deliveryRecord = (n, state, reason) => ({ projectId, eventId: id(1250 + n), consumerId: "feishu", operationId: id(1260 + n),
  effectKey: `task:${tasks[`t${n}`].id}`, taskId: tasks[`t${n}`].id, taskVersion: 2, state, fence: 1, leaseOwner: null, leaseUntilUtc: null,
  nextRetryAtUtc: null, lastReason: reason, updatedAtUtc: ago(10 * n) });
export const collaboration = () => ({ configured: true, verifiedAtUtc: ago(60 * 3), error: null,
  deliveries: { items: [deliveryRecord(1, "applied", "已写入飞书任务"), deliveryRecord(2, "unknown", "写入后没有收到回执"), deliveryRecord(3, "pending", null)], nextCursor: null },
  incoming: { items: [], nextCursor: null }, incomingPending: 0 });
