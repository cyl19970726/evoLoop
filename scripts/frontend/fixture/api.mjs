// The fixture API: each read the screenshot pages make, answered from the synthetic project. Returns
// { status, value }, or undefined for a read the fixture does not know (the server answers an empty page and reports it).
import { actorId, ago, otherProject, page, project, projectId, root } from "./common.mjs";
import * as work from "./work.mjs";
import * as agents from "./agents.mjs";
import * as team from "./team.mjs";
import * as spaces from "./spaces.mjs";
import * as configuration from "./configuration.mjs";

const ok = value => ({ status: 200, value });
const missing = message => ({ status: 404, value: { message } });

/** Exact paths under the project. */
function projectRoutes(params) {
  const includeClosed = params.get("includeClosed") === "true";
  return {
    "": project,
    // The one pending basis change of the featured task (its detail lists the same impact).
    "/impacts": work.taskDetail(work.tasks.t1).impacts,
    "/acceptance-relay/mine": { items: [] },
    "/tasks": work.taskListPage(),
    "/work-management/index": params.get("view") === "documents" ? work.documentWorkIndex() : work.workIndex(includeClosed),
    "/documents": page(work.documentList().filter(d => !params.get("kind") || d.kind === params.get("kind"))),
    "/goals": page([work.goalRecord("g1"), work.goalRecord("g2")]),
    "/stages": ["s1", "s2", "s3"].map(work.stageRecord),
    "/session-work": agents.directory(params.get("search") ?? ""),
    "/session-work/changes": { items: [], nextCursor: "12", hasMore: false, resetRequired: false, metadata: agents.directory().metadata },
    "/resident-queues": agents.residentQueues(),
    "/runtime/sessions": agents.runtimeSessions(),
    "/runtime/models": agents.runtimeModels,
    "/runtime": team.runtime(),
    "/runtime/runs": team.runtimeRuns(),
    "/orchestration/status": team.orchestrationStatus(),
    "/orchestration/work-status": { items: (params.get("taskIds") ?? "").split(",").filter(Boolean).map(work.workStatus) },
    "/roles": page(team.roleList()),
    "/role-templates": team.roleTemplates(),
    "/domains": [],
    "/task-attention/items": page([]),
    "/work-management/notices": page([]),
    "/acceptance-relay/overview": { work: null, capacity: agents.acceptanceCapacity(), observedAt: ago(1) },
    "/knowledge/capabilities": spaces.knowledge.capabilities,
    "/knowledge/pages": spaces.knowledge.pages(),
    "/knowledge/candidates": spaces.knowledge.candidates(),
    "/knowledge/sources/documents": spaces.knowledge.sources(),
    "/schedules": spaces.schedules.list(),
    "/scheduling/status": spaces.schedules.status(),
    "/evaluations": spaces.evaluations.list(),
    "/message-connectors/routes": spaces.connectors.routes(),
    "/discussions": team.discussionList(params.get("kind")),
    "/allocation-relations": team.allocationRelations(),
    "/collaboration": team.collaboration(),
    "/orchestration/loops": page([]),
    "/repositories": configuration.repositories(),
    "/capabilities": configuration.capabilities(),
    "/members": configuration.members(),
  };
}

