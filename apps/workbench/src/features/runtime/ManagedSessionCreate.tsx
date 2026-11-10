// 新建受管智能体: pick a configured full-access grant, then a model both the grant and the runtime's catalog allow.
// Every new agent is registered with full local access and no per-step approval; the request alone does not prove the
// native configuration is active, so the page reads the agent back.
import { useState } from "react";
import { Field, Notice, Select } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient, type ExecutionGrant } from "../../shared/runtimeClient";
import { mutedText } from "../../shared/ui/PageParts";
import { allowedModels } from "./executionPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";


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
    <p className="text-small text-text-secondary">新智能体可以使用这台机器上的全部权限，做每一步时不再逐次请你批准。提交只是登记创建请求，不代表它已经按这个配置启动；创建后请回到这里核对它的状态和执行配置。</p>
    <p className={mutedText}>技术名：沙盒 danger-full-access，审批策略 never。</p>
    {catalog.isPending && <p role="status" className="text-small text-text-secondary">正在读取可用模型…</p>}
    {error && <Notice tone="error">模型目录读取失败：{error}。请重读运行状态后重试。<ErrorDetails error={catalog.error} /></Notice>}
    {!error && value?.status === "unavailable" && <Notice tone="error">模型目录暂不可用：{value.error || "执行服务未能列出模型"}。请重读运行状态后重试。</Notice>}
    {!error && value?.status === "empty" && <Notice tone="error">模型目录为空，当前无法创建智能体。</Notice>}
    {available && models.length === 0 && <Notice tone="error">模型目录没有已授权的可选模型，当前无法创建智能体。</Notice>}
    {available && <>
      <Field label="已配置的完整权限授权">{control => <Select {...control} className="w-full" value={grantIndex} onChange={event => { setGrantIndex(event.target.value); setModel(""); }}>
          <option value="">请选择授权与环境</option>
          {grants.map((item, index) => <option key={index} value={String(index)}>{roleName(item.roleId)} · {item.authorizationScope} · {item.cwd} · {item.model ?? item.models?.join(", ") ?? "未配置精确模型"}</option>)}
        </Select>}</Field>
      {grant && (choices.length === 0
        ? <Notice tone="error">{!grant.model && !grant.models?.length
          ? <>这个授权还没写明允许使用哪些模型，暂时不能用它创建智能体。请项目管理员在执行授权里补上允许的模型，再读取运行状态。<span className="mt-1 block text-caption text-muted-foreground">配置项：runtime.grants 的 model 或 models。</span></>
          : "此授权允许的模型都不在当前模型目录里，无法创建智能体。"}</Notice>
        : <Field label="精确模型">{control => <Select {...control} className="w-full" value={chosen} onChange={event => setModel(event.target.value)}>
            <option value="">请选择模型</option>
            {choices.map(item => <option key={item} value={item}>{item}</option>)}
          </Select>}</Field>)}
      {grant && chosen && <ActionForm key={`${grantIndex}:${chosen}`} context={context} review embedded title="登记并创建智能体" fields={[]} build={() => {
        if (!allowedModels(grant, models).includes(chosen)) throw new Error("模型不在授权与目录交集内");
        return { type: "runtime.session.reserve", sessionId: crypto.randomUUID(), roleId: grant.roleId,
          authorizationScope: grant.authorizationScope, cwd: grant.cwd, sandbox: "danger-full-access", approvalPolicy: "never", model: chosen };
      }} />}
    </>}
  </div>;
}
