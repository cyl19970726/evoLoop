// Agents (owned sessions) of the screenshot fixture: the directory, one agent's snapshot and conversation, runtime facts.
import { actorId, agentKey, agents, ago, id, metadata, projectId, roles } from "./common.mjs";
import { revisionIdOf, runIdOf, tasks } from "./work.mjs";

const capability = { available: true, reason: null };
const unavailable = { available: false, reason: "当前不可用" };
const observedRole = key => ({ ...roles[key], state: "active" });

const currentTaskOf = {
  dev: tasks.t2, verify: tasks.t6, design: null, docs: tasks.t8, lead: null,
};
export function observedTask(t, relation = "accepted") {
  return { id: t.id, title: t.title, state: t.state, revisionId: revisionIdOf(t), owner: roles[t.owner].title, relation,
    source: { kind: "task", id: t.id, revision: revisionIdOf(t), evidence: "project-record", href: "" } };
}

export function observedSession(name) {
  const a = agents[name];
  const task = currentTaskOf[name];
  return {
    key: agentKey(name), target: { kind: "owned", sessionId: a.sessionId }, aliases: [], title: a.title,
    profile: { projectId, target: { kind: "owned", sessionId: a.sessionId }, version: 1, displayName: a.title, purpose: roles[a.role].responsibility,
      membership: "current", tenure: name === "lead" || name === "verify" ? "resident" : "temporary", actorId, reason: "建立智能体", updatedAt: ago(60 * 24 * 5) },
    identity: { projectId, target: { kind: "owned", sessionId: a.sessionId }, version: 1, color: a.color, mark: a.mark,
      actorId, reason: "建立时选定", updatedAt: ago(60 * 24 * 5) },
    kind: "owned", roles: [observedRole(a.role)], membership: "current", membershipReason: "verified", runtimeState: "ready",
    busy: a.busy, currentTask: task ? observedTask(task) : null,
    latestBusinessRun: name === "dev" ? { id: runIdOf(tasks.t2), taskId: tasks.t2.id, state: "running", updatedAt: ago(3),
      source: { kind: "run", id: runIdOf(tasks.t2), revision: null, evidence: "project-record", href: "" } } : null,
    lastProgressAt: ago(name === "dev" ? 3 : name === "verify" ? 12 : 60 * 5),
    capabilities: { observe: capability, send: { ...capability, mode: "owned-conversation" }, open: { ...unavailable, ref: null },
      interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: a.sessionId, revision: null, evidence: "project-record", href: "" }, metadata,
  };
}
const order = ["lead", "dev", "verify", "design", "docs"];
export const directory = (search = "") => ({
  items: order.map(observedSession).filter(item => item.title.includes(search)), nextCursor: null, observationCursor: "12", metadata,
  totals: { current: order.length, historical: 0, unclassified: 0 },
  attention: { unansweredQuestions: 1, pendingMessages: 2, pendingAcceptance: 1, unclassifiedSessions: 0 },
});
export const sessionNameOf = key => order.find(name => agentKey(name) === key) ?? null;

const resource = (value, unit, unavailableReason = null) => ({ value, unit, source: value === null ? null : "runtime", scope: "session",
  observedAt: value === null ? null : ago(3), interval: null, unavailableReason });
