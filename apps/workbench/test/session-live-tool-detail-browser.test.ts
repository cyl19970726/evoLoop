// Real timeline service/routes with a controlled observable owner; no native model Turn is started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError, type UnitOfWork } from "@evoloop/contracts/ports";
import type { RuntimeBinding, RuntimePort } from "@evoloop/contracts/runtime";
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, SessionTimelinePage, WorkspaceEntry,
  WorkspaceLiveRead, WorkspaceRuntimeUpdate, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import { SessionTimelineService, type WorkspaceHistoryOwner } from "../../coordinator/src/session-timeline/index.ts";
import { registerSessionTimelineRoutes } from "../../coordinator/src/session-timeline/routes.ts";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist"));
const projectId = "95000001-0000-4000-8000-000000000001";
const sessionId = "95000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const threadId = "controlled-observable-thread";
const turnId = "controlled-formal-turn";
const itemId = "exec-controlled-item";
const entryId = `native:${threadId}:${turnId}:${itemId}`;
const stamp = "2026-11-02T00:00:00.000Z";
const originalInput = "CONTROLLED_TOOL_INPUT_FROM_EXISTING_ITEM";
const originalOutput = "CONTROLLED_TOOL_OUTPUT_FROM_EXISTING_ITEM";
const toolName = "commandExecution";
const reviewer: Principal = { actorId: "acceptance-owner", projectIds: [projectId], permissions: ["read", "review"] };
const reader: Principal = { actorId: "ordinary-reader", projectIds: [projectId], permissions: ["read"] };
const principals: Record<string, Principal> = { "reviewer-token": reviewer, "reader-token": reader };
type Tool = Extract<WorkspaceEntry, { kind: "tool" }>;

const runtimeSession: RuntimeSessionRecord = { projectId, id: sessionId, roleId: "controlled-role", cwd: "/controlled-workspace",
  authorizationScope: "controlled-owner-scope", model: null, sandbox: "read-only", approvalPolicy: "on-request", state: "ready", version: 1,
  nativeThreadId: threadId, nativeSessionId: "controlled-native-session", operationId: "95000003-0000-4000-8000-000000000003",
  actorId: reviewer.actorId, createdAt: stamp, updatedAt: stamp };

/** An observable owner, deliberately distinct from the non-live ReadOnlyWorkspaceOwner. */
class ObservableOwner implements WorkspaceHistoryOwner {
  private readonly listeners = new Set<(event: WorkspaceRuntimeUpdate) => void>();
  readonly emitted: WorkspaceRuntimeUpdate[] = [];
  readonly historyReads: { actorId: string; options: NativeWorkspaceReadOptions }[] = [];
  private tool: Tool = { id: entryId, kind: "tool", turnId, nativeItemId: itemId, nativeKind: "commandExecution",
    author: { kind: "session", id: sessionId, label: "受控 Session" }, origin: null, occurredAt: null, observedAt: stamp,
    freshness: "persisted", truncated: false, name: toolName, summary: "受控工具已完成", state: "completed", durationMs: 10,
    exitCode: 0, detailAvailable: true, detailReason: null,
    detail: { input: originalInput, output: originalOutput, error: null, resources: [] } };
  private readonly turn: WorkspaceTurn = { id: turnId, state: "completed", startedAt: stamp, completedAt: stamp, origin: null };
  private readonly binding: RuntimeBinding = { projectId, sessionId, roleId: runtimeSession.roleId,
    cwd: runtimeSession.cwd, authorizationScope: runtimeSession.authorizationScope,
    nativeThreadId: threadId, nativeSessionId: runtimeSession.nativeSessionId!, owner: "evoloop-codex-app-server" };

