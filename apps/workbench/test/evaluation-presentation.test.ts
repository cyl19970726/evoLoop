import assert from "node:assert/strict";
import { test } from "node:test";
import type { Delivery, Document, DocumentRevision, EvaluationAssessment, EvaluationAttempt, EvaluationRevision, RuntimeRunRecord } from "@evoloop/contracts";
import { attemptsForCondition, conclusionComparabilityOptions, costText, currentAssessments, deliveriesForAttempt, evaluationHref, evaluationListHref, fixedRefHref, nextActionHref, parseCostLines, parseFixedRefLines, parseNextActionRef, verifiedFixedDocumentTitle } from "../src/evaluation/presentation.ts";
import { definitionFromForm } from "../src/evaluation/formData.ts";
import { attributableRuns } from "../src/workflow/deliveryRun.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const revision = { evaluationId: id, id, definition: { case: { id } } } as EvaluationRevision;
const attempt = (revisionId: string, conditionId: string, ordinal: number) => ({ evaluationId: id, revisionId, caseId: id, conditionId, ordinal, createdAt: "2026-10-21" }) as EvaluationAttempt;

test("the selected definition alone supplies condition attempts, including retries", () => {
  const rows = [attempt(other, id, 1), attempt(id, id, 2), attempt(id, other, 1), attempt(id, id, 1)];
  assert.deepEqual(attemptsForCondition(revision, rows, id).map(row => row.ordinal), [1, 2]);
  assert.equal(evaluationHref(id, other, id), `#/p/${id}/evaluations/${other}?revision=${id}`);
});

test("a filtered historical match opens its own fixed definition revision", () => {
  assert.equal(evaluationListHref(id, { evaluationId: other, id }), `#/p/${id}/evaluations/${other}?revision=${id}`);
});

test("first-slice conclusion choices do not claim full comparability", () => {
  assert.deepEqual(conclusionComparabilityOptions.map(item => item.value), ["with_limits", "unknown"]);
});

test("corrections append while the current selection excludes superseded assessments", () => {
  const first = { id, supersedesId: null } as EvaluationAssessment;
  const correction = { id: other, supersedesId: id } as EvaluationAssessment;
  assert.deepEqual(currentAssessments([first, correction]).map(row => row.id), [other]);
  assert.equal(first.id, id);
});

test("cost input keeps zero measured, unknown null, and separate phases and units", () => {
  const costs = parseCostLines("输入准备 | min | 0 | 计时器\n运行 | USD | 未测 | 尚无账单");
  assert.deepEqual(costs.map(item => item.amount), [0, null]);
  assert.deepEqual(costs.map(item => item.unit), ["min", "USD"]);
  assert.match(costText(costs[1]!), /未测 USD/);
  assert.throws(() => parseCostLines("运行 | USD | -1 | 账单"));
  assert.throws(() => parseCostLines("运行 | USD |  | 账单"));
});

test("fixed material lines require an allowed kind and complete hash", () => {
  assert.deepEqual(parseFixedRefLines(`document | ${id} | ${other} | ${hash}`, ["document", "git"]), [{ kind: "document", id, revision: other, contentHash: hash }]);
  assert.throws(() => parseFixedRefLines(`wiki | ${id} | ${other} | ${hash}`, ["document", "git"]));
  assert.throws(() => parseFixedRefLines(`git | ${id} | ${other} | abc`, ["document", "git"]));
});

