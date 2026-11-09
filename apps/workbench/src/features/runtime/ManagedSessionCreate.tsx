// 新建受管智能体: pick a configured full-access grant, then a model both the grant and the runtime's catalog allow.
// Every new agent is registered with full local access and no per-step approval; the request alone does not prove the
// native configuration is active, so the page reads the agent back.
import { useState } from "react";
import { Field, Notice } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient, type ExecutionGrant } from "../../shared/runtimeClient";
import { Legacy, mutedText } from "../../shared/ui/PageParts";
import { allowedModels } from "./executionPresentation";

const select = "h-9 w-full rounded-md bg-field px-3 text-small text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]";

export function ManagedSessionCreate({ context, grants, roleName }: { context: MutationContext; grants: ExecutionGrant[]; roleName(roleId: string): string }) {
  const catalog = useProjectQuery(context.projectId, ["runtime", "models"], () => runtimeClient("", context.projectId).models());
  const [grantIndex, setGrantIndex] = useState("");
  const [model, setModel] = useState("");
  const value = catalog.data;
  const error = catalog.error ? errorText(catalog.error) : "";
  const available = !error && value?.status === "available" && Array.isArray(value.models);
  const models = available ? value!.models.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
  const grant = grantIndex === "" ? undefined : grants[Number(grantIndex)];
  const choices = grant ? allowedModels(grant, models) : [];
  const chosen = choices.includes(model) ? model : "";
  return <div className="flex flex-col gap-3">
    <p className={mutedText}>新智能体统一登记完整本机权限（danger-full-access）及无需逐次审批（never）。创建请求不等于原生配置已激活；请回读智能体状态与执行配置。</p>
    {catalog.isPending && <p role="status" className="text-small text-text-secondary">正在读取可用模型…</p>}
    {error && <Notice tone="error">模型目录读取失败：{error}。请重读运行状态后重试。</Notice>}
    {!error && value?.status === "unavailable" && <Notice tone="error">模型目录暂不可用：{value.error || "执行服务未能列出模型"}。请重读运行状态后重试。</Notice>}
    {!error && value?.status === "empty" && <Notice tone="error">模型目录为空，当前无法创建智能体。</Notice>}
    {available && models.length === 0 && <Notice tone="error">模型目录没有已授权的可选模型，当前无法创建智能体。</Notice>}
    {available && <>
      <Field label="已配置的完整权限授权">{control => <select {...control} className={select} value={grantIndex} onChange={event => { setGrantIndex(event.target.value); setModel(""); }}>
          <option value="">请选择授权与环境</option>
          {grants.map((item, index) => <option key={index} value={String(index)}>{roleName(item.roleId)} · {item.authorizationScope} · {item.cwd} · {item.model ?? item.models?.join(", ") ?? "未配置精确模型"}</option>)}
        </select>}</Field>
      {grant && (choices.length === 0
        ? <Notice tone="error">{!grant.model && !grant.models?.length
          ? "此环境尚未配置精确模型授权。请在 runtime.grants 的 model 或 models 中配置所需模型后重读运行状态。"
          : "此授权与当前模型目录没有交集，无法创建智能体。"}</Notice>
        : <Field label="精确模型">{control => <select {...control} className={select} value={chosen} onChange={event => setModel(event.target.value)}>
            <option value="">请选择模型</option>
            {choices.map(item => <option key={item} value={item}>{item}</option>)}
          </select>}</Field>)}
      {grant && chosen && <Legacy><ActionForm key={`${grantIndex}:${chosen}`} context={context} review embedded title="登记并创建智能体" fields={[]} build={() => {
        if (!allowedModels(grant, models).includes(chosen)) throw new Error("模型不在授权与目录交集内");
        return { type: "runtime.session.reserve", sessionId: crypto.randomUUID(), roleId: grant.roleId,
          authorizationScope: grant.authorizationScope, cwd: grant.cwd, sandbox: "danger-full-access", approvalPolicy: "never", model: chosen };
      }} /></Legacy>}
    </>}
  </div>;
}
