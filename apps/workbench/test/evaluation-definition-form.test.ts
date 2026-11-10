// 建立冻结评价: tasks, documents, Wiki pages and their versions are chosen by name; the revision and hash come from what
// the page read back. The command is the one the typed `类型 | 标识 | 固定修订 | SHA-256` lines gave before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSchema, type Document, type DocumentRevision, type EvaluationRevision } from "@evoloop/contracts";
import type { KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { definitionCommand } from "../src/features/evaluation/formData.ts";
import { documentFixedRef, documentVersionLabel, refRows, typedRef, wikiFixedRef, withRef, withoutRef } from "../src/features/evaluation/fixedRefChoice.ts";
import { formatFixedRefs } from "../src/features/evaluation/presentation.ts";

const id = (n: number) => `44000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2), ownerTaskId = id(3), sourceRevision = id(4);
const protocolDoc = id(10), protocolRev = id(11), materialDoc = id(12), materialRev = id(13), wikiPage = id(14), wikiRev = id(15);
const hash = (c: string) => c.repeat(64);
const document = (docId: string, current: string): Document => ({ projectId, id: docId, title: "评价协议", version: 3, currentRevisionId: current, adoptedRevisionId: null, kind: "spec", status: "published" });
const revision = (docId: string, revId: string, contentHash: string) => ({ projectId, documentId: docId, id: revId, contentHash }) as DocumentRevision;
const wikiPageRevision = { projectId, knowledgeId: wikiPage, revision: wikiRev, contentHash: hash("d"), title: "回归经验" } as KnowledgeRevision;
const source = { taskId, sourceTaskRevisionId: sourceRevision,
  sourceSignature: { title: "修复首轮回归", contentDocumentId: id(20), contentRevisionId: id(21), acceptance: "回归测试通过", owner: id(22), kind: "implementation",
    basis: [{ documentId: id(23), revisionId: id(24), contentHash: hash("c") }], retentions: [], external: [] } } as never;
const text = { question: "加入固定 Wiki 后首轮修复是否更快？", commonInput: "修复首轮回归", criteria: "同一回归测试通过", model: "gpt-6-sol", cwd: "/work/case",
  authorizationScope: "本案例目录", limits: "工具隔离未验证" };
const counter = () => { let n = 100; return () => id(n++); };

/** What the old form had the person type. */
const typed = { ...text, ownerTaskId,
  protocol: `document | ${protocolDoc} | ${protocolRev} | ${hash("a")}`,
  materials: `document | ${materialDoc} | ${materialRev} | ${hash("b")}\ngit | evoLoop | abc1234 | ${hash("e")}`,
  wiki: `wiki | ${wikiPage} | ${wikiRev} | ${hash("d")}` };

test("choosing a document version, a Wiki version and a Git source sends the command the typed lines sent", () => {
  const protocol = documentFixedRef(projectId, document(protocolDoc, protocolRev), revision(protocolDoc, protocolRev, hash("a")))!;
  const material = documentFixedRef(projectId, document(materialDoc, materialRev), revision(materialDoc, materialRev, hash("b")))!;
  const wiki = wikiFixedRef(projectId, wikiPage, wikiRev, wikiPageRevision)!;
  const chosen = { ...text, ownerTaskId,
    protocol: withRef("", protocol, true),
    materials: withRef(withRef("", material), typedRef(`git | evoLoop | abc1234 | ${hash("e")}`, ["document", "git"])),
    wiki: withRef("", wiki) };
  const sent = definitionCommand(chosen, source, undefined, counter());
  assert.deepEqual(sent, definitionCommand(typed, source, undefined, counter()));
  // The exact command (golden): the same fields and values as the old form's build.
  assert.deepEqual(sent, { type: "evaluation.create", evaluationId: id(103), revisionId: id(104), definition: {
    ownerTaskId, question: text.question, protocol: { kind: "document", id: protocolDoc, revision: protocolRev, contentHash: hash("a") },
    case: { id: id(100), taskId, sourceTaskRevisionId: sourceRevision, sourceSignature: (source as { sourceSignature: unknown }).sourceSignature, commonInput: text.commonInput,
      materials: [{ kind: "document", id: materialDoc, revision: materialRev, contentHash: hash("b") }, { kind: "git", id: "evoLoop", revision: "abc1234", contentHash: hash("e") }],
      criteria: text.criteria },
    conditions: [
      { id: id(101), kind: "direct", wikiRefs: null, model: text.model, environment: { cwd: text.cwd, authorizationScope: text.authorizationScope, sandbox: "danger-full-access", approvalPolicy: "never" } },
      { id: id(102), kind: "wiki", wikiRefs: [{ kind: "wiki", id: wikiPage, revision: wikiRev, contentHash: hash("d") }], model: text.model,
        environment: { cwd: text.cwd, authorizationScope: text.authorizationScope, sandbox: "danger-full-access", approvalPolicy: "never" } },
    ], limits: text.limits } });
  assert.equal(commandSchema.parse({ ...sent, projectId, operationId: id(99) }).type, "evaluation.create");
});

test("another version replaces the protocol; a repeat is not added twice; a removed source is gone", () => {
  const first = documentFixedRef(projectId, document(protocolDoc, protocolRev), revision(protocolDoc, protocolRev, hash("a")))!;
  const other = documentFixedRef(projectId, document(protocolDoc, id(16)), revision(protocolDoc, id(16), hash("f")))!;
  assert.equal(withRef(withRef("", first, true), other, true), formatFixedRefs([other]));
  const twice = withRef(withRef("", first), first);
  assert.equal(twice, formatFixedRefs([first]));
  const both = withRef(twice, other);
  assert.equal(withoutRef(both, 0), formatFixedRefs([other]));
  assert.deepEqual(refRows(both, ["document"]).map(row => row.ref), [first, other]);
});

test("a revision that is not the chosen document's, or has no usable hash, is never offered as a fixed source", () => {
  assert.equal(documentFixedRef(projectId, document(protocolDoc, protocolRev), revision(materialDoc, protocolRev, hash("a"))), null);
  assert.equal(documentFixedRef(projectId, document(protocolDoc, protocolRev), revision(protocolDoc, protocolRev, "sha256:abc")), null);
  assert.equal(documentFixedRef(id(9), document(protocolDoc, protocolRev), revision(protocolDoc, protocolRev, hash("a"))), null);
  assert.equal(wikiFixedRef(projectId, wikiPage, id(17), wikiPageRevision), null, "another revision than the one chosen");
  assert.equal(wikiFixedRef(projectId, id(18), wikiRev, wikiPageRevision), null, "another page");
  assert.throws(() => typedRef(`wiki | ${wikiPage} | ${wikiRev} | ${hash("d")}`, ["document", "git"]));
  const rows = refRows(`${typed.protocol}\nnot a source`, ["document", "git"]);
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.ref && !rows[1]!.ref && rows[1]!.problem, "an unreadable line is said, the others still read");
});

test("a version is named as current, adopted or earlier, by its date", () => {
  const doc = { ...document(protocolDoc, protocolRev), adoptedRevisionId: id(16) };
  assert.equal(documentVersionLabel(doc, protocolRev, "2026/11/9 08:00:00"), "当前版本 · 2026/11/9 08:00:00");
  assert.equal(documentVersionLabel(doc, id(16), "2026/11/8"), "已采用版本 · 2026/11/8");
  assert.equal(documentVersionLabel(doc, id(17), "2026/11/7"), "较早版本 · 2026/11/7");
});

test("a revision opened on the frozen definition and saved untouched keeps its sources", () => {
  const frozen = definitionCommand(typed, source, undefined, counter());
  const current = { evaluationId: frozen.evaluationId, version: 2, definition: frozen.definition } as Pick<EvaluationRevision, "evaluationId" | "version" | "definition">;
  const reopened = { ...text, ownerTaskId: current.definition.ownerTaskId, protocol: formatFixedRefs([current.definition.protocol]),
    materials: formatFixedRefs(current.definition.case.materials), wiki: formatFixedRefs(current.definition.conditions[1].wikiRefs ?? []), reason: "改问题" };
  const revised = definitionCommand(reopened, source, current, counter());
  assert.equal(revised.type, "evaluation.revise");
  assert.deepEqual(revised.definition, frozen.definition, "same case and condition IDs, same sources");
  assert.deepEqual({ evaluationId: revised.evaluationId, expectedVersion: (revised as { expectedVersion: number }).expectedVersion, reason: (revised as { reason: string }).reason },
    { evaluationId: frozen.evaluationId, expectedVersion: 2, reason: "改问题" });
});
