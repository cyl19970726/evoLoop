// How a model is said on a page: its exact ID, with the runtime catalog's display name in front when the catalog gives one, and what a
// Run's Turn actually reported next to (never instead of) the configured profile.
import { describeRunActual, NOT_RECORDED } from "@evoloop/contracts/run-actual";
import type { RunActual } from "@evoloop/contracts/runtime";

export interface ModelCatalogOption { model: string; displayName?: string | null }

/** "显示名 · exact-id" when the catalog names the model and the name is not the ID itself; else the ID. */
export function modelLabel(model: string, catalog: readonly ModelCatalogOption[] | null | undefined): string {
  const name = catalog?.find(option => option.model === model)?.displayName?.trim();
  return name && name !== model ? `${name} · ${model}` : model;
}

/** The facts a Run detail shows about its Turn's model and effort. A value that was not observed reads 未记录; the configured values are labelled as configured. */
export function runActualRows(run: { actual?: RunActual | null; executionProfile?: { model?: string | null; reasoningEffort?: string | null } | null },
  catalog?: readonly ModelCatalogOption[] | null): Array<[string, string]> {
  const view = describeRunActual(run);
  return [
    ["本轮实际模型", view.model === NOT_RECORDED ? NOT_RECORDED : modelLabel(view.model, catalog)],
    ["本轮实际思考强度", view.reasoningEffort === NOT_RECORDED ? NOT_RECORDED
      : `${view.reasoningEffort}（原生读回；${view.effortRequested === true ? "配置里显式请求过强度" : view.effortRequested === false ? "没有显式请求，是运行时的默认" : "是否显式请求未记录"}）`],
    ["子代理模型", view.subagentModels.length ? view.subagentModels.map(model => modelLabel(model, catalog)).join("、") : "没有观察到子代理的模型"],
    ["配置的模型（不是实际值）", view.configuredModel ? modelLabel(view.configuredModel, catalog) : "未指定"],
    ["配置的思考强度（不是实际值）", view.configuredEffort ?? "未指定"],
  ];
}
