import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeCapabilities, KnowledgeGraph, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import {
  capabilityFacts, coverageText, emptyFilter, emptyKnowledgeText, filterKnowledge, graphStatusText, historyLabel, isFiltered,
  knowledgeDirectory, label, listProblemText, pageRelations, publishOutcome, readingStanding, reconcileOutcome, relationTypeLabel,
  proposeEntry, sourceHint, sourceReview, topicMembers, validityLabel,
} from "../src/features/knowledge/knowledgePresentation.ts";

test("提出候选 says at the entry that nothing can be proposed without a knowledge backend", () => {
  assert.deepEqual(proposeEntry({ canWrite: false, notConfigured: false, draftTouched: false }), { shown: false });
  assert.deepEqual(proposeEntry({ canWrite: true, notConfigured: true, draftTouched: true }),
    { shown: true, label: "提出候选", disabled: true, reason: "知识后端未配置，暂时不能提出" });
  assert.deepEqual(proposeEntry({ canWrite: true, notConfigured: false, draftTouched: false }), { shown: true, label: "提出候选", disabled: false, reason: null });
  assert.deepEqual(proposeEntry({ canWrite: true, notConfigured: false, draftTouched: true }), { shown: true, label: "继续候选草稿", disabled: false, reason: null });
});

const latin = /[A-Za-z_]{3,}/;
const summary = (id: string, title: string, pageType: KnowledgeSummary["pageType"] = "concept", validity: KnowledgeSummary["validity"] = "valid", revision = `${id}-r`): KnowledgeSummary =>
  ({ knowledgeId: id, revision, title, pageType, validity });

test("service capabilities are said in Chinese; no service code such as adapter_verified reaches the reader", () => {
  const caps: KnowledgeCapabilities = { backendVersion: null, backendReachable: true, fixedRevisionRead: "adapter_verified",
    conditionalPublish: "single_maintainer_adapter", boundedRelations: "adapter_verified", migration: "unsupported", semanticIndex: "unverified" };
  const facts = capabilityFacts(caps);
  for (const [name, value] of facts) { assert.doesNotMatch(name, latin); assert.doesNotMatch(value, latin, `${name}: ${value}`); }
  assert.deepEqual(Object.fromEntries(facts).固定版本正文, "已接通");
  assert.deepEqual(Object.fromEntries(capabilityFacts({ ...caps, fixedRevisionRead: "unavailable", backendReachable: false })).固定版本正文, "未接通");
  assert.equal(Object.fromEntries(capabilityFacts({ ...caps, fixedRevisionRead: "something_new" as never })).固定版本正文, "未识别");
  assert.equal(Object.fromEntries(facts).服务版本, "没有提供");
  for (const status of ["complete", "truncated", "partial", "unavailable"] as const) assert.doesNotMatch(graphStatusText(status), /水位|watermark|[A-Za-z]/);
});

test("unknown values are named as unrecognised instead of shown raw", () => {
  assert.equal(label(validityLabel, "needs_review"), "待复核");
  assert.equal(label(relationTypeLabel, "contradicts"), "挑战或反例");
  assert.equal(label(validityLabel, "brand_new_state"), "未识别");
});

