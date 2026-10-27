import { useState } from "react";
import type { EvaluationRevision, EvaluationSourceSignature, TaskDetail } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { ActionForm, Notice, type MutationContext } from "../workflow/ActionForm";
import { formatFixedRefs } from "./presentation";
import { definitionFromForm } from "./formData";

type Source = { sourceTaskRevisionId: string; sourceSignature: EvaluationSourceSignature; task: TaskDetail };

export function DefinitionForm({ context, current, ownerTaskId, onApplied }: { context: MutationContext; current?: EvaluationRevision; ownerTaskId?: string; onApplied?: (evaluationId: string) => void }) {
  const [taskId, setTaskId] = useState(current?.definition.case.taskId ?? "");
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const definition = current?.definition;
  async function readSource() {
    setLoading(true); setError(""); setSource(null);
    try {
      const [frozen, task] = await Promise.all([
        api(context.token).evaluationSourceTask(context.projectId, taskId.trim()),
        api(context.token).task(context.projectId, taskId.trim()),
      ]);
      if (task.task.id !== taskId.trim() || task.task.state !== "in_progress" || task.revision.id !== frozen.sourceTaskRevisionId)
        throw new Error("共同任务当前修订未能与服务端固定签名对应；请回读任务。");
      setSource({ ...frozen, task });
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }
  const fields = [
    { name: "ownerTaskId", label: "负责这次评价的任务 ID", value: definition?.ownerTaskId ?? ownerTaskId ?? "" },
    { name: "question", label: "共同评价问题", kind: "textarea" as const, value: definition?.question ?? "" },
    { name: "commonInput", label: "两条件相同的执行指令", kind: "textarea" as const, value: definition?.case.commonInput ?? "" },
    { name: "criteria", label: "公开判定条件", kind: "textarea" as const, value: definition?.case.criteria ?? "" },
    { name: "protocol", label: "固定评价协议", kind: "textarea" as const, value: definition ? formatFixedRefs([definition.protocol]) : "", hint: "一行：document 或 git | ID | 固定修订 | SHA-256" },
    { name: "materials", label: "两条件共用的固定材料", kind: "textarea" as const, value: definition ? formatFixedRefs(definition.case.materials) : "", hint: "每行：document 或 git | ID | 固定修订 | SHA-256；至少一项" },
    { name: "wiki", label: "仅知识条件增加的固定 Wiki", kind: "textarea" as const, value: definition ? formatFixedRefs(definition.conditions[1].wikiRefs ?? []) : "", hint: "每行：wiki | ID | 固定修订 | SHA-256；至少一项。直接条件明确不适用 Wiki。" },
    { name: "model", label: "两个条件相同的明确模型", value: definition?.conditions[0].model ?? "" },
    { name: "cwd", label: "执行工作目录", value: definition?.conditions[0].environment.cwd ?? "", hint: "绝对路径；两条件相同" },
    { name: "authorizationScope", label: "授权工作范围", kind: "textarea" as const, value: definition?.conditions[0].environment.authorizationScope ?? "" },
    { name: "limits", label: "可比较性及工具隔离限制", kind: "textarea" as const, value: definition?.limits ?? "同一用户环境下工具访问隔离未验证；单例不能推断因果知识收益。" },
    ...(current ? [{ name: "reason", label: "修订定义的理由", kind: "textarea" as const, value: "" }] : []),
  ];
  return <section className="panel evaluation-definition-form"><h2>{current ? "另存一版评价定义" : "建立冻结评价"}</h2>
    <p className="muted">先读取当前进行中的共同任务。来源签名由服务端固定；下面只选择共同材料、知识条件和相同执行环境。创建定义不会自动运行或关闭任务。</p>
    <p className="muted">本次新定义统一采用完整本机权限（danger-full-access）、无需逐次审批（never）；两个条件使用相同配置。{current && "若旧定义采用其他权限，新修订会明确改为此配置；旧修订及其尝试保持原样。"}</p>
    <div className="evaluation-source-picker"><label>共同任务 ID<input value={taskId} onChange={event => { setTaskId(event.target.value); setSource(null); }} placeholder="进行中的任务 UUID" /></label><button type="button" onClick={() => void readSource()} disabled={loading || !taskId.trim()}>{loading ? "读取中…" : "读取固定来源"}</button></div>
    {error && <Notice error>{error}</Notice>}
    {source && <><p className="evaluation-source-confirm"><strong>{source.task.task.title}</strong> · 当前进行中修订 <code>{source.sourceTaskRevisionId}</code> · 固定依据 {source.sourceSignature.basis.length} 项</p>
      {source.sourceSignature.external.some(item => item.kind === "wiki") && <Notice error>共同任务已要求 Wiki；直接条件不能移除必需来源，请先调整任务基线。</Notice>}
      {!source.sourceSignature.external.some(item => item.kind === "wiki") && <ActionForm key={`${current?.id ?? "create"}:${source.sourceTaskRevisionId}`} context={{ ...context, draftScope: `evaluation-definition:${current?.evaluationId ?? "new"}`, draftBaseline: `${current?.id ?? "create"}:${source.sourceTaskRevisionId}` }} review title={current ? "冻结新定义修订" : "冻结评价定义"} fields={fields} build={values => {
        const next = definitionFromForm(values, { taskId: source.task.task.id, sourceTaskRevisionId: source.sourceTaskRevisionId, sourceSignature: source.sourceSignature }, definition);
        return current
          ? { type: "evaluation.revise", evaluationId: current.evaluationId, revisionId: crypto.randomUUID(), expectedVersion: current.version, definition: next, reason: values.reason }
          : { type: "evaluation.create", evaluationId: crypto.randomUUID(), revisionId: crypto.randomUUID(), definition: next };
      }} onApplied={result => onApplied?.(result.entityId)} />}
    </>}
  </section>;
}