test("definition form freezes the server signature and source revision with direct Wiki explicitly absent", () => {
  const sourceSignature = { title: "共同任务", basis: [{ documentId: id, revisionId: other, contentHash: hash }], external: [] } as never;
  const values = { ownerTaskId: id, question: "知识是否有帮助", commonInput: "同一指令", criteria: "同一标准", limits: "工具隔离未验证",
    protocol: `document | ${id} | ${other} | ${hash}`, materials: `git | repo | commit | ${hash}`,
    wiki: `wiki | ${other} | fixed | ${hash}`, model: "gpt-6-sol", cwd: "/tmp/case", authorizationScope: "case" };
  const ids = [id, other, "33333333-3333-4333-8333-333333333333"];
  const result = definitionFromForm(values, { taskId: other, sourceTaskRevisionId: id, sourceSignature }, undefined, () => ids.shift()!);
  assert.equal(result.case.sourceTaskRevisionId, id);
  assert.equal(result.case.sourceSignature, sourceSignature);
  assert.equal(result.conditions[0].wikiRefs, null);
  assert.equal(result.conditions[1].wikiRefs?.[0]?.kind, "wiki");
  assert.deepEqual(result.conditions[0].environment, result.conditions[1].environment);
  assert.deepEqual(result.conditions[0].environment, { cwd: "/tmp/case", authorizationScope: "case",
    sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.throws(() => definitionFromForm({ ...values, sandbox: "read-only" }, { taskId: other, sourceTaskRevisionId: id, sourceSignature }), /完整执行权限/);
  assert.throws(() => definitionFromForm({ ...values, materials: `wiki | x | y | ${hash}` }, { taskId: other, sourceTaskRevisionId: id, sourceSignature }));
});

test("a next Task action uses its fixed Task revision without pretending to have a content hash", () => {
  const value = parseNextActionRef(`task | ${id} | ${other}`);
  assert.deepEqual(value, { kind: "task", taskId: id, taskRevisionId: other });
  assert.equal(nextActionHref(id, value!), `#/p/${id}/tasks/${id}?revision=${other}`);
  assert.throws(() => parseNextActionRef(`task | ${id} | ${other} | ${hash}`));
  assert.throws(() => parseNextActionRef(`task | ${id} | invalid`));
  assert.deepEqual(parseNextActionRef(`document | ${id} | ${other} | ${hash}`), { kind: "document", id, revision: other, contentHash: hash });
  assert.equal(parseNextActionRef("  "), null);
});

test("two terminal Runs can each own later deliveries despite new registration revisions", () => {
  const attemptOne = { projectId: id, runId: id, actualTaskRevisionId: other } as EvaluationAttempt;
  const attemptTwo = { projectId: id, runId: other, actualTaskRevisionId: other } as EvaluationAttempt;
  const deliveries = [
    { projectId: id, taskId: id, id: "first", runId: id, taskRevisionId: "registration-1" },
    { projectId: id, taskId: id, id: "second", runId: other, taskRevisionId: "registration-2" },
    { projectId: id, taskId: id, id: "legacy", runId: null, taskRevisionId: other },
    { projectId: other, taskId: id, id: "foreign", runId: id },
  ] as Delivery[];
  assert.deepEqual(deliveriesForAttempt(attemptOne, id, deliveries).map(item => item.id), ["first"]);
  assert.deepEqual(deliveriesForAttempt(attemptTwo, id, deliveries).map(item => item.id), ["second"]);
});

test("the registration picker excludes unsettled and foreign Runs", () => {
  const runs = [
    { projectId: id, taskId: id, id: "done", state: "completed" },
    { projectId: id, taskId: id, id: "failed", state: "failed" },
    { projectId: id, taskId: id, id: "interrupted", state: "interrupted" },
    { projectId: id, taskId: id, id: "unknown", state: "unknown" },
    { projectId: id, taskId: other, id: "other-task", state: "completed" },
    { projectId: other, taskId: id, id: "other-project", state: "completed" },
  ] as RuntimeRunRecord[];
  assert.deepEqual(attributableRuns(id, id, runs).map(item => item.id), ["done", "failed", "interrupted"]);
});

test("fixed Wiki source opens the canonical knowledge reader in this authenticated tab", () => {
  const wiki = { kind: "wiki", id, revision: other, contentHash: hash } as const;
  assert.equal(fixedRefHref(id, wiki), `#/p/${id}/knowledge?knowledgeId=${id}&knowledgeRevision=${other}`);
  assert.equal(fixedRefHref(id, { ...wiki, revision: "bad" }), null);
  assert.equal(fixedRefHref(id, { ...wiki, kind: "document" }), `#/p/${id}/documents/${id}?revision=${other}`);
  assert.equal(fixedRefHref(id, { ...wiki, kind: "git" }), null);
});

test("current Document name is an aid only after same-project exact revision and hash read", () => {
  const ref = { kind: "document", id, revision: other, contentHash: hash } as const;
  const document = { projectId: id, id, title: "可读协议名称" } as Document;
  const revision = { projectId: id, documentId: id, id: other, contentHash: hash } as DocumentRevision;
  assert.equal(verifiedFixedDocumentTitle(ref, id, document, revision), "可读协议名称");
  assert.equal(verifiedFixedDocumentTitle(ref, id, { ...document, projectId: other }, revision), null);
  assert.equal(verifiedFixedDocumentTitle(ref, id, document, { ...revision, id }), null);
  assert.equal(verifiedFixedDocumentTitle(ref, id, document, { ...revision, contentHash: "b".repeat(64) }), null);
});
