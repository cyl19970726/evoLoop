// The two registration forms on 仓库规范 and a task's 运行与关联: what each typed field says is wrong, the revisions a
// process document offers by name, and that choosing by name sends exactly the request body typing the IDs used to.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareCommand } from "../src/shared/command/rules.ts";
import { checkReferenceCommand, formalDecisionCommand, gitReferenceCommand, referenceBody, referencePath } from "../src/features/references/referenceCommands.ts";
import {
  commitProblem, documentChoiceLabel, gitSourceText, hashProblem, isRecordId, pathProblem, referenceIdProblem, repositoryProblem, revisionChoices,
} from "../src/features/references/referencePresentation.ts";
import { allowedPathProblem, allowedPathsText, pathAllowed, repositoryStanding } from "../src/shared/repositoryPresentation.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const operationId = "40000000-0000-4000-8000-000000000004";
const id = (n: number) => `5000000${n}-0000-4000-8000-00000000000${n}`;
const commit = "a".repeat(40), hash = "b".repeat(64);
const sent = (built: Record<string, unknown>) => {
  const command = prepareCommand(built, projectId, operationId, { validate: candidate => checkReferenceCommand(candidate, "actor") }) as Record<string, unknown>;
  return { path: referencePath(command), body: referenceBody(command) };
};
const when = (iso: string) => iso.slice(0, 10);
const revision = (n: number, state: { current?: boolean; published?: boolean } = {}, reason = `第 ${n} 版`) =>
  ({ id: id(n), revisionNumber: n, current: !!state.current, published: !!state.published, createdAt: `2026-11-0${n}T01:00:00.000Z`, author: "lead", reason });

