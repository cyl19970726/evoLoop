// Failed requests in words (shared/errorPresentation.ts): a service's English never reaches the body, a known code is
// said in Chinese, an unknown one gets a general sentence, and the original answer stays available as 诊断信息.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, errorCode, errorDetail, errorDiagnostic, errorText, isStaleConflict } from "../src/shared/api.ts";
import { codeText, describeError, describeFailure } from "../src/shared/errorPresentation.ts";
import { errorOutcome, resultOutcome } from "../src/shared/submissionOutcome.ts";

const chinese = /[㐀-鿿]/;
const internalWords = /\b(Session|Role|Run|operation|assignment|queue|Leader|nextAction)\b|PG\b/i;

test("a known code with an English message is said in Chinese, and the original stays as detail", () => {
  const conflict = new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT", message: "Knowledge baseline changed" });
  assert.equal(errorText(conflict), "所见版本已经变化");
  assert.equal(errorDetail(conflict), "Knowledge baseline changed（VERSION_CONFLICT）");
  assert.equal(errorCode(conflict), "VERSION_CONFLICT");
  for (const [code, words] of [["DOCUMENT_CHANGED", "文档已经被修改"], ["BASELINE_MISMATCH", "所依据的基线与当前记录不一致"],
    ["NOT_FOUND", "要找的记录不存在或已被移除"], ["FORBIDDEN", "当前身份没有这项权限"],
    ["KNOWLEDGE_NOT_CONFIGURED", "这个项目还没有配置知识后端"], ["SOURCE_UNAVAILABLE", "来源暂时无法读取或核验"],
    ["INVALID_COMMAND", "提交的内容不符合要求"], ["NOT_REVIEWED", "还没有通过审阅"]] as const)
    assert.equal(errorText(new ApiError(code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : 409, "Some English reason", { code })), words, code);
});

test("an answer already in Chinese is kept as it is, without a doubled closing period", () => {
  const unconfigured = new ApiError(409, "当前项目尚未配置外置知识后端。", { code: "KNOWLEDGE_NOT_CONFIGURED" });
  assert.equal(errorText(unconfigured), "当前项目尚未配置外置知识后端");
  assert.equal(errorDetail(unconfigured), null, "nothing is hidden when the text is the original");
  assert.equal(errorCode(unconfigured), "KNOWLEDGE_NOT_CONFIGURED");
  assert.equal(`${errorText(unconfigured)}。可以重试。`.includes("。。"), false);
  assert.equal(errorText(new ApiError(0, "连接中断或超时，操作结果尚未确认")), "连接中断或超时，操作结果尚未确认");
  assert.equal(errorText(new Error("知识响应与所选页面不符")), "知识响应与所选页面不符");
});

test("an unknown code is said by its family, else by status; the original goes to detail", () => {
  assert.equal(codeText("SOMETHING_NOT_FOUND"), "要找的记录不存在或已被移除");
  assert.equal(codeText("PLAN_VERSION_CONFLICT"), "所见内容已经变化");
  assert.equal(codeText("INVALID_WIDGET"), "提交的内容不符合要求");
  assert.equal(codeText("WIDGET_UNAVAILABLE"), "相关服务暂时不可用");
  assert.equal(codeText("ZZZ"), null);
  const odd = describeError(new ApiError(409, "widget exploded", { code: "ZZZ" }));
  assert.deepEqual(odd, { text: "服务拒绝了这项请求", detail: "widget exploded（ZZZ）", code: "ZZZ", status: 409 });
  assert.equal(errorText(new ApiError(503, "timing store unavailable", { message: "timing store unavailable" })), "服务暂时出错");
  assert.equal(errorText(new ApiError(404, "Route GET:/x not found")), "要找的记录不存在或已被移除");
  assert.equal(errorText(new ApiError(401, "Unauthorized")), "登录已失效，请重新登录");
  assert.equal(errorText(new Error("signal is aborted without reason")), "请求没有完成");
  assert.equal(errorDetail(new Error("signal is aborted without reason")), "signal is aborted without reason");
  assert.equal(errorText("boom"), "请求没有完成");
  assert.equal(errorText(undefined), "请求没有完成");
});

test("a diagnostic layer still gets the original answer, whatever its language", () => {
  const diagnostic = "Route GET:/api/projects/p/orchestration/work-status not found";
  assert.equal(errorDiagnostic(new ApiError(404, diagnostic, { message: diagnostic })), diagnostic);
  assert.equal(errorDiagnostic(new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT" })), "Knowledge baseline changed（VERSION_CONFLICT）");
  assert.equal(errorDiagnostic(new ApiError(409, "", { code: "VERSION_CONFLICT" })), "VERSION_CONFLICT");
});

test("every stale-conflict code has its own Chinese sentence, and no sentence carries an internal word", () => {
  for (const code of ["VERSION_CONFLICT", "BASELINE_CHANGED", "DOCUMENT_CHANGED", "DECISION_TARGET_CHANGED", "REVIEW_TARGET_CHANGED", "TARGET_CHANGED", "WORK_INDEX_CHANGED"]) {
    assert.ok(isStaleConflict(code), code);
    const text = codeText(code);
    assert.ok(text && chinese.test(text), code);
  }
  for (const code of ["VERSION_CONFLICT", "NOT_FOUND", "FORBIDDEN", "OPERATION_REUSED", "SESSION_BUSY", "TASK_BUSY", "RUNTIME_UNAVAILABLE",
    "ROLE_UNAVAILABLE", "QUEUE_OCCUPIED", "RUN_NOT_ACTIVE", "SESSION_NOT_READY", "ZZZ_REQUIRED"]) {
    const text = describeFailure("English reason", code, 409).text;
    assert.ok(chinese.test(text), code);
    assert.doesNotMatch(text, internalWords, code);
  }
});

test("a submission says what happened in Chinese and keeps the service's original as detail", () => {
  const stale = errorOutcome(new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT" }));
  assert.deepEqual([stale.stale, stale.unconfirmed, stale.failed, stale.applied], [true, false, true, false]);
  assert.equal(stale.message, "所见版本已经变化。先保存草稿，再回读当前状态。");
  assert.equal(stale.detail, "Knowledge baseline changed（VERSION_CONFLICT）");
  const refused = errorOutcome(new ApiError(409, "当前状态不允许。", { code: "INVALID_STATE" }));
  assert.equal(refused.message, "当前状态不允许。这次请求已被明确拒绝；草稿保留，可修改选择后以新操作提交。");
  assert.equal(refused.detail, null);
  const unknown = errorOutcome(new ApiError(503, "upstream timeout"));
  assert.ok(unknown.unconfirmed && !unknown.stale);
  assert.equal(unknown.message, "服务暂时出错。请在上方按原操作 ID 核对，确认前不要再次提交。");
  const rejected = resultOutcome({ status: "rejected", operationId: "o", code: "DOCUMENT_CHANGED", message: "Document changed" });
  assert.deepEqual([rejected.message, rejected.detail, rejected.stale], ["文档已经被修改", "Document changed（DOCUMENT_CHANGED）", true]);
  assert.equal(resultOutcome({ status: "rejected", operationId: "o", code: "INVALID", message: "技能名称不合法" }).message, "技能名称不合法");
  assert.equal(resultOutcome({ status: "applied", operationId: "o", entityId: "e" }).detail, null);
});
