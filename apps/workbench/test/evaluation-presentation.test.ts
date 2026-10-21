import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationAssessment, EvaluationAttempt, EvaluationRevision } from "@evoloop/contracts";
import { attemptsForCondition, conclusionComparabilityOptions, costText, currentAssessments, evaluationHref, evaluationListHref, nextActionHref, parseCostLines, parseFixedRefLines, parseNextActionRef } from "../src/evaluation/presentation.ts";
import { definitionFromForm } from "../src/evaluation/formData.ts";

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
    wiki: `wiki | ${other} | fixed | ${hash}`, model: "gpt-6-sol", cwd: "/tmp/case", authorizationScope: "case",
    sandbox: "read-only", approvalPolicy: "on-request" };
  const ids = [id, other, "33333333-3333-4333-8333-333333333333"];
  const result = definitionFromForm(values, { taskId: other, sourceTaskRevisionId: id, sourceSignature }, undefined, () => ids.shift()!);
  assert.equal(result.case.sourceTaskRevisionId, id);
  assert.equal(result.case.sourceSignature, sourceSignature);
  assert.equal(result.conditions[0].wikiRefs, null);
  assert.equal(result.conditions[1].wikiRefs?.[0]?.kind, "wiki");
  assert.deepEqual(result.conditions[0].environment, result.conditions[1].environment);
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