  async workspaceBinding(principal: Principal, requestedProject: string, requestedSession: string): Promise<RuntimeBinding> {
    if (requestedProject !== projectId || requestedSession !== sessionId || !principal.projectIds.includes(projectId)
      || !principal.permissions.includes("read")) throw new DomainError("FORBIDDEN", "Exact controlled owner scope required");
    return this.binding;
  }
  async workspaceHistory(principal: Principal, requestedProject: string, requestedSession: string,
    options: NativeWorkspaceReadOptions): Promise<NativeWorkspacePage> {
    const binding = await this.workspaceBinding(principal, requestedProject, requestedSession);
    this.historyReads.push({ actorId: principal.actorId, options: { ...options } });
    return this.nativeAdapter().readWorkspaceHistory!(binding, options);
  }
  nativeAdapter(): Pick<RuntimePort, "readWorkspaceHistory" | "onWorkspaceUpdate"> {
    return {
      readWorkspaceHistory: async (binding, options = {}) => {
        assert.equal(binding.nativeThreadId, threadId);
        const matches = (!options.turnId || options.turnId === turnId) && (!options.itemId || options.itemId === itemId);
        return { entries: matches ? [structuredClone(this.tool)] : [], turns: matches ? [this.turn] : [], nextCursor: null,
          observedAt: stamp, historyMode: "paginated", method: "items", partial: false, itemEnumerationComplete: true,
          limitations: [], unsupportedKinds: [] };
      },
      onWorkspaceUpdate: listener => this.onWorkspaceUpdate(listener),
    };
  }
  status() { return { available: true }; }
  onWorkspaceUpdate(listener: (event: WorkspaceRuntimeUpdate) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onWorkspaceDisconnect(_listener: (reason: string) => void) { return () => {}; }
  private emit(event: WorkspaceRuntimeUpdate) {
    this.emitted.push(event);
    for (const listener of this.listeners) listener(event);
  }
  observeCompletedTool(summary = this.tool.summary) {
    this.tool = { ...this.tool, summary };
    const scope = { projectId, sessionId, threadId, turnId, observedAt: stamp };
    if (!this.emitted.length) this.emit({ ...scope, kind: "turn", turn: { ...this.turn, state: "running", completedAt: null,
      order: { kind: "turn-boundary", key: `boundary:${threadId}:${turnId}:start`, position: null, generation: "controlled-generation" } } });
    this.emit({ ...scope, kind: "entry", entry: { ...structuredClone(this.tool), freshness: "live" } });
    this.emit({ ...scope, kind: "turn", turn: { ...this.turn,
      order: { kind: "turn-boundary", key: `boundary:${threadId}:${turnId}:complete`, position: null, generation: "controlled-generation" } } });
  }
}

function toolIn(entries: WorkspaceEntry[]): Tool {
  const tool = entries.find(entry => entry.kind === "tool" && entry.turnId === turnId && entry.nativeItemId === itemId);
  assert.ok(tool?.kind === "tool", "the real service retains the exact controlled Tool identity");
  return tool;
}
function assertNoOriginal(value: unknown) {
  const json = JSON.stringify(value);
  assert.equal(json.includes(originalInput), false, "ordinary feeds never inline original input");
  assert.equal(json.includes(originalOutput), false, "ordinary feeds never inline original output");
}

test("observable-owner tool detail remains readable after real history/live merges and stays denied to ordinary readers", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const owner = new ObservableOwner();
  const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
  const unavailable = { available: false, reason: "controlled fixture unavailable" };
  const observedSession = { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "Live 工具详情回归会话", profile: null,
    kind: "owned", roles: [], membership: "current", membershipReason: "controlled owner", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
  const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
    .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
  const snapshot = { session: observedSession, observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [],
    results: [], questions: [], activity: [], resources, metadata };
  const observation = { snapshot: async (principal: Principal, requestedProject: string, requestedKey: string) => {
    await owner.workspaceBinding(principal, requestedProject, sessionId);
    if (requestedKey !== sessionKey) throw new DomainError("FORBIDDEN", "Wrong controlled Session");
    return snapshot;
  } } as unknown as SessionObservationService;
  const uow = { read: async (_project: string, read: (repository: unknown) => Promise<unknown>) => read({
    getRuntimeSession: async () => runtimeSession,
    nativeInputs: { findSources: async () => new Map() },
    sessionMessages: { listSessionMessages: async () => ({ items: [], nextCursor: null }),
      listSessionMessageProcessing: async () => [], getSessionMessages: async () => [] },
  }) } as unknown as UnitOfWork;
  const service = new SessionTimelineService({ uow, observation, runner: owner });
  owner.observeCompletedTool();
  assert.ok(owner.emitted.some(event => event.kind === "entry" && event.entry.kind === "tool" && event.entry.detailAvailable),
    "the observed native event exposes provider availability before the service buffer projects it");
  const app = Fastify();
  const wire: { url: string; actor: string; status: number; body: unknown }[] = [];
  app.decorateRequest("principal", null); app.decorateRequest("workerIdentity", null);
  app.addHook("onRequest", async request => {
    request.principal = principals[request.headers.authorization?.replace(/^Bearer /, "") ?? ""] ?? null;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.includes("/timeline") && typeof payload === "string") {
      wire.push({ url: request.url, actor: request.principal?.actorId ?? "", status: reply.statusCode, body: JSON.parse(payload) });
    }
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError && error.code === "FORBIDDEN" ? 403 : 500)
    .send({ code: error instanceof DomainError ? error.code : "FIXTURE_ERROR", message: error.message }));
  registerSessionTimelineRoutes(app, service);
  app.get("/api/session", request => ({ principal: request.principal, capabilities: {} }));
  app.get(`/api/projects/${projectId}`, () => ({ id: projectId, title: "真实 service live 工具回归", createdAt: stamp }));
  app.get(`/api/projects/${projectId}/session-work`, request => ({
    items: new URL(request.url, "http://fixture").searchParams.get("membership") === "current" ? [observedSession] : [],
    nextCursor: null, observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 },
    attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 },
  }));
  app.get(`/api/projects/${projectId}/session-work/changes`, () => ({ items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata }));
  app.get(`/api/projects/${projectId}/session-work/:key`, request => observation.snapshot(request.principal!, projectId, (request.params as { key: string }).key));
  app.get("/api/*", (request, reply) => {
    if (request.url.includes("/recovery")) return reply.code(404).send({ message: "No controlled recovery record" });
    if (request.url.endsWith("/runtime")) return { available: true, error: null, allowedCwds: [], grants: [] };
    if (request.url.endsWith("/runtime/sessions") || request.url.endsWith("/runtime/runs") || request.url.includes("/references/") || request.url.endsWith("/impacts")) return [];
    if (request.url.endsWith("/orchestration/work-status")) return { items: [] };
    return { items: [], nextCursor: null, metadata, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
  });
  const staticFile = async (pathname: string, reply: import("fastify").FastifyReply) => {
    const file = /^\/(?:$|p\/|ui$)/.test(pathname) ? "index.html" : pathname;
    try { return reply.type(({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream").send(await readFile(join(dist, file))); }
    catch { return reply.code(404).send(); }
  };
  app.get("/", (_request, reply) => staticFile("/", reply));
  app.get("/*", (request, reply) => staticFile(new URL(request.url, "http://fixture").pathname, reply));
  let closeBrowser = async () => {};
  t.after(async () => { service.close(); await closeBrowser(); await app.close(); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const timelinePath = `/api/projects/${projectId}/session-work/${encodeURIComponent(sessionKey)}/timeline`;
  const itemPath = `${timelinePath}/items/${itemId}?${new URLSearchParams({ turnId })}`;
  const http = (path: string, token: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const initial = await (await http(`${timelinePath}?limit=25`, "reviewer-token")).json() as SessionTimelinePage;
  assert.equal(initial.capabilities.originalToolDetail, true);
  assert.equal(toolIn(initial.entries).detailAvailable, true);
  assert.equal(initial.live.freshness, "live", "only a scoped event from the observable owner qualifies as live");
  assertNoOriginal(initial);
  const existingItemResponse = await http(itemPath, "reviewer-token");
  const existingItem = await existingItemResponse.json() as Tool;
  assert.equal(existingItemResponse.status, 200);
  assert.equal(existingItem.detailAvailable, true);
  assert.equal(existingItem.detail?.input, originalInput);
  const readerFeed = await (await http(`${timelinePath}?limit=25`, "reader-token")).json() as SessionTimelinePage;
  assert.equal(readerFeed.capabilities.originalToolDetail, false);
  assert.equal(toolIn(readerFeed.entries).detailAvailable, false);
  assert.equal(toolIn(readerFeed.live.entries).detailAvailable, false);
  assertNoOriginal(readerFeed);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  closeBrowser = () => browser.close();
  const pageErrors: string[] = [];
  const openSession = async (token: string) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey, tab: "activity" })}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: observedSession.title }).waitFor();
    const timeline = page.getByRole("log", { name: "Session 消息与工具时间线" });
    await timeline.locator(".workspace-tools-toggle").click();
    return { page, timeline };
  };
  const ordinary = await openSession("reader-token");
  await ordinary.timeline.getByRole("button", { name: `查看工具详情：${toolName}` }).click();
  const ordinaryInspector = ordinary.timeline.locator(".workspace-tool-inline");
  await ordinaryInspector.getByText("当前身份可阅读活动摘要；原始输入与输出未获授权。", { exact: true }).waitFor();
  assert.equal(await ordinaryInspector.getByRole("button", { name: "读取原始输入与输出" }).count(), 0);
  assertNoOriginal(await ordinary.page.locator("body").innerText());
  const deniedItem = await http(itemPath, "reader-token");
  assert.equal(deniedItem.status, 403, "ordinary project read cannot fetch this existing Tool's original content");
  assertNoOriginal(await deniedItem.json());
  await ordinary.timeline.getByRole("button", { name: `收起工具详情：${toolName}` }).click();

  const authorized = await openSession("reviewer-token");
  await authorized.timeline.getByRole("button", { name: `查看工具详情：${toolName}` }).click();
  const inspector = authorized.timeline.locator(".workspace-tool-inline");
  const readOriginal = inspector.getByRole("button", { name: "读取原始输入与输出", exact: true });
  await readOriginal.waitFor({ timeout: 4000 }).catch(async cause => {
    const live = toolIn(initial.live.entries);
    assert.fail(`${String(cause)}; real HTTP tuple=${JSON.stringify({ pageOriginal: initial.capabilities.originalToolDetail,
      persistedAvailable: toolIn(initial.entries).detailAvailable, liveAvailable: live.detailAvailable, liveReason: live.detailReason,
      liveFreshness: initial.live.freshness, existingItemStatus: existingItemResponse.status, existingItemAvailable: existingItem.detailAvailable })}; inspector=${await inspector.innerText()}`);
  });
  await readOriginal.click();
  await inspector.getByText(originalInput, { exact: true }).waitFor();
  await inspector.getByText(originalOutput, { exact: true }).waitFor();
  assert.equal(toolIn(initial.live.entries).detailAvailable, true, "the live buffer must preserve provider capability before reviewer projection");
  await authorized.timeline.getByRole("button", { name: `收起工具详情：${toolName}` }).click();

  const updatedSummary = "后续 live 事件仍可读取同一工具详情";
  owner.observeCompletedTool(updatedSummary);
  await authorized.timeline.locator(".workspace-tool").getByText(updatedSummary, { exact: true }).waitFor();
  await ordinary.timeline.locator(".workspace-tool").getByText(updatedSummary, { exact: true }).waitFor();
  assert.equal(await authorized.timeline.locator(".workspace-tool").count(), 1, "history and live updates merge the same Tool without duplicating it");
  await authorized.timeline.getByRole("button", { name: `查看工具详情：${toolName}` }).click();
  await readOriginal.waitFor();
  await readOriginal.click();
  await inspector.getByText(originalOutput, { exact: true }).waitFor();
  assertNoOriginal(await ordinary.page.locator("body").innerText());
  const feedReads = wire.filter(read => !read.url.includes("/items/"));
  for (const read of feedReads) assertNoOriginal(read.body);
  for (const principal of [reviewer, reader]) {
    const deltas = feedReads.filter(read => read.actor === principal.actorId && read.url.includes("/updates")
      && (read.body as WorkspaceLiveRead).entries?.some(entry => entry.id === entryId && entry.kind === "tool" && entry.summary === updatedSummary));
    assert.ok(deltas.length > 0, `the real update route delivered the new scoped Tool to ${principal.actorId}`);
    for (const delta of deltas) assert.equal(toolIn((delta.body as WorkspaceLiveRead).entries).detailAvailable, principal === reviewer);
  }
  assert.ok(owner.historyReads.filter(read => read.actorId === reviewer.actorId && read.options.itemId === itemId && read.options.turnId === turnId && read.options.detail).length >= 3,
    "both UI detail reads use the exact existing Item and Turn after history/live merging");
  assert.deepEqual(pageErrors, []);
});
