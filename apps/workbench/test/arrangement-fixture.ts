// The fixture of the 统筹安排 browser tests (arrangement-browser, team-arrangement-ci-browser): a built workbench served over a small fake API.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export const dist = resolve(import.meta.dirname, "../dist");
export const projectId = "32000001-0000-4000-8000-000000000001";
export const id = (n: number) => `32000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const stamp = new Date().toISOString();
export const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

const role = (title: string, templateKey: string | null = null) => ({
  id: `${title}-role`, title, state: "active", roleClass: templateKey ? "system" : "business", templateKey, responsibility: title,
});
// The directory derives currentTask from an assignment or a queue claim; the agent did not report it.
const directoryTask = (n: number, title: string, relation: string) => ({
  id: id(100 + n), title, state: "in_progress", revisionId: id(100 + n), owner: "r", relation,
  source: { kind: "task", id: id(100 + n), revision: id(100 + n), evidence: "project-record", href: "" },
});
const agent = (n: number, title: string, roles: ReturnType<typeof role>[], busy: boolean | null,
  currentTask: ReturnType<typeof directoryTask> | null = null) => ({
  key: `owned:${id(n)}`, target: { kind: "owned", sessionId: id(n) }, aliases: [], title, profile: null, identity: null,
  kind: "owned", roles, membership: "current", membershipReason: "verified", runtimeState: "ready", busy,
  currentTask, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "native" },
    open: { available: false, reason: null, ref: null }, interrupt: { available: false, reason: null },
    close: { available: false, reason: null } },
  source: { kind: "session", id: id(n), revision: null, evidence: "project-record", href: "" },
  metadata: { generatedAt: stamp, sourceObservedAt: null, partial: false, limitations: [] },
});
export const agents = [
  agent(1, "统筹", [role("统筹", "lead")], false),
  agent(2, "前端实现", [role("前端实现")], true),
  agent(3, "后端实现", [role("后端实现")], true),
  agent(4, "测试验收", [role("测试验收")], false, directoryTask(7, "回归用例", "accepted")),
  agent(5, "文档整理", [role("文档整理")], false),
];
const task = (n: number, title: string, fields: Record<string, unknown> & { to?: number } = {}) => {
  const { to, ...rest } = fields;
  return {
    kind: "task", taskId: id(100 + n), version: 1, currentRevisionId: id(100 + n), workChangeSequence: 1, title,
    taskKind: "implementation", taskState: "in_progress", phase: "ready", nextAction: "",
    responsible: { kind: "role", id: "role", label: "实现" },
    assignment: to === undefined ? null : { state: "accepted", targetKind: "owned", targetId: id(to), recipientActorId: null },
    latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null,
    dependencies: [], dependencyVersion: 0, review: null,
    dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp },
    actionKey: `task:${n}`, ...rest,
  };
};
export const tasks = [
  task(1, "新版任务页", { to: 2, phase: "running", plan: { plannedStartAt: null, dueAt: inDays(1), priority: 1 } }),
  task(2, "新版文档页", { to: 2, phase: "running" }),
  task(3, "事件流接口", { to: 3, phase: "running", dependencies: [
    { taskId: id(101), title: "新版任务页", state: "in_progress", currentRevisionId: id(101), acceptanceSatisfied: false }] }),
  task(4, "数据迁移脚本", { to: 3, phase: "awaiting_delivery" }),
  // nextAction is the server's text word for word (taskAction in packages/adapter-postgres/src/work-index.ts).
  task(5, "验收新版外壳", { phase: "awaiting_acceptance", nextAction: "由声明验收责任者核对当前交付与实际使用",
    responsible: { kind: "unknown", id: null, label: "下一责任未登记" } }),
  task(6, "整理旧文档", { phase: "unassigned", nextAction: "负责人选择真实 Role/Session 并按当前版本正式分派",
    plan: { plannedStartAt: null, dueAt: inDays(-1), priority: 2 } }),
  // Waiting for acceptance, not being done: it belongs under 已分派 only, whatever the directory's currentTask says.
  task(7, "回归用例", { to: 4, phase: "awaiting_acceptance", nextAction: "由声明验收责任者核对当前交付与实际使用",
    responsible: { kind: "consumer", id: "c", label: "验收者 c" } }),
];
export const internalWords = /Role|Session|Run|operation|assignment|queue/i;
const queues = [{ projectId, id: "q", version: 1, adoptedVersion: 1, maxRuns: 5, reason: "", actorId: "lead",
  entries: [{ projectId, queueId: "q", id: "e1", taskId: id(106), taskRevisionId: id(106), sourceInputJson: "{}", sessionId: id(4),
    roleId: "r", position: 1, dependsOn: [], consumerId: "c", useRequired: false, releaseRule: "accepted", state: "held",
    holdCode: "dependency", holdReason: null, claimId: null, version: 1 }] },
  // A reordered queue waiting for adoption: its entries are not queued work yet.
  { projectId, id: "q2", version: 2, adoptedVersion: null, maxRuns: 5, reason: "", actorId: "lead",
    entries: [{ projectId, queueId: "q2", id: "e2", taskId: id(102), taskRevisionId: id(102), sourceInputJson: "{}", sessionId: id(5),
      roleId: "r", position: 1, dependsOn: [], consumerId: "c", useRequired: false, releaseRule: "accepted", state: "queued",
      holdCode: null, holdReason: null, claimId: null, version: 1 }] }];

/** Serves the built workbench and a fixture API; while `fail.tasks` or `fail.queues` is set, that read answers 503. */
export async function serve(t: { after: (fn: () => unknown) => void }, fail = { tasks: false, queues: false }) {
  const unavailable = (res: import("node:http").ServerResponse, message: string) => {
    res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ message }));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = {
        principal: { actorId: "reader", projectIds: [projectId], permissions: [] }, capabilities: {},
      };
      else if (url.pathname === "/api/projects") value = [{ id: projectId, title: "安排回归项目", createdAt: stamp }];
      else if (url.pathname === root) value = { id: projectId, title: "安排回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        const search = url.searchParams.get("search") ?? "";
        const items = membership === "current" ? agents.filter(item => item.title.includes(search)) : [];
        value = { items, nextCursor: null, observationCursor: "0", metadata: agents[0]!.metadata,
          totals: { current: agents.length, historical: 0, unclassified: 0 },
          attention: { unansweredQuestions: 1, pendingMessages: 3, pendingAcceptance: 2, unclassifiedSessions: 0 } };
      }
      else if (url.pathname === `${root}/work-management/index`) {
        if (fail.tasks) return unavailable(res, "任务索引暂不可用");
        value = { items: tasks, nextCursor: null, total: tasks.length, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
      }
      else if (url.pathname === `${root}/resident-queues`) {
        if (fail.queues) return unavailable(res, "队列服务暂不可用");
        value = queues;
      }
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/runtime/sessions` || url.pathname === `${root}/runtime/runs`) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: true, projectId, grants: [], faults: [], error: null };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type":
        ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ??
        "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, fail };
}

