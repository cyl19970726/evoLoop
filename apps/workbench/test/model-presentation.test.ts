import assert from "node:assert/strict";
import { test } from "node:test";
import { modelLabel, runActualRows } from "../src/shared/modelPresentation.ts";
import { environmentRows } from "../src/features/sessions/environmentPresentation.ts";

const catalog = [{ model: "deepseek/deepseek-flash", displayName: "DeepSeek Flash" }, { model: "claude-opus-5-5", displayName: null }, { model: "same", displayName: "same" }];

test("a model is its exact ID, with the catalog's display name in front when there is one", () => {
  assert.equal(modelLabel("deepseek/deepseek-flash", catalog), "DeepSeek Flash · deepseek/deepseek-flash");
  assert.equal(modelLabel("claude-opus-5-5", catalog), "claude-opus-5-5");
  assert.equal(modelLabel("same", catalog), "same");
  assert.equal(modelLabel("unlisted", catalog), "unlisted");
  assert.equal(modelLabel("x", null), "x");
});

test("a Run says what its Turn reported and, apart, what was configured; nothing observed reads 未记录 and never shows the configured value as actual", () => {
  const configured = { model: "opus", reasoningEffort: "high" };
  const none = Object.fromEntries(runActualRows({ executionProfile: configured }));
  assert.equal(none["本轮实际模型"], "未记录"); assert.equal(none["本轮实际思考强度"], "未记录");
  assert.equal(none["子代理模型"], "没有观察到子代理的模型");
  assert.equal(none["配置的模型（不是实际值）"], "opus"); assert.equal(none["配置的思考强度（不是实际值）"], "high");
  const seen = Object.fromEntries(runActualRows({ executionProfile: configured, actual: { model: "claude-opus-5-5", reasoningEffort: null, subagentModels: ["claude-haiku-4-5"] } }));
  assert.equal(seen["本轮实际模型"], "claude-opus-5-5"); assert.equal(seen["本轮实际思考强度"], "未记录", "an effort nobody reported is not filled from the configuration");
  assert.equal(seen["子代理模型"], "claude-haiku-4-5"); assert.equal(seen["配置的模型（不是实际值）"], "opus");
  // Task f9e0fd58 v7: no effort configured, the runtime read max back: shown as reported and marked as not explicitly requested; a configured one is marked requested.
  const defaulted = Object.fromEntries(runActualRows({ executionProfile: { model: "m", reasoningEffort: null }, actual: { model: "m", reasoningEffort: "max", subagentModels: [], effortRequested: false } }));
  assert.equal(defaulted["本轮实际思考强度"], "max（原生读回；没有显式请求，是运行时的默认）"); assert.equal(defaulted["配置的思考强度（不是实际值）"], "未指定");
  const asked = Object.fromEntries(runActualRows({ executionProfile: { model: "m", reasoningEffort: "high" }, actual: { model: "m", reasoningEffort: "max", subagentModels: [], effortRequested: true } }));
  assert.equal(asked["本轮实际思考强度"], "max（原生读回；配置里显式请求过强度）"); assert.equal(asked["配置的思考强度（不是实际值）"], "high", "the reported value is not the configured one");
  assert.equal(Object.fromEntries(runActualRows({ actual: { model: "m", reasoningEffort: null, subagentModels: [], effortRequested: false } }))["本轮实际思考强度"], "未记录", "only a missing read-back reads 未记录");
  // A Run with no profile at all.
  assert.equal(Object.fromEntries(runActualRows({}))["配置的模型（不是实际值）"], "未指定");
  // Codex: the catalog's display name comes in front of the exact IDs.
  const codex = Object.fromEntries(runActualRows({ executionProfile: { model: "deepseek/deepseek-flash", reasoningEffort: "max" }, actual: { model: "deepseek/deepseek-flash", reasoningEffort: "max", subagentModels: [] } }, catalog));
  assert.equal(codex["本轮实际模型"], "DeepSeek Flash · deepseek/deepseek-flash"); assert.equal(codex["本轮实际思考强度"], "max（原生读回；是否显式请求未记录）");
});

test("the agent's environment names the configured model with its display name when the catalog has one", () => {
  const rows = environmentRows({ kind: "owned", recovery: { status: "ready", view: { executionProfile: { revision: { model: "deepseek/deepseek-flash", reasoningEffort: "max", sandbox: "danger-full-access", approvalPolicy: "never" } } } } as never,
    configuredModel: null, modelLabelOf: model => modelLabel(model, catalog) });
  assert.equal(Object.fromEntries(rows)["目标模型"], "DeepSeek Flash · deepseek/deepseek-flash");
  const plain = environmentRows({ kind: "owned", recovery: { status: "ready", view: { executionProfile: { revision: { model: "opus", reasoningEffort: "high", sandbox: "danger-full-access", approvalPolicy: "never" } } } } as never, configuredModel: null });
  assert.equal(Object.fromEntries(plain)["目标模型"], "opus");
});
