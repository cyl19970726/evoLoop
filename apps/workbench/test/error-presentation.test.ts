// Failed requests in words (shared/errorPresentation.ts, codes in shared/errorCodes.ts): a service's English never
// reaches the body, a known code is said in Chinese, an unknown one gets a general sentence by status, the original
// answer stays available as 诊断信息, and a refusal is never called an unconfirmed result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, errorCode, errorDetail, errorDiagnostic, errorText, isStaleConflict, isUnconfirmed } from "../src/shared/api.ts";
import { serviceErrorCodes } from "../src/shared/errorCodes.ts";
import { codeText, describeError, describeFailure, registerErrorCodes } from "../src/shared/errorPresentation.ts";
import { errorOutcome, resultOutcome } from "../src/shared/submissionOutcome.ts";

const chinese = /[㐀-鿿]/;
const internalWords = /\b(Session|Role|Run|operation|assignment|queue|Leader|nextAction)\b|PG\b/i;
const unconfirmedWords = /结果还没有确认|结果未确认|结果尚未确认/;

test("before the workspace loads the code table, an English answer is said by its status; Chinese stays as it is", () => {
  registerErrorCodes({ known: {}, families: [] });
  assert.equal(errorText(new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT" })), "服务拒绝了这项请求");
  assert.equal(errorText(new ApiError(503, "timing store unavailable")), "服务暂时出错");
  assert.equal(errorText(new ApiError(409, "当前项目尚未配置外置知识后端。", { code: "KNOWLEDGE_NOT_CONFIGURED" })), "当前项目尚未配置外置知识后端");
  assert.equal(errorDetail(new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT" })), "Knowledge baseline changed（VERSION_CONFLICT）");
  registerErrorCodes(serviceErrorCodes);
});

test("a known code with an English message is said in Chinese, and the original stays as detail", () => {
  registerErrorCodes(serviceErrorCodes);
  const conflict = new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT", message: "Knowledge baseline changed" });
  assert.equal(errorText(conflict), "所见版本已经变化");
  assert.equal(errorDetail(conflict), "Knowledge baseline changed（VERSION_CONFLICT）");
  assert.equal(errorCode(conflict), "VERSION_CONFLICT");
  for (const [code, words] of [["DOCUMENT_CHANGED", "文档已经被修改"], ["BASELINE_MISMATCH", "所依据的基线与当前记录不一致"],
    ["NOT_FOUND", "要找的记录不存在或已被移除"], ["FORBIDDEN", "当前身份没有这项权限"], ["INVALID_COMMAND", "提交的内容不符合要求"],
    ["NOT_REVIEWED", "还没有通过审阅"]] as const)
    assert.equal(errorText(new ApiError(code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : 409, "Some English reason", { code })), words, code);
  assert.match(codeText("SOURCE_UNAVAILABLE")!, /不是可核验的已采纳版本.*重新选择来源/);
  assert.match(codeText("SELF_ACCEPTANCE")!, /提交者不能验收自己的交付.*独立智能体的使用记录/);
  assert.match(codeText("INPUT_ID_CONFLICT")!, /输入编号已用于另一条输入/);
  assert.doesNotMatch(codeText("INPUT_ID_CONFLICT")!, /所见内容已经变化/);
});

test("an answer already in Chinese is kept as it is, without a doubled closing period", () => {
  registerErrorCodes(serviceErrorCodes);
  const unconfigured = new ApiError(409, "当前项目尚未配置外置知识后端。", { code: "KNOWLEDGE_NOT_CONFIGURED" });
  assert.equal(errorText(unconfigured), "当前项目尚未配置外置知识后端");
  assert.equal(errorDetail(unconfigured), null, "nothing is hidden when the text is the original");
  assert.equal(errorCode(unconfigured), "KNOWLEDGE_NOT_CONFIGURED");
  assert.equal(`${errorText(unconfigured)}。可以重试。`.includes("。。"), false);
  assert.equal(errorText(new ApiError(0, "连接中断或超时，操作结果尚未确认")), "连接中断或超时，操作结果尚未确认");
  assert.equal(errorText(new Error("知识响应与所选页面不符")), "知识响应与所选页面不符");
});

test("an unknown code is said by its family, else by status; the original goes to detail", () => {
  registerErrorCodes(serviceErrorCodes);
  assert.equal(codeText("SOMETHING_NOT_FOUND"), "要找的记录不存在或已被移除");
  assert.equal(codeText("PLAN_VERSION_CHANGED"), "所见内容已经变化");
  assert.equal(codeText("CONNECTOR_ROUTE_CONFLICT"), "与已有的记录冲突，这次没有写入");
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

test("a refusal is never called an unconfirmed result, and NOT_ is read before the endings", () => {
  registerErrorCodes(serviceErrorCodes);
  // Refusals or missing preconditions (409, not unconfirmed): each says what is missing and what to do next.
  const refusals: Record<string, RegExp> = {
    DELIVERY_ORIGIN_UNVERIFIED: /已签名的执行提交.*请先核对交付来源/,
    DELIVERY_UNVERIFIED: /已通过的固定交付.*请先完成交付验收/,
    AUTHOR_SESSION_UNVERIFIED: /没有绑定提交它的执行记录.*请先核对交付来源/,
    RUNTIME_OWNER_UNKNOWN: /执行环境不在本服务登记的范围内.*请先检查/,
    TASK_TRANSFER_UNCONFIRMED: /转交还没有在更新的修订里登记.*请先完成转交/,
    NOTICE_MESSAGE_UNCONFIRMED: /要先保存固定的消息和任务上下文.*请先保存/,
    RUN_NOT_IN_FLIGHT: /只有正在进行的一轮才能标为结果未知/,
  };
  for (const [code, words] of Object.entries(refusals)) {
    const cause = new ApiError(409, "English reason", { code });
    assert.equal(isUnconfirmed(cause), false, code);
    const text = errorText(cause);
    assert.match(text, words, code);
    assert.doesNotMatch(text, unconfirmedWords, code);
    assert.doesNotMatch(text, /正在处理别的请求/, code);
    const outcome = errorOutcome(cause);
    assert.match(outcome.message, /这次请求已被明确拒绝/, code);
    assert.doesNotMatch(outcome.message, unconfirmedWords, code);
  }
  // Other codes with these endings are refusals too: said by status, never as unconfirmed.
  for (const code of ["STUDY_RECEIVER_ORIGIN_UNVERIFIED", "NATIVE_EXECUTION_UNVERIFIED", "ATTENTION_SOURCE_UNKNOWN", "SEAL_CONFIRMATION_UNCONFIRMED"])
    assert.doesNotMatch(errorText(new ApiError(409, "English reason", { code })), unconfirmedWords, code);
  assert.equal(codeText("TURN_NOT_INTERRUPTIBLE"), "当前状态不允许这项操作");
  assert.equal(codeText("RUN_NOT_IN_FLIGHT")?.includes("正在处理别的请求"), false);
  assert.equal(codeText("ACCEPTANCE_IN_FLIGHT"), "对象正在处理别的请求");
  // Only codes that do mean "the result is not known yet" say so, with the original operation as the next step.
  assert.match(codeText("OPERATION_UNKNOWN")!, /结果还没有确认.*按原操作核对/);
  assert.match(codeText("CONNECTOR_OPERATION_UNCONFIRMED")!, /结果还没有确认.*保留原操作编号/);
});

test("a diagnostic layer still gets the original answer, whatever its language", () => {
  const diagnostic = "Route GET:/api/projects/p/orchestration/work-status not found";
  assert.equal(errorDiagnostic(new ApiError(404, diagnostic, { message: diagnostic })), diagnostic);
  assert.equal(errorDiagnostic(new ApiError(409, "Knowledge baseline changed", { code: "VERSION_CONFLICT" })), "Knowledge baseline changed（VERSION_CONFLICT）");
  assert.equal(errorDiagnostic(new ApiError(409, "", { code: "VERSION_CONFLICT" })), "VERSION_CONFLICT");
});

test("every stale-conflict code is said in Chinese (by the table or by the service), and no sentence carries an internal word", () => {
  registerErrorCodes(serviceErrorCodes);
  // WORK_INDEX_CHANGED is left out of the table: the service writes it in Chinese.
  for (const code of ["VERSION_CONFLICT", "BASELINE_CHANGED", "DOCUMENT_CHANGED", "DECISION_TARGET_CHANGED", "REVIEW_TARGET_CHANGED", "TARGET_CHANGED"]) {
    assert.ok(isStaleConflict(code), code);
    const text = codeText(code);
    assert.ok(text && chinese.test(text), code);
  }
  assert.ok(isStaleConflict("WORK_INDEX_CHANGED"));
  assert.equal(errorText(new ApiError(409, "待处理工作已变化；请从第一页重新核对。", { code: "WORK_INDEX_CHANGED" })), "待处理工作已变化；请从第一页重新核对");
  for (const code of [...Object.keys(serviceErrorCodes.known), "QUEUE_OCCUPIED", "SESSION_NOT_READY", "ZZZ_REQUIRED"]) {
    const text = describeFailure("English reason", code, 409).text;
    assert.ok(chinese.test(text), code);
    assert.doesNotMatch(text, internalWords, code);
  }
});

test("a submission says what happened in Chinese and keeps the service's original as detail", () => {
  registerErrorCodes(serviceErrorCodes);
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
