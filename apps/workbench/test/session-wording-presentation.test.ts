// The agent page says the service's English limitations in Chinese (readingScopePresentation) and keeps reading,
// not applicable and failed apart in 环境与用量 (environmentPresentation).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecoveryView } from "@evoloop/contracts/session-recovery";
import { describeLimitation, describeLimitations, unknownLimitation } from "../src/features/sessions/readingScopePresentation";
import { environmentRows, notProvidedByExternal } from "../src/features/sessions/environmentPresentation";

const english = /[A-Za-z]{3,}/;

test("the three limitations of an external agent's read are said in Chinese and kept as 原文", () => {
  const raw = ["Native history is unsupported for this Session", "Manual handoff records do not prove native delivery or reading", "Live native updates unavailable"];
  const { lines, originals } = describeLimitations(raw);
  assert.deepEqual(lines, [
    "这个智能体的来源不提供原有历史，这里只显示经 evoLoop 保存的消息",
    "人工转交的记录只说明消息已保存，不能证明原聊天已收到或已读",
    "这个智能体没有实时活动来源，新的活动要重新读取才会出现",
  ]);
  for (const line of lines) assert.doesNotMatch(line.replace("evoLoop", ""), english, line);
  assert.deepEqual(originals, raw, "every replaced original stays available");
});

test("live-read limitations, reset reasons and history metadata gaps are known", () => {
  for (const raw of ["Native connection is unavailable", "No scoped native update has been observed for this Thread",
    "Live updates are bounded to this service process", "Native connection disconnected", "owner connection changed",
    "connection generation changed", "Native history unavailable", "Native history unavailable or unsupported",
    "turn metadata unavailable for requested items", "turn metadata outside bounded scan (10 pages, 100 turns each)",
    "turn metadata outside bounded page (100 turns)", "realtime timeline entries have no turn association"]) {
    const { text, original } = describeLimitation(raw);
    assert.notEqual(text, unknownLimitation, raw);
    assert.doesNotMatch(text, english, raw);
    assert.equal(original, raw);
  }
});

test("plain Chinese stays as written; Chinese with implementation words and unknown English are said in words with their original", () => {
  assert.deepEqual(describeLimitation("重复接入别名仅返回前20项。仍按真实身份归并。"),
    { text: "重复接入别名仅返回前20项。仍按真实身份归并", original: null }, "a plain Chinese limitation is kept, without its closing period");
  // The service's own Chinese that still names Item / Turn / ID: said without those words, the original kept.
  for (const raw of ["已接受的即时补充尚未核实唯一原生 Item；原输入 ID 保留。", "同一原生 Turn 有多个精确匹配的输入 Item，无法核实唯一发送者绑定。",
    "未能在有界的完整已终结 Turn 中核实唯一输入 Item；业务消息仍可独立读取。"]) {
    const { text, original } = describeLimitation(raw);
    assert.notEqual(text, unknownLimitation, raw);
    assert.doesNotMatch(text, english, raw);
    assert.equal(original, raw.replace(/。$/, ""));
  }
  // Chinese mixed with English words is not kept just because it has Chinese.
  assert.deepEqual(describeLimitation("新的 Thread 尚未绑定"), { text: unknownLimitation, original: "新的 Thread 尚未绑定" });
  assert.deepEqual(describeLimitation("workspace history: invalid items page"), { text: unknownLimitation, original: "workspace history: invalid items page" });
  const two = describeLimitations(["first odd thing", "second odd thing", "", "人工转交记录不证明原聊天已收到。"]);
  assert.deepEqual(two.lines, [unknownLimitation, "人工转交记录不证明原聊天已收到"], "the general sentence is said once");
  assert.deepEqual(two.originals, ["first odd thing", "second odd thing"]);
});

const profile = (overrides: Partial<NonNullable<SessionRecoveryView["executionProfile"]>["revision"]> = {}) => ({
  revision: { revisionId: "r1", version: 1, model: "gpt-6-sol", reasoningEffort: "high", sandbox: "danger-full-access", approvalPolicy: "never",
    cwd: "/w", authorizationScope: "s", provenance: "reserved", operationId: "o", actorId: "a", reason: "x", evidenceRef: null, createdAt: "2026-11-10T00:00:00.000Z",
    previousRevisionId: null, sessionId: "s", projectId: "p", ...overrides },
  activationState: "active", activeRevisionId: "r1", activeModel: "gpt-6-sol", activeReasoningEffort: "high", activationOperationId: null, attemptedAt: null, activationEvidence: "e",
}) as unknown as NonNullable<SessionRecoveryView["executionProfile"]>;
const ready = (executionProfile: SessionRecoveryView["executionProfile"]) =>
  ({ status: "ready", view: { executionProfile } as unknown as SessionRecoveryView }) as const;
const values = (rows: [string, string][]) => Object.fromEntries(rows);

test("an external agent's model, effort and permission are not applicable, never 正在读取", () => {
  const rows = values(environmentRows({ kind: "external", recovery: { status: "loading" }, configuredModel: null }));
  assert.deepEqual(rows, { 运行方式: "外部接入", 目标模型: notProvidedByExternal, 思考强度: notProvidedByExternal, 执行权限: notProvidedByExternal });
  assert.equal(values(environmentRows({ kind: "external", recovery: { status: "loading" }, configuredModel: "gpt-5" })).目标模型, "gpt-5",
    "a model the host reported is still shown");
});

test("a project-run agent says reading, failed (无法判断) and read apart", () => {
  const loading = values(environmentRows({ kind: "owned", recovery: { status: "loading" }, configuredModel: null }));
  assert.deepEqual([loading.目标模型, loading.思考强度, loading.执行权限], ["正在读取", "正在读取", "正在读取"]);
  for (const status of ["failed", "unavailable", "forbidden"] as const) {
    const failed = values(environmentRows({ kind: "owned", recovery: { status, message: "x" }, configuredModel: null }));
    assert.deepEqual([failed.目标模型, failed.思考强度, failed.执行权限], ["无法判断（读取失败）", "无法判断（读取失败）", "无法判断（读取失败）"], status);
  }
  const shown = values(environmentRows({ kind: "owned", recovery: ready(profile()), configuredModel: null }));
  assert.equal(shown.目标模型, "gpt-6-sol");
  assert.equal(shown.思考强度, "high");
  assert.doesNotMatch(shown.执行权限, /正在读取|无法判断/);
  const noEffort = values(environmentRows({ kind: "owned", recovery: ready(profile({ reasoningEffort: null })), configuredModel: null }));
  assert.equal(noEffort.思考强度, "未配置");
  const none = values(environmentRows({ kind: "owned", recovery: ready(null), configuredModel: "gpt-5" }));
  assert.deepEqual([none.目标模型, none.思考强度, none.执行权限], ["gpt-5", "未登记执行配置", "未登记执行配置"]);
});
