import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeCapabilities, KnowledgeGraph, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import {
  capabilityFacts, coverageText, emptyFilter, emptyKnowledgeText, filterKnowledge, graphStatusText, historyLabel, isFiltered,
  knowledgeDirectory, label, pageRelations, publishOutcome, readingStanding, reconcileOutcome, relationTypeLabel, sourceReview,
  topicMembers, validityLabel,
} from "../src/features/knowledge/knowledgePresentation.ts";

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
