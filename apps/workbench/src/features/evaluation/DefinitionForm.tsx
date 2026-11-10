// 建立冻结评价 / 另存一版评价定义. The common task is read first: the server fixes its source signature, and the form
// only chooses the shared materials, the Wiki condition and the one execution environment both conditions use.
import { useState } from "react";
import type { EvaluationRevision } from "@evoloop/contracts";
import { Button, Field, Input, Notice } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { EvaluationForm } from "./EvaluationForm";
import { formatFixedRefs } from "./presentation";
import { definitionFromForm } from "./formData";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const muted = "m-0 text-caption text-muted-foreground";

export function DefinitionForm({ context, current, ownerTaskId, onApplied, hold }: {
  context: MutationContext; current?: EvaluationRevision; ownerTaskId?: string; onApplied?: (evaluationId: string) => void; hold?: string | undefined;
}) {
  const [taskId, setTaskId] = useState(current?.definition.case.taskId ?? "");
  const [requested, setRequested] = useState<string | null>(null);
  const source = useProjectQuery(context.projectId, ["evaluation-source", requested ?? ""], async () => {
    const id = requested!;
    const [frozen, task] = await Promise.all([api().evaluationSourceTask(context.projectId, id), api().task(context.projectId, id)]);
    if (task.task.id !== id || task.task.projectId !== context.projectId || task.task.state !== "in_progress" || task.revision.id !== frozen.sourceTaskRevisionId)
      throw new Error("共同任务当前修订未能与服务端固定签名对应；请回读任务。");
    return { ...frozen, task };
  }, { enabled: !!requested });
  const definition = current?.definition;
  const read = () => {
    const id = taskId.trim();
    if (requested === id) void source.refetch(); else setRequested(id);
  };
  // Like the old form (setSource(null) before every read): only a source read that just succeeded shows the form;
  // while rereading, or when the reread failed and the last answer is still cached, the form is hidden.
  const ready = requested && source.data && !source.isFetching && !source.isError ? source.data : null;
  const fields = [
    { name: "ownerTaskId", label: "负责这次评价的任务 ID", value: definition?.ownerTaskId ?? ownerTaskId ?? "" },
    { name: "question", label: "共同评价问题", kind: "textarea" as const, value: definition?.question ?? "" },
    { name: "commonInput", label: "两条件相同的执行指令", kind: "textarea" as const, value: definition?.case.commonInput ?? "" },
    { name: "criteria", label: "公开判定条件", kind: "textarea" as const, value: definition?.case.criteria ?? "" },
    { name: "protocol", label: "固定评价协议", kind: "textarea" as const, value: definition ? formatFixedRefs([definition.protocol]) : "", hint: "一行：document 或 git | 标识 | 固定修订 | SHA-256" },
    { name: "materials", label: "两条件共用的固定材料", kind: "textarea" as const, value: definition ? formatFixedRefs(definition.case.materials) : "", hint: "每行：document 或 git | 标识 | 固定修订 | SHA-256；至少一项" },
    { name: "wiki", label: "仅知识条件增加的固定 Wiki", kind: "textarea" as const, value: definition ? formatFixedRefs(definition.conditions[1].wikiRefs ?? []) : "", hint: "每行：wiki | 标识 | 固定修订 | SHA-256；至少一项。直接条件明确不适用 Wiki。" },
    { name: "model", label: "两个条件相同的明确模型", value: definition?.conditions[0].model ?? "" },
    { name: "cwd", label: "执行工作目录", value: definition?.conditions[0].environment.cwd ?? "", hint: "绝对路径；两条件相同" },
    { name: "authorizationScope", label: "授权工作范围", kind: "textarea" as const, value: definition?.conditions[0].environment.authorizationScope ?? "" },
    { name: "limits", label: "可比较性及工具隔离限制", kind: "textarea" as const, value: definition?.limits ?? "同一用户环境下工具访问隔离未验证；单例不能推断因果知识收益。" },
    ...(current ? [{ name: "reason", label: "修订定义的理由", kind: "textarea" as const, value: "" }] : []),
  ];
  const wikiRequired = !!ready?.sourceSignature.external.some(item => item.kind === "wiki");
  return <section aria-label={current ? "另存一版评价定义" : "建立冻结评价"} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-1.5">
      <p className={muted}>先读取当前进行中的共同任务。来源签名由服务端固定；下面只选择共同材料、知识条件和相同执行环境。创建定义不会自动运行或关闭任务。</p>
      <p className={muted}>新定义统一采用完整本机权限、无需逐次审批；两个条件使用相同配置。{current && "若旧定义采用其他权限，新修订会明确改为此配置；旧修订及其尝试保持原样。"}</p>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <Field label="共同任务 ID" className="min-w-0 flex-1 basis-72">{control =>
        <Input {...control} value={taskId} placeholder="进行中的任务 ID" autoComplete="off" onChange={event => { setTaskId(event.target.value); setRequested(null); }} />}</Field>
      <Button onClick={read} disabled={source.isFetching || !taskId.trim()}>{source.isFetching ? "读取中…" : "读取固定来源"}</Button>
    </div>
    {requested && source.isError && !source.isFetching && <Notice tone="error">共同任务没有读回：{errorText(source.error)}。重新读取成功之前不能冻结定义。<ErrorDetails error={source.error} /></Notice>}
    {ready && <>
      <div className="flex flex-col gap-1 rounded-lg bg-accent px-4 py-3">
        <p className="m-0 text-small text-foreground"><strong className="font-semibold">《{ready.task.task.title}》</strong> · 当前进行中修订已固定 · 固定依据 {ready.sourceSignature.basis.length} 项</p>
        <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">完整标识</summary>
          <p className="m-0 mt-1 break-all font-mono">来源任务修订 {ready.sourceTaskRevisionId}</p></details>
      </div>
      {wikiRequired
        ? <Notice tone="error">共同任务已要求 Wiki；直接条件不能移除必需来源，请先调整任务基线。</Notice>
        : <EvaluationForm key={`${current?.id ?? "create"}:${ready.sourceTaskRevisionId}`} collapsible={false} hold={hold}
          context={{ ...context, draftScope: `evaluation-definition:${current?.evaluationId ?? "new"}`, draftBaseline: `${current?.id ?? "create"}:${ready.sourceTaskRevisionId}` }}
          review title={current ? "冻结新定义修订" : "冻结评价定义"} fields={fields} build={values => {
            const next = definitionFromForm(values, { taskId: ready.task.task.id, sourceTaskRevisionId: ready.sourceTaskRevisionId, sourceSignature: ready.sourceSignature }, definition);
            return current
              ? { type: "evaluation.revise", evaluationId: current.evaluationId, revisionId: crypto.randomUUID(), expectedVersion: current.version, definition: next, reason: values.reason }
              : { type: "evaluation.create", evaluationId: crypto.randomUUID(), revisionId: crypto.randomUUID(), definition: next };
          }} onApplied={result => onApplied?.(result.entityId)} />}
    </>}
  </section>;
}