export function snapshot(name) {
  const session = observedSession(name);
  const t = currentTaskOf[name];
  return {
    session, observationCursor: "12", currentWork: session.currentTask,
    assignments: t ? [{ assignment: { projectId, taskId: t.id, version: 1, taskRevisionId: revisionIdOf(t),
      target: { kind: "owned", sessionId: agents[name].sessionId }, recipientActorId: `agent-${name}`, state: "accepted",
      ack: { method: "direct", actorId: `agent-${name}`, observerActorId: `agent-${name}`, evidence: "读过固定输入后接手", sourceRef: null, at: ago(60 * 26) },
      actorId: "leader-actor", reason: "按职责安排", updatedAt: ago(60 * 26) }, task: observedTask(t), stale: false }] : [],
    roleTasks: [], queue: name === "dev" ? [{ queueId: id(900), entryId: id(901), taskId: tasks.t4.id, taskTitle: tasks.t4.title, position: 1,
      state: "held", holdCode: "dependency", holdReason: null, dependsOn: [tasks.t2.id],
      source: { kind: "queue", id: id(900), revision: null, evidence: "project-record", href: "" } }] : [],
    results: name === "dev" ? [{ deliveryId: id(501), taskId: tasks.t1.id, taskTitle: tasks.t1.title, technicalResult: "passed",
      artifactRef: "git:evoloop/workbench", artifactRevision: "4f1c2ab", contentHash: "c".repeat(64), submittedAt: ago(45), latestUse: null,
      source: { kind: "delivery", id: id(501), revision: null, evidence: "project-record", href: "" } }] : [],
    questions: [], activity: [],
    resources: { configuredModel: resource("gpt-6-sol", ""), actualModel: resource("gpt-6-sol", ""), inputTokens: resource(182400, "tokens"),
      outputTokens: resource(23150, "tokens"), cost: resource(null, "", "未记录"), processMemory: resource(null, "", "未记录") },
    metadata,
    nativeObservation: name === "dev" ? { projectId, sessionId: agents.dev.sessionId, threadId: "thread-dev", version: 4, observedAt: ago(1),
      lastEventAt: ago(1), freshness: "live", staleReason: null, status: "active",
      currentTurn: { id: "turn-3", status: "inProgress", source: { kind: "run", runId: runIdOf(tasks.t2) } },
      items: [{ id: "tool-a", kind: "commandExecution", name: "运行单元测试", status: "completed", summary: "48 项通过", truncated: false },
        { id: "tool-b", kind: "commandExecution", name: "构建工作台", status: "inProgress", summary: "正在构建", truncated: false }],
      plan: null, diff: null, usage: null } : null,
  };
}

const at = minutes => ago(minutes);
const message = (key, body, minutes, extra = {}) => ({ id: `message:${key}`, kind: "message", role: "input", phase: "unknown", body, clientId: key,
  state: "completed", turnId: null, nativeItemId: null, nativeKind: null, author: { kind: "actor", id: actorId, label: actorId },
  origin: { kind: "message", id: key, taskId: null, taskRevisionId: null, initiatingActorId: actorId },
  occurredAt: at(minutes), observedAt: at(minutes), freshness: "persisted", truncated: false, ...extra });
const assistant = (key, body, minutes, turnId) => ({ id: key, kind: "message", role: "assistant", phase: "final_answer", body, clientId: null,
  state: "completed", turnId, nativeItemId: key, nativeKind: "agentMessage", author: { kind: "session", id: agents.dev.sessionId, label: agents.dev.title },
  origin: null, occurredAt: at(minutes), observedAt: at(minutes), freshness: "persisted", truncated: false });
const tool = (key, name, summary, minutes, turnId, state = "completed") => ({ id: key, kind: "tool", name, summary, state, turnId, nativeItemId: key,
  nativeKind: "commandExecution", author: { kind: "native", id: null, label: "原生工具" }, origin: null, occurredAt: at(minutes),
  observedAt: at(minutes), freshness: "persisted", truncated: false, durationMs: 4200, exitCode: state === "failed" ? 1 : 0, detailAvailable: false, detailReason: null });

export function timeline(name) {
  const key = agentKey(name);
  const entries = name !== "dev" ? [] : [
    message("m1", "任务列表的筛选要写进地址，返回时保留。先做这一项。", 95,
      { origin: { kind: "message", id: "m1", taskId: tasks.t2.id, taskRevisionId: revisionIdOf(tasks.t2), initiatingActorId: actorId } }),
    tool("tool-1", "读取需求总图", "读到第 1 版，共 4 节", 93, "turn-1"),
    tool("tool-2", "运行单元测试", "48 项通过", 80, "turn-1"),
    assistant("answer-1", "## 已接手\n\n- 筛选和排序写进地址：`state`、`sort`。\n- 返回任务列表时保留筛选。\n- 下一步做表格视图的列设置。", 78, "turn-1"),
    message("m2", "表格视图在 1024 宽度下右栏要收成抽屉，别自己弹出来。", 20),
    tool("tool-3", "截图 1024 宽度", "右栏收起，按钮在页首右侧", 12, "turn-2"),
    assistant("answer-2", "已核对：1024 下右栏默认收起，只有点“展开右栏”才会打开抽屉。", 10, "turn-2"),
  ];
  return { sessionKey: key, sessionTitle: agents[name].title, entries, pending: [], turns: [], nextCursor: null, messagesCursor: null,
    observedAt: ago(1), partial: false, limitations: [], unsupportedKinds: [],
    live: { cursor: "3", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null },
    capabilities: { history: true, live: true, originalToolDetail: false, reason: null } };
}

