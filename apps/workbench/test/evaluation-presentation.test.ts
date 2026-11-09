import assert from "node:assert/strict";
import { test } from "node:test";
import type { Delivery, Document, DocumentRevision, EvaluationAssessment, EvaluationAttempt, EvaluationRevision, RuntimeRunRecord } from "@evoloop/contracts";
import { attemptsForCondition, conclusionComparabilityOptions, costText, currentAssessments, deliveriesForAttempt, evaluationHref, evaluationListHref, fixedRefHref, nextActionHref, parseCostLines, parseFixedRefLines, parseNextActionRef, verifiedFixedDocumentTitle } from "../src/features/evaluation/presentation.ts";
import {
  actorKindLabels, approvalLabels, assessmentLabels, assessmentName, attemptRunText, comparabilityLabels, conclusionGlance, conditionGlance, conditionLabels,
  correctedPosition, evaluationRowMeta, fixedRefIdentity, fixedRefKindLabels, fixedRefName, fixedTitleKey, frozenTaskTitle, labelOf, nextChoiceLabels,
  observationResultLabels, runCostText, runStateLabels, runStateTones, sandboxLabels, taskStateLabels, technicalResultLabels,
} from "../src/features/evaluation/presentation.ts";
import { definitionFromForm } from "../src/features/evaluation/formData.ts";
import { attributableRuns } from "../src/features/workflow/deliveryRun.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const revision = { evaluationId: id, id, definition: { case: { id } } } as EvaluationRevision;
const attempt = (revisionId: string, conditionId: string, ordinal: number) => ({ evaluationId: id, revisionId, caseId: id, conditionId, ordinal, createdAt: "2026-10-21" }) as EvaluationAttempt;

test("the selected definition alone supplies condition attempts, including retries", () => {
  const rows = [attempt(other, id, 1), attempt(id, id, 2), attempt(id, other, 1), attempt(id, id, 1)];
  assert.deepEqual(attemptsForCondition(revision, rows, id).map(row => row.ordinal), [1, 2]);
  assert.equal(evaluationHref(id, other, id), `/p/${id}/evaluations/${other}?revision=${id}`);
});

