// 导入过程文档 / 上传新修订 on the shared command form: what stops an upload before any file is read, and the command the
// import route takes, field by field as the form sent it before (the receipt's `type` is not part of it).
import assert from "node:assert/strict";
import test from "node:test";
import { documentPayloadCommandSchema } from "@evoloop/contracts/process-documents";
import { prepareCommand } from "../src/shared/command/rules.ts";
import { uploadCommand, uploadProblem } from "../src/features/documents/uploadCommand.ts";

const projectId = "47000000-0000-4000-8000-000000000001";
const operationId = "47000000-0000-4000-8000-000000000002";
const ids = { documentId: "47000000-0000-4000-8000-000000000003", revisionId: "47000000-0000-4000-8000-000000000004",
  blobIds: ["47000000-0000-4000-8000-000000000005", "47000000-0000-4000-8000-000000000006"] };
const hash = (c: string) => c.repeat(64);
const md = { main: { name: "方案.md", size: 12 }, assets: [], format: "markdown" as const };

test("an upload that cannot be sent says why before any file is read", () => {
  assert.equal(uploadProblem({ mode: "create", title: "", reason: "r" }, md), "请填写名称、理由并选择原件。");
  assert.equal(uploadProblem({ mode: "revise", title: "", reason: "r", documentId: ids.documentId }, md), "请填写名称、理由并选择原件。", "a revision needs the version it was opened on");
  assert.match(uploadProblem({ mode: "create", title: "t", reason: "r" }, { ...md, main: { name: "a/b.md", size: 1 } }) ?? "", /文件名/);
  assert.match(uploadProblem({ mode: "create", title: "t", reason: "r" }, { ...md, assets: [{ name: "x.png", size: 1, type: "image/png" }] }) ?? "", /HTML 包/);
  assert.match(uploadProblem({ mode: "create", title: "t", reason: "r" }, { ...md, main: { name: "a.md", size: 0 } }) ?? "", /不能为空/);
  assert.match(uploadProblem({ mode: "create", title: "t", reason: "理".repeat(4001) }, md) ?? "", /修订理由最多 4000 字，现在是 4001 字/);
  assert.equal(uploadProblem({ mode: "create", title: "t", reason: "r" }, md), null);
});

test("a new document is the same import command as before, accepted by the route's schema", () => {
  const built = uploadCommand({ mode: "create", title: " 方案 ", kind: "", reason: " 首次导入 ", author: "lead" }, md, [hash("a")], ids);
  const sent = prepareCommand(built, projectId, operationId, { validate: candidate => { const { type: _, ...rest } = candidate; documentPayloadCommandSchema.parse(rest); } });
  const { type, ...command } = sent as Record<string, unknown>;
  assert.equal(type, "document.payload", "the receipt names the write");
  assert.deepEqual(command, { documentId: ids.documentId, revisionId: ids.revisionId, mode: "create", title: "方案", kind: null, format: "markdown",
    mediaType: "text/markdown", originalName: "方案.md", author: "lead", reason: "首次导入", projectId, operationId,
    source: { storage: "blob", payloadRef: ids.blobIds[0], contentHash: hash("a"), size: 12, entrypoint: null, assets: [] } });
});

test("a new revision of an HTML package carries the recorded version and its assets in order", () => {
  const html = { main: { name: "report.html", size: 40 }, assets: [{ name: "chart.png", size: 9, type: "image/png" }], format: "html" as const };
  const built = uploadCommand({ mode: "revise", title: "", kind: "", reason: "更新图表", author: "lead", expectedVersion: 3, documentId: ids.documentId }, html,
    [hash("a"), hash("b")], ids);
  assert.equal(built.expectedVersion, 3);
  assert.equal(built.title, undefined);
  assert.deepEqual(built.source, { storage: "blob", payloadRef: ids.blobIds[0], contentHash: hash("a"), size: 40, entrypoint: "report.html",
    assets: [{ path: "chart.png", blobId: ids.blobIds[1], contentHash: hash("b"), size: 9, mediaType: "image/png" }] });
  assert.throws(() => uploadCommand({ mode: "revise", title: "", kind: "", reason: "r", author: "lead" }, html, [hash("a"), hash("b")], ids), /版本还没有读回/);
});