test("filters cover loaded pages only; the directory puts topics first and an open topic lists its members", () => {
  const items = [summary("t1", "布局专题", "topic"), summary("c1", "右栏只在要时打开"), summary("c2", "窄屏不能换组件树", "concept", "needs_review"), summary("d1", "选用 Radix", "decision")];
  assert.equal(isFiltered(emptyFilter), false);
  assert.deepEqual(filterKnowledge(items, { ...emptyFilter, query: "右栏" }).map(item => item.knowledgeId), ["c1"]);
  assert.deepEqual(filterKnowledge(items, { ...emptyFilter, validity: "needs_review" }).map(item => item.knowledgeId), ["c2"]);
  assert.deepEqual(filterKnowledge(items, { ...emptyFilter, type: "topic" }).map(item => item.knowledgeId), ["t1"]);
  const directory = knowledgeDirectory(items);
  assert.deepEqual(directory.topics.map(item => item.knowledgeId), ["t1"]);
  assert.deepEqual(directory.pages.map(item => item.knowledgeId), ["c1", "c2", "d1"]);
  const graph: KnowledgeGraph = { nodes: [items[0]!, items[1]!, items[2]!], status: "complete", watermark: 3, edges: [
    { edgeId: "m1", fromKnowledgeId: "c1", fromRevision: "c1-r", toKnowledgeId: "t1", toRevision: "t1-r", type: "member_of", sourceKeys: [], state: "active" },
    { edgeId: "m2", fromKnowledgeId: "c2", fromRevision: "c2-r", toKnowledgeId: "t1", toRevision: "t1-r", type: "member_of", sourceKeys: [], state: "withdrawn" },
    { edgeId: "r1", fromKnowledgeId: "c2", fromRevision: "c2-r", toKnowledgeId: "t1", toRevision: "t1-r", type: "related", sourceKeys: [], state: "active" },
  ] };
  assert.deepEqual(topicMembers(graph, items[0]!).map(item => item.knowledgeId), ["c1"], "withdrawn and non-member edges are not members");
  assert.deepEqual(topicMembers(graph, { knowledgeId: "t1", revision: "older" }), [], "members belong to the exact topic revision");
  assert.deepEqual(topicMembers(null, items[0]!), []);
});

test("coverage and empty lists never claim more than was read", () => {
  assert.equal(coverageText({ loaded: 50, matched: 50, filtered: false, more: true }), "已载入 50 项 · 后续页面未读");
  assert.equal(coverageText({ loaded: 3, matched: 1, filtered: true, more: false }), "已载入 3 项 · 匹配 1 项 · 已读完");
  assert.match(emptyKnowledgeText({ filtered: true, more: true, fullRead: true }).reason, /载入更多/);
  assert.match(emptyKnowledgeText({ filtered: false, more: false, fullRead: false }).title, /固定引用/);
  assert.match(emptyKnowledgeText({ filtered: false, more: false, fullRead: true }).title, /还没有已发布/);
});

test("the version on screen is named against the current one; history is named by position, not by its code", () => {
  assert.deepEqual(readingStanding("r2", false, "r2"), { label: "当前版", current: true, historical: false, note: null });
  assert.equal(readingStanding("r2", true, "r2").current, true, "a fixed link to the current version is the current version");
  assert.equal(readingStanding("r1", true, "r2").historical, true);
  const unknown = readingStanding("r1", true, null);
  assert.equal(unknown.historical, false);
  assert.match(unknown.label, /待核对/);
  assert.equal(historyLabel(0, "r2", "r2"), "当前版");
  assert.equal(historyLabel(0, "r3", "r2"), "最新一版");
  assert.equal(historyLabel(2, "r0", "r2"), "往前第 2 版");
});

test("incoming relations come from the graph only while the current version is read", () => {
  const page = { knowledgeId: "k1", revision: "r2", relations: [
    { edgeId: "out", fromKnowledgeId: "k1", fromRevision: "r2", toKnowledgeId: "k2", toRevision: "x", type: "supports" as const, sourceKeys: [], state: "active" as const }] };
  const graph: KnowledgeGraph = { nodes: [], status: "complete", watermark: 1, edges: [page.relations[0]!,
    { edgeId: "in", fromKnowledgeId: "k3", fromRevision: "y", toKnowledgeId: "k1", toRevision: "r2", type: "contradicts", sourceKeys: [], state: "active" },
    { edgeId: "old", fromKnowledgeId: "k4", fromRevision: "y", toKnowledgeId: "k1", toRevision: "r1", type: "contradicts", sourceKeys: [], state: "active" }] };
  assert.deepEqual(pageRelations(page, graph, true).map(item => `${item.direction}:${item.edge.edgeId}`), ["out:out", "in:in"]);
  assert.deepEqual(pageRelations(page, graph, false).map(item => item.edge.edgeId), ["out"]);
});