export const executionProfile = name => {
  const revision = { projectId, sessionId: agents[name].sessionId, revisionId: id(950 + order.indexOf(name)), version: 1, previousRevisionId: null,
    model: "gpt-6-sol", reasoningEffort: "high", sandbox: "workspace-write", approvalPolicy: "never", cwd: "/srv/evoloop/workbench",
    authorizationScope: "project", provenance: "reserved", operationId: id(960), actorId, reason: "建立智能体", evidenceRef: null, createdAt: ago(60 * 24 * 5) };
  return { revision, activationState: "active", activeRevisionId: revision.revisionId, activeModel: "gpt-6-sol", activeReasoningEffort: "high",
    activationOperationId: null, attemptedAt: null, activationEvidence: "运行时读回" };
};
export const runtimeSessions = () => order.map(name => ({ projectId, id: agents[name].sessionId, version: 1, state: "ready",
  roleId: roles[agents[name].role].id, sandbox: "workspace-write", approvalPolicy: "never", model: "gpt-6-sol",
  cwd: "/srv/evoloop/workbench", authorizationScope: "前端任务", nativeThreadId: `thread-${name}`, nativeSessionId: `native-${name}`,
  operationId: id(970 + order.indexOf(name)), actorId, createdAt: ago(60 * 24 * 5), updatedAt: ago(30),
  executionProfile: executionProfile(name) }));
export const runtimeModels = { status: "available", models: ["gpt-6-sol", "gpt-6-astra"], options: [
  { model: "gpt-6-sol", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" },
  { model: "gpt-6-astra", supportedReasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" }], error: null, observedAtUtc: ago(5) };
export const recovery = name => ({ sessionId: agents[name].sessionId, executionProfile: executionProfile(name), gate: null, decisions: [], queues: [],
  nextAction: "normal_work", partial: false, observedAtUtc: ago(1) });

/** Who could take an acceptance now (表格视图 “阶段与验收容量”). */
export const acceptanceCapacity = () => ["verify", "design"].map(name => ({ sessionId: agents[name].sessionId, roleId: roles[agents[name].role].id,
  sessionActorId: `agent-${name}`, cwd: "/srv/evoloop/workbench", state: "ready", nativeThreadId: `thread-${name}`,
  tenure: name === "verify" ? "resident" : "temporary", isLeader: false, activeRuns: name === "verify" ? 1 : 0, pendingMessages: 0,
  queueEntries: 0, openAssignments: name === "verify" ? 1 : 0, openAcceptance: name === "verify" ? 1 : 0, persistedWorkIdle: name !== "verify",
  missingCapabilities: name === "design" ? ["MESSAGE_GRANT_MISSING"] : [], readyForAcceptance: false }));

export const residentQueues = () => [{ projectId, id: id(900), version: 2, adoptedVersion: 2, maxRuns: 5, reason: "先完成列表，再接日程", actorId: "leader-actor",
  entries: [
    { projectId, queueId: id(900), id: id(901), taskId: tasks.t4.id, taskRevisionId: revisionIdOf(tasks.t4), sourceInputJson: "{}",
      sessionId: agents.dev.sessionId, roleId: roles.dev.id, position: 1, dependsOn: [tasks.t2.id], consumerId: "acceptance-owner",
      useRequired: true, releaseRule: "accepted", state: "held", holdCode: "dependency", holdReason: null, claimId: null, version: 1 },
    { projectId, queueId: id(900), id: id(902), taskId: tasks.t2.id, taskRevisionId: revisionIdOf(tasks.t2), sourceInputJson: "{}",
      sessionId: agents.dev.sessionId, roleId: roles.dev.id, position: 0, dependsOn: [], consumerId: "acceptance-owner",
      useRequired: true, releaseRule: "accepted", state: "claimed", holdCode: null, holdReason: null, claimId: id(903), version: 2 },
  ] }];