test("a typed field says what is wrong with it; an empty one says nothing", () => {
  for (const check of [repositoryProblem, pathProblem, commitProblem, hashProblem, referenceIdProblem]) assert.equal(check(""), undefined);
  assert.equal(repositoryProblem("evoLoop"), undefined);
  assert.match(repositoryProblem("https://github.com/cyl19970726/evoLoop")!, /不是仓库网址/);
  assert.match(repositoryProblem("me@example.com:team/repo.git")!, /不是仓库网址/);
  assert.match(repositoryProblem("/Users/me/evoLoop")!, /不是本地路径/);
  assert.match(repositoryProblem("r".repeat(101))!, /最多 100 个字符，现在是 101 个/);
  assert.equal(pathProblem("docs/api.md"), undefined);
  assert.match(pathProblem("/docs/api.md")!, /开头不要 \//);
  assert.match(pathProblem("docs/../../etc")!, /不能用 \.\./);
  assert.equal(commitProblem(commit), undefined);
  assert.equal(commitProblem("c".repeat(64)), undefined, "SHA-256 repositories have 64-character commits");
  assert.equal(commitProblem("A".repeat(40)), "完整 commit 要用小写字母 a–f。");
  assert.equal(commitProblem("a".repeat(12)), "完整 commit 要 40 或 64 位，现在是 12 位。");
  assert.equal(commitProblem(`${commit}\n`), "完整 commit 里有空格或换行，请去掉。");
  assert.equal(hashProblem(hash), undefined);
  assert.equal(hashProblem("g".repeat(64)), "SHA-256 只能包含 0–9 和 a–f。");
  assert.equal(hashProblem(commit), "SHA-256 要 64 位，现在是 40 位。");
  assert.equal(referenceIdProblem(id(1)), undefined);
  assert.match(referenceIdProblem(id(1).slice(0, 8))!, /36 位的完整标识/);
  assert.equal(isRecordId(` ${id(1)} `), true);
});

test("a commit or hash the field accepts is one the command accepts, and the other way round", () => {
  const values = { repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash: hash };
  for (const [field, value] of [["commit", "A".repeat(40)], ["commit", "a".repeat(39)], ["contentHash", "B".repeat(64)], ["contentHash", commit]] as const) {
    assert.ok((field === "commit" ? commitProblem : hashProblem)(value));
    assert.throws(() => gitReferenceCommand({ ...values, [field]: value }, { referenceId: id(1) }), /完整 commit/);
  }
  assert.doesNotThrow(() => gitReferenceCommand(values, { referenceId: id(1) }));
});

test("登记 Git 固定来源 still sends the five fields and the operation ID", () => {
  const { path, body } = sent(gitReferenceCommand({ repositoryId: " evoLoop ", path: " docs/api.md ", commit, contentHash: hash }, { referenceId: id(1) }));
  assert.equal(path, `/api/projects/${projectId}/references/git`);
  assert.deepEqual(body, { referenceId: id(1), repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash: hash, operationId });
  assert.equal(gitSourceText({ repositoryId: "evoLoop", path: "docs/api.md" }), "evoLoop · docs/api.md");
});

test("a repository chosen from the list sends the body a typed identifier did; a path outside its allowed paths is said first", () => {
  const listed = repositoryStanding({ projectId, status: "available", items: [{ repositoryId: "evoLoop", allowedPaths: ["docs/", "README.md"] }] });
  assert.equal(listed.kind, "listed");
  const chosen = listed.items.find(item => item.repositoryId === "evoLoop")!;
  // The choice hands over the repository's identifier as it is listed; the body is the same as typing it.
  const { body } = sent(gitReferenceCommand({ repositoryId: chosen.repositoryId, path: "docs/api.md", commit, contentHash: hash }, { referenceId: id(1) }));
  assert.deepEqual(body, { referenceId: id(1), repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash: hash, operationId });
  assert.deepEqual(Object.keys(body).sort(), ["commit", "contentHash", "operationId", "path", "referenceId", "repositoryId"]);
  // The Git source's own rule: an entry ending in / covers the files under it; any other entry is that one file.
  assert.equal(allowedPathProblem("docs/api.md", chosen), undefined);
  assert.equal(allowedPathProblem(" README.md ", chosen), undefined);
  assert.equal(allowedPathProblem("", chosen), undefined, "an empty path says nothing yet");
  assert.equal(allowedPathProblem("src/main.ts", null), undefined, "without a chosen repository there is nothing to check against");
  assert.equal(allowedPathProblem("src/main.ts", chosen), "仓库 evoLoop 只允许读取 docs/ 下的文件、README.md；这个路径不在其中，服务端会拒绝。");
  assert.match(allowedPathProblem("README.md.bak", chosen)!, /不在其中/, "a file entry is that file only");
  assert.match(allowedPathProblem("docs", chosen)!, /不在其中/, "the directory itself is not a file under it");
  assert.equal(pathAllowed("docs/a/b.md", ["docs/"]), true);
});

test("the repository list is said for what it is: listed, none, refused for every project, or unknown", () => {
  assert.equal(repositoryStanding({ projectId, status: "available", items: [] }).kind, "none");
  assert.match(repositoryStanding({ projectId, status: "available", items: [] }).text, /没有为本项目配置仓库，登记 Git 固定来源会被拒绝/);
  const refused = repositoryStanding({ projectId, status: "unavailable", reason: "registration_invalid", items: [{ repositoryId: "evoLoop", allowedPaths: ["docs/"] }] });
  assert.equal(refused.kind, "refused");
  assert.equal(refused.items.length, 1, "this project's entries are still listed, none readable");
  assert.match(refused.text, /仓库登记里有 Git 来源不接受的条目（例如绝对路径、越出仓库、重复登记、非法字符或路径段[\s\S]*整份登记被拒，所有项目现在都读不了 Git/);
  assert.doesNotMatch(refused.text, /没有配置仓库/, "a refused registration is never said as none configured");
  for (const reason of ["not_provided", "read_failed"] as const) {
    const unknown = repositoryStanding({ projectId, status: "unavailable", reason });
    assert.equal(unknown.kind, "unknown");
    assert.doesNotMatch(unknown.text, /没有配置/);
  }
  assert.match(repositoryStanding({ projectId, status: "unavailable", reason: "not_provided" }).text, /没有提供仓库清单/);
  assert.match(repositoryStanding({ projectId, status: "unavailable", reason: "read_failed" }).text, /读取仓库配置失败/);
  const strange = repositoryStanding({ projectId, status: "unavailable", reason: "new_reason" as "read_failed" });
  assert.equal(strange.kind === "unknown" && strange.code, "new_reason", "an unknown reason keeps its code for 完整标识");
  assert.equal(allowedPathsText(["docs/", "README.md"]), "docs/ 下的文件、README.md");
});

test("revisions are offered by number, state, when, who and why, as the revision list gives them", () => {
  const listed = [revision(3, { current: true }, "补充接口说明，第二节改写并加例子"), revision(2, { published: true }), revision(1)];
  assert.deepEqual(revisionChoices(listed, "published", when), [
    { id: id(3), label: "第 3 版 · 当前版 · 2026-11-03 · lead · 补充接口说明，第二节改写并加例子" },
    { id: id(2), label: "第 2 版 · 已采用 · 2026-11-02 · lead · 第 2 版" },
    { id: id(1), label: "第 1 版 · 2026-11-01 · lead · 第 1 版" },
  ]);
  assert.equal(revisionChoices([revision(3, { current: true, published: true })], "published", when)[0]!.label.startsWith("第 3 版 · 当前版，已采用 · "), true);
  assert.equal(revisionChoices([revision(2, { published: true })], "archived", when)[0]!.label.startsWith("第 2 版 · 归档前发布 · "), true,
    "an archived document keeps its publish pointer; its version is not called adopted");
  assert.match(revisionChoices([revision(4, {}, "很".repeat(30))], "draft", when)[0]!.label, /很{24}…$/);
  // A reason the service wrote for agents is said in Chinese, never with its identifiers.
  assert.equal(revisionChoices([{ ...revision(1), reason: "Initial draft" }], "draft", when)[0]!.label, "第 1 版 · 2026-11-01 · lead · 初稿");
  assert.equal(documentChoiceLabel({ title: "接口说明", status: "published" }), "接口说明");
  assert.equal(documentChoiceLabel({ title: "旧方案", status: "archived" }), "旧方案（已归档）");
  assert.equal(documentChoiceLabel({ title: " ", status: "draft" }), "未命名文档（草稿）");
});

test("记录正式文档关系 chosen by name sends exactly the body the typed IDs did", () => {
  // The chooser hands over the chosen document's ID and the chosen revision's ID; nothing else reaches the request.
  const [chosen] = revisionChoices([revision(3, { current: true }), revision(2, { published: true })], "published", when);
  const { path, body } = sent(formalDecisionCommand({ gitReferenceId: id(1), documentId: id(5), documentRevisionId: chosen!.id, decision: "incorporated",
    reason: " 已并入第 3 节 " }, { decisionId: id(4) }));
  assert.equal(path, `/api/projects/${projectId}/references/formal-decisions`);
  assert.deepEqual(body, { decisionId: id(4), gitReferenceId: id(1), documentId: id(5), documentRevisionId: id(3), decision: "incorporated",
    reason: "已并入第 3 节", operationId });
  assert.deepEqual(Object.keys(body).sort(), ["decision", "decisionId", "documentId", "documentRevisionId", "gitReferenceId", "operationId", "reason"]);
});