test("sources without a reachable original mark the body for review", () => {
  assert.match(sourceReview([])!, /没有登记来源/);
  assert.match(sourceReview([{ state: "reachable" }, { state: "withdrawn" }])!, /撤回/);
  assert.match(sourceReview([{ state: "unavailable" }])!, /无法判断/);
  assert.equal(sourceReview([{ state: "reachable" }]), null);
});

test("publish and reconcile answers keep the service's reason out of the main text", () => {
  const unknown = publishOutcome({ status: "unknown", operationId: "op", reason: "adapter timeout after manifest write" });
  assert.equal(unknown.tone, "error");
  assert.doesNotMatch(`${unknown.title}${unknown.detail}`, /adapter|op/);
  assert.equal(unknown.diagnostic, "adapter timeout after manifest write");
  assert.equal(publishOutcome({ status: "conflict", operationId: "op", currentRevision: null }).tone, "waiting");
  assert.equal(reconcileOutcome(null).settled, false);
  assert.equal(reconcileOutcome({ status: "unknown", operationId: "op", reason: "x" }).settled, false);
  assert.equal(reconcileOutcome({ status: "published", operationId: "op", revision: "r" }).settled, true);
});

test("reconciling a retracted source says what was found without calling it a publish", () => {
  const found = reconcileOutcome({ status: "published", operationId: "op", revision: "r" }, "retract");
  assert.equal(found.settled, true);
  assert.doesNotMatch(`${found.title}${found.detail}`, /发布/);
  const unchanged = reconcileOutcome({ status: "conflict", operationId: "op", currentRevision: null }, "retract");
  assert.equal(unchanged.settled, true);
  assert.doesNotMatch(`${unchanged.title}${unchanged.detail}`, /发布/);
  assert.equal(reconcileOutcome({ status: "published", operationId: "op", revision: "r" }, "publish").title, "已核到发布记录");
  assert.equal(reconcileOutcome(null, "retract").settled, false);
});

test("a list note says 上次读回 only for what was read before, and offers no retry to an unconfigured backend", () => {
  const failed = listProblemText({ kind: "failed", text: "服务暂时出错", detail: "upstream 503" }, "知识列表");
  assert.doesNotMatch(failed.text, /上次读回/, "a list never read is not 上次读回");
  assert.equal(failed.retry, "重试");
  assert.match(listProblemText({ kind: "stale", text: "服务暂时出错", detail: null }, "知识列表").text, /上次读回的，当前待核对/);
  const page = listProblemText({ kind: "page", text: "服务暂时出错", detail: null }, "知识列表");
  assert.match(page.text, /后面一页.*已载入的仍可查看/);
  assert.equal(page.retry, "重试这一页");
  const unconfigured = listProblemText({ kind: "unconfigured", text: "当前项目尚未配置外置知识后端", detail: null }, "知识列表");
  assert.equal(unconfigured.retry, null);
  assert.doesNotMatch(unconfigured.text, /重试|上次读回/);
  assert.equal(listProblemText({ kind: "cursor", text: "", detail: null }, "知识列表").retry, null);
  for (const kind of ["failed", "stale", "page", "cursor", "unconfigured"] as const)
    assert.doesNotMatch(listProblemText({ kind, text: "服务暂时出错", detail: null }, "知识列表").text, /。。|：。/, kind);
});

test("提出候选 never says there are no sources when the source list was not read back", () => {
  assert.equal(sourceHint(undefined, { error: "", stale: false }), "正在读取可选来源…");
  const unread = sourceHint(undefined, { error: "服务暂时出错", stale: false });
  assert.doesNotMatch(unread, /没有可读取的来源|没有来源/);
  assert.match(unread, /没有读回/);
  assert.match(sourceHint([], { error: "", stale: false }), /已读范围内没有可读取的来源/);
  assert.match(sourceHint([{ state: "withdrawn" }], { error: "服务暂时出错", stale: true }), /上次读回/);
  assert.match(sourceHint([{ state: "reachable" }], { error: "服务暂时出错", stale: true }), /上次读回/);
  assert.equal(sourceHint([{ state: "reachable" }], { error: "", stale: false }), "选一份可读取的过程文档版本。");
});
