import { useEffect, useState } from "react";
import { errorText } from "../api";
import { ActionForm, Notice, type MutationContext } from "../workflow/ActionForm";
import { runtimeClient, type ExecutionGrant, type RuntimeModels } from "./client";

function allowedModels(grant: ExecutionGrant, catalog: string[]): string[] {
  const authorized = [ ...(grant.model ? [grant.model] : []), ...(grant.models ?? []) ];
  return [...new Set(catalog.filter(model => authorized.includes(model)))];
}
const defaultChoice = "__grant_default_model__";

export function SessionCreation({ context, grants, refresh }: {
  context: MutationContext; grants: ExecutionGrant[]; refresh: number;
}) {
  const [catalog, setCatalog] = useState<{ scope: string; value: RuntimeModels | null; error: string } | null>(null);
  const [grantIndex, setGrantIndex] = useState("");
  const [model, setModel] = useState("");
  const scope = JSON.stringify([context.token, context.projectId, refresh]);
  useEffect(() => {
    let active = true;
    setCatalog(null);
    setGrantIndex(""); setModel("");
    void runtimeClient(context.token, context.projectId).models().then(value => {
      if (active) setCatalog({ scope, value, error: "" });
    }).catch(cause => {
      if (active) setCatalog({ scope, value: null, error: errorText(cause) });
    });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh, scope]);
  const current = catalog?.scope === scope ? catalog : null;
  const available = current?.value?.status === "available" && Array.isArray(current.value.models);
  const catalogModels = available ? current.value!.models.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
  const grant = grantIndex === "" ? undefined : grants[Number(grantIndex)];
  const choices = grant ? allowedModels(grant, catalogModels) : [];
  const defaultGrant = !!grant && !grant.model && !grant.models?.length;
  const selectedModel = defaultGrant && model === defaultChoice || choices.includes(model) ? model : "";
  return <details className="workflow-detail"><summary>创建授权范围内的新会话</summary>
    <p className="muted">新会话统一登记完整本机权限（danger-full-access）及无需逐次审批（never）。创建请求不等于原生配置已激活；请回读会话状态与执行配置。</p>
    {!current && <p role="status">正在读取可用模型…</p>}
    {current?.error && <Notice error>模型目录读取失败：{current.error}。请重读运行状态后重试。</Notice>}
    {current?.value?.status === "unavailable" && <Notice error>模型目录暂不可用：{current.value.error || "执行服务未能列出模型"}。请重读运行状态后重试。</Notice>}
    {current?.value?.status === "empty" && <Notice error>模型目录为空，当前无法创建会话。</Notice>}
    {available && catalogModels.length === 0 && !grants.some(item => !item.model && !item.models?.length) && <Notice error>模型目录没有已授权的可选模型，当前无法创建会话。</Notice>}
    {available && <>
      <label>已配置的完整权限授权
        <select value={grantIndex} onChange={event => { setGrantIndex(event.target.value); setModel(""); }}>
          <option value="">请选择授权与环境</option>
          {grants.map((item, index) => <option value={String(index)} key={index}>{item.roleId} · {item.authorizationScope} · {item.cwd} · {item.model ?? "默认模型"}</option>)}
        </select>
      </label>
      {grant && <>
        {choices.length === 0 && !defaultGrant ? <Notice error>此授权与当前模型目录没有交集，无法创建会话。</Notice> : <label>{defaultGrant ? "授权默认模型" : "精确模型"}
          <select value={selectedModel} onChange={event => setModel(event.target.value)}>
            <option value="">请选择模型</option>
            {defaultGrant && <option value={defaultChoice}>使用授权默认模型</option>}
            {choices.map(item => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>}
      </>}
      {grant && selectedModel && <ActionForm key={`${grantIndex}:${selectedModel}`} context={context} review embedded title="登记并创建会话" fields={[]} build={() => {
        if (selectedModel !== defaultChoice && !allowedModels(grant, catalogModels).includes(selectedModel)) throw new Error("模型不在授权与目录交集内");
        return { type: "runtime.session.reserve", sessionId: crypto.randomUUID(), roleId: grant.roleId,
          authorizationScope: grant.authorizationScope, cwd: grant.cwd, sandbox: "danger-full-access",
          approvalPolicy: "never", ...(selectedModel === defaultChoice ? {} : { model: selectedModel }) };
      }} />}
    </>}
  </details>;
}