test("a filtered historical match opens its own fixed definition revision", () => {
  assert.equal(evaluationListHref(id, { evaluationId: other, id }), `/p/${id}/evaluations/${other}?revision=${id}`);
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
  assert.equal(nextActionHref(id, value!), `/p/${id}/tasks/${id}?revision=${other}`);
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
  assert.equal(fixedRefHref(id, wiki), `/p/${id}/knowledge?knowledgeId=${id}&knowledgeRevision=${other}`);
  assert.equal(fixedRefHref(id, { ...wiki, revision: "bad" }), null);
  assert.equal(fixedRefHref(id, { ...wiki, kind: "document" }), `/p/${id}/documents/${id}?revision=${other}`);
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

// ---- 界面用语，以及读取中或失败时不下结论 ----
const english = /[A-Za-z]/;
const untranslated = (labels: Record<string, string>) => Object.entries(labels).filter(([, text]) => english.test(text.replace(/Wiki|Git/g, "")));

test("every enum the evaluation page shows has a Chinese label, and an unknown value is never echoed in English", () => {
  const maps = { runStateLabels, nextChoiceLabels, comparabilityLabels, conditionLabels, sandboxLabels, approvalLabels, fixedRefKindLabels,
    technicalResultLabels, observationResultLabels, actorKindLabels, taskStateLabels, ...assessmentLabels };
  for (const [name, labels] of Object.entries(maps)) assert.deepEqual(untranslated(labels), [], name);
  assert.deepEqual(Object.keys(runStateLabels).sort(), ["completed", "dispatching", "failed", "interrupted", "requested", "running", "unknown"]);
  assert.deepEqual(Object.keys(runStateTones).sort(), Object.keys(runStateLabels).sort());
  assert.deepEqual(Object.keys(nextChoiceLabels).sort(), ["adopt_with_limits", "maintain", "read_direct", "research", "stop", "wait"]);
  assert.deepEqual(Object.keys(sandboxLabels).sort(), ["danger-full-access", "read-only", "workspace-write"]);
  assert.deepEqual(Object.keys(approvalLabels).sort(), ["never", "on-request", "untrusted"]);
  assert.equal(labelOf(runStateLabels, "unknown"), "结果未知");
  assert.equal(labelOf(runStateLabels, "paused"), "未识别的状态");
  assert.equal(labelOf(runStateLabels, "constructor"), "未识别的状态");
  assert.equal(labelOf(actorKindLabels, undefined, "未识别的身份"), "未识别的身份");
});

test("the list names the common task by its frozen title, not by its ID", () => {
  const item = { version: 2, createdAt: "2026-11-09T08:00:00.000Z", definition: { case: { taskId: other, sourceSignature: { title: " 修复首轮回归 " } } } } as unknown as EvaluationRevision;
  assert.equal(frozenTaskTitle(item), "修复首轮回归");
  const meta = evaluationRowMeta(item, () => "11/9");
  assert.equal(meta, "匹配定义 v2 · 共同任务《修复首轮回归》 · 11/9");
  assert.doesNotMatch(meta, /2222/);
  assert.equal(frozenTaskTitle({ definition: { case: {} } } as unknown as EvaluationRevision), "名称未登记的共同任务");
});

test("a run that is still being read or failed to read is not reported as missing or as a state", () => {
  assert.equal(attemptRunText(undefined, "loading"), "正在读取运行记录");
  assert.equal(attemptRunText(undefined, "failed"), "运行状态无法判断");
  assert.equal(attemptRunText(undefined, "read"), "运行记录未读到");
  assert.equal(attemptRunText({ state: "failed" }, "read"), "失败");
  const rows = [{ ...attempt(id, other, 1), id: "a1", runId: "r1" }, { ...attempt(id, other, 2), id: "a2", runId: "r2" }] as EvaluationAttempt[];
  const judged = [{ attemptId: "a1" }, { attemptId: "a2" }, { attemptId: "elsewhere" }];
  assert.equal(conditionGlance(revision, rows, judged, other, undefined, "loading"), "2 次尝试 · 正在读取运行记录 · 2 项判定");
  assert.equal(conditionGlance(revision, rows, judged, other, undefined, "failed"), "2 次尝试 · 运行状态无法判断 · 2 项判定");
  assert.equal(conditionGlance(revision, rows, judged, other, [{ id: "r2", state: "unknown" }], "read"), "2 次尝试 · 结果未知 · 2 项判定");
  assert.equal(conditionGlance(revision, [], [], other, undefined, "loading"), "0 次尝试 · 尚未运行 · 0 项判定");
});

test("conclusions, assessments and corrections are named in Chinese without IDs", () => {
  assert.equal(conclusionGlance([]), "尚无结论；需看两条件的实际尝试与判定");
  assert.equal(conclusionGlance([{ comparability: "unknown", nextChoice: "stop" }, { comparability: "with_limits", nextChoice: "adopt_with_limits" }]), "有限比较 · 带限制采用");
  const defined = { evaluationId: id, id, definition: { case: { id }, conditions: [{ id: "direct", kind: "direct" }, { id: "wiki", kind: "wiki" }] } } as unknown as EvaluationRevision;
  const attempts = [{ id: "a1", conditionId: "wiki", ordinal: 3 }];
  assert.equal(assessmentName({ attemptId: "a1", assessorKind: "human", actorId: "reviewer", createdAt: "t" }, defined, attempts, () => "11/9"), "加入固定 Wiki · 尝试 3 · 真人 reviewer · 11/9");
  assert.equal(assessmentName({ attemptId: "gone", assessorKind: "agent", actorId: "bot", createdAt: "t" }, defined, attempts, () => "11/9"), "所属尝试未读到 · 智能体 bot · 11/9");
  assert.equal(correctedPosition({ supersedesId: "b" }, [{ id: "a" }, { id: "b" }, { id: "c" }]), 2);
  assert.equal(correctedPosition({ supersedesId: "x" }, [{ id: "a" }]), null);
  assert.equal(correctedPosition({ supersedesId: null }, [{ id: "a" }]), null);
});

test("run cost is what the provider reported; nothing reported is not zero", () => {
  assert.equal(runCostText({ costUsd: null, usage: null }), "运行未报告费用与用量；不视为零。");
  assert.equal(runCostText({ costUsd: 0.42, usage: { inputTokens: 1200, outputTokens: null } }), "服务商报告费用 0.42 美元 · 输入 1200 个、输出 未报告 个词元");
  assert.equal(runCostText({ costUsd: 0 }), "服务商报告费用 0 美元");
});

test("fixed references are named by verified title or kind, and IDs only appear in the full identity", () => {
  const ref = { kind: "document", id, revision: other, contentHash: hash } as const;
  assert.equal(fixedRefName(ref, "评价协议"), "《评价协议》");
  assert.equal(fixedRefName(ref), "文档（名称未核实）");
  assert.equal(fixedRefName({ kind: "wiki", id }), "Wiki 页（名称未核实）");
  assert.equal(fixedRefName({ kind: "git", id: "evoLoop" }), "Git 来源 evoLoop");
  assert.equal(fixedRefName({ kind: "git", id }), "Git 来源（名称未核实）");
  assert.equal(fixedRefIdentity(ref), `文档 ${id} · 修订 ${other} · SHA-256 ${hash}`);
  assert.equal(fixedTitleKey(ref), fixedTitleKey({ ...ref, contentHash: hash.toUpperCase() }));
  assert.notEqual(fixedTitleKey(ref), fixedTitleKey({ ...ref, contentHash: "b".repeat(64) }), "a verified title belongs to one exact hash");
});