export function answer(path, params) {
  if (path === "/api/session") return ok({ principal: { actorId, projectIds: [projectId, otherProject.id], permissions: ["read", "write", "review"],
    identityKind: "human" }, capabilities: {} });
  if (path === "/api/projects") return ok([project, otherProject]);
  if (path === `/api/projects/${otherProject.id}`) return ok(otherProject);
  if (!path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  const exact = projectRoutes(params);
  if (Object.hasOwn(exact, rest)) return ok(exact[rest]);

  let match;
  if ((match = /^\/tasks\/([^/]+)(?:\/(.+))?$/.exec(rest))) {
    const t = work.findTask(match[1]);
    if (!t) return missing("没有这项任务");
    const sub = match[2];
    if (!sub) return ok(work.taskDetail(t));
    if (sub === "assignment") return ok(work.assignmentOf(t));
    if (sub === "revisions") return ok(work.taskRevisions(t));
    if (sub === "timing") return ok(null);
    if (sub === "acceptance-relay") return ok({ items: work.acceptanceRelays(t) });
    if (sub === "attention") return ok({ followUp: null, followUpHistory: [], items: [], itemsNextCursor: null });
    return undefined;
  }
  if ((match = /^\/runtime\/runs\/([^/]+)(\/events)?$/.exec(rest))) {
    const run = team.runtimeRuns().find(item => item.id === match[1]);
    if (!run) return missing("没有这次运行");
    return ok(match[2] ? [] : run);
  }
  if ((match = /^\/knowledge\/pages\/([^/]+)(\/history|\/graph)?$/.exec(rest))) {
    const value = spaces.knowledge.page(match[1]);
    if (!value) return missing("没有这个知识页");
    return ok(match[2] === "/history" ? spaces.knowledge.history(match[1]) : match[2] === "/graph" ? spaces.knowledge.graph(match[1]) : value);
  }
  if ((match = /^\/schedules\/([^/]+)\/(revisions|occurrences)$/.exec(rest)))
    return ok(match[2] === "revisions" ? spaces.schedules.revisions(match[1]) : spaces.schedules.occurrences(match[1]));
  if ((match = /^\/evaluations\/([^/]+)$/.exec(rest))) {
    const value = spaces.evaluations.detail(match[1]);
    return value ? ok(value) : missing("没有这项评价");
  }
  if ((match = /^\/message-connectors\/routes\/([^/]+)\/deliveries$/.exec(rest))) return ok(spaces.connectors.deliveries(match[1]));
  if ((match = /^\/discussions\/([^/]+)(\/events)?$/.exec(rest))) {
    const value = team.discussionDetail(match[1]);
    if (!value) return missing("没有这项讨论");
    return ok(match[2] ? team.discussionEvents() : value);
  }
  if ((match = /^\/references\/tasks\/([^/]+)$/.exec(rest))) return ok([]);
  if ((match = /^\/orchestration\/tasks\/([^/]+)\/context$/.exec(rest))) return ok(page([]));
  if ((match = /^\/work-management\/tasks\/([^/]+)$/.exec(rest))) {
    const t = work.findTask(match[1]);
    return t ? ok(work.projection(t)) : missing("未登记");
  }
  if ((match = /^\/documents\/([^/]+)\/revisions$/.exec(rest))) {
    const d = work.findDocument(match[1]);
    return d ? ok(work.revisionPage(d)) : missing("没有这份文档");
  }
  if ((match = /^\/documents\/([^/]+)(?:\/revisions\/([^/]+)(\/original)?)?(\/tasks)?$/.exec(rest))) {
    const d = work.findDocument(match[1]);
    if (!d) return missing("没有这份文档");
    const [, , revisionId, original, tasks] = match;
    if (tasks) return ok(page(work.documentReferences(d)));
    if (!revisionId) return ok({ document: work.documentRecord(d), current: work.revisionRecord(d), adopted: d.status === "published" ? work.revisionRecord(d) : null });
    if (revisionId !== d.rev && revisionId !== d.oldRev) return missing("没有这个版本");
    const revision = work.revisionRecord(d, revisionId);
    return ok(original ? { status: "available", revision, body: d.html ?? revision.body, assets: [] } : revision);
  }
  if ((match = /^\/session-work\/([^/]+)(\/.*)?$/.exec(rest))) {
    const name = agents.sessionNameOf(match[1]);
    if (!name) return missing("没有这个智能体");
    const sub = match[2];
    if (!sub) return ok(agents.snapshot(name));
    if (sub === "/timeline") return ok(agents.timeline(name));
    if (sub === "/timeline/updates") return ok({ cursor: "3", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [] });
    if (sub === "/messages") return ok({ items: [], nextCursor: null, metadata: agents.directory().metadata });
    if (sub === "/profile") return ok(agents.observedSession(name).profile);
    return undefined;
  }
  if ((match = /^\/sessions\/([^/]+)\/direct-input-capability$/.exec(rest))) {
    const name = agents.sessionNameOf(`owned:${match[1]}`);
    return name ? ok({ available: true, mode: "start", expectedTurnId: null, reasonCode: "READY_TO_START", observedAt: ago(1) }) : missing("没有这个智能体");
  }
  if ((match = /^\/runtime\/sessions\/([^/]+)\/recovery$/.exec(rest))) {
    const name = agents.sessionNameOf(`owned:${match[1]}`);
    return name ? ok(agents.recovery(name)) : missing("没有恢复记录");
  }
  if ((match = /^\/roles\/([^/]+)(\/[a-z]+)?$/.exec(rest))) {
    const key = team.roleKeyOf(match[1]);
    if (!key) return missing("没有这个职责");
    const sub = match[2];
    if (!sub) return ok(team.roleRecord(key));
    if (sub === "/runtime") return ok(team.roleRuntime(key));
    if (sub === "/revisions") return ok(team.roleRevisions(key));
    if (sub === "/bindings") return ok(team.roleBindings(key));
    if (["/hosts", "/reviews", "/handoffs", "/decisions"].includes(sub)) return ok([]);
    return undefined;
  }
  if ((match = /^\/stages\/([^/]+)\/reviews$/.exec(rest))) return ok(work.stageReviews[match[1]] ?? []);
  return undefined;
}
