// 建立冻结评价 / 另存一版评价定义. The common task is chosen by name and read first: the server fixes its source
// signature, and the form only chooses the shared materials, the Wiki condition and the one execution environment both
// conditions use. Tasks, documents, Wiki pages and their versions are chosen by name (DefinitionPickers); the fields
// keep the same values as before (a task ID, fixed-reference lines), so the command is the one typed IDs gave
// (definitionCommand). IDs, revisions and hashes stay under 完整标识.
import { useState } from "react";
import type { EvaluationRevision } from "@evoloop/contracts";
import { Button, Field, Notice } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { Field as FormField, MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { EvaluationForm } from "./EvaluationForm";
import { formatFixedRefs } from "./presentation";
import { definitionCommand } from "./formData";
import { FixedRefsChoice, TaskChoice } from "./DefinitionPickers";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const muted = "m-0 text-caption text-muted-foreground";

export function DefinitionForm({ context, current, ownerTaskId, onApplied, hold }: {
  context: MutationContext; current?: EvaluationRevision; ownerTaskId?: string; onApplied?: (evaluationId: string) => void; hold?: string | undefined;
}) {
  const projectId = context.projectId;
  const [taskId, setTaskId] = useState(current?.definition.case.taskId ?? "");
  const [requested, setRequested] = useState<string | null>(null);
  const source = useProjectQuery(projectId, ["evaluation-source", requested ?? ""], async () => {
    const id = requested!;
    const [frozen, task] = await Promise.all([api().evaluationSourceTask(projectId, id), api().task(projectId, id)]);
    if (task.task.id !== id || task.task.projectId !== projectId || task.task.state !== "in_progress" || task.revision.id !== frozen.sourceTaskRevisionId)
      throw new Error("共同任务当前修订未能与服务端固定签名对应；请回读任务。");
    return { ...frozen, task };
  }, { enabled: !!requested });
  const definition = current?.definition;
  const read = () => {
    if (requested === taskId) void source.refetch(); else setRequested(taskId);
  };
  // Like the old form (setSource(null) before every read): only a source read that just succeeded shows the form;
  // while rereading, or when the reread failed and the last answer is still cached, the form is hidden.
  const ready = requested && source.data && !source.isFetching && !source.isError ? source.data : null;
  const fields: FormField[] = [
    { name: "ownerTaskId", label: "负责这次评价的任务", kind: "custom", value: definition?.ownerTaskId ?? ownerTaskId ?? "",
      hint: "评价记在哪个任务下，按名称选择；可以就是共同任务。",
      render: ({ control, value, onChange }) => <TaskChoice projectId={projectId} control={control} label="负责这次评价的任务" value={value} onChange={onChange} /> },
    { name: "question", label: "共同评价问题", kind: "textarea", value: definition?.question ?? "" },
    { name: "commonInput", label: "两条件相同的执行指令", kind: "textarea", value: definition?.case.commonInput ?? "" },
    { name: "criteria", label: "公开判定条件", kind: "textarea", value: definition?.case.criteria ?? "" },
    { name: "protocol", label: "固定评价协议", kind: "custom", value: definition ? formatFixedRefs([definition.protocol]) : "",
      hint: "选一份文档和它的一个版本；文档以后再改，这次评价仍按所选版本。",
      render: ({ control, value, onChange }) => <FixedRefsChoice projectId={projectId} control={control} label="固定评价协议" value={value} onChange={onChange} allowed={["document", "git"]} single addLabel="选择协议文档" /> },
    { name: "materials", label: "两条件共用的固定材料", kind: "custom", value: definition ? formatFixedRefs(definition.case.materials) : "",
      hint: "至少一项，每项固定到所选版本。",
      render: ({ control, value, onChange }) => <FixedRefsChoice projectId={projectId} control={control} label="两条件共用的固定材料" value={value} onChange={onChange} allowed={["document", "git"]} addLabel="添加材料文档" /> },
    { name: "wiki", label: "仅知识条件增加的固定 Wiki", kind: "custom", value: definition ? formatFixedRefs(definition.conditions[1].wikiRefs ?? []) : "",
      hint: "至少一项，每项固定到所选版本。直接条件明确不用 Wiki。",
      render: ({ control, value, onChange }) => <FixedRefsChoice projectId={projectId} control={control} label="仅知识条件增加的固定 Wiki" value={value} onChange={onChange} allowed={["wiki"]} addLabel="添加 Wiki 页" /> },
    { name: "model", label: "两个条件相同的明确模型", value: definition?.conditions[0].model ?? "" },
    { name: "cwd", label: "执行工作目录", value: definition?.conditions[0].environment.cwd ?? "", hint: "绝对路径；两条件相同" },
    { name: "authorizationScope", label: "授权工作范围", kind: "textarea", value: definition?.conditions[0].environment.authorizationScope ?? "" },
    { name: "limits", label: "可比较性及工具隔离限制", kind: "textarea", value: definition?.limits ?? "同一用户环境下工具访问隔离未验证；单例不能推断因果知识收益。" },
    ...(current ? [{ name: "reason", label: "修订定义的理由", kind: "textarea" as const, value: "" }] : []),
  ];
  const wikiRequired = !!ready?.sourceSignature.external.some(item => item.kind === "wiki");
  return <section aria-label={current ? "另存一版评价定义" : "建立冻结评价"} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-1.5">
      <p className={muted}>先选择进行中的共同任务，读取它的固定来源。来源签名由服务端固定；下面只选择共同材料、知识条件和相同执行环境。创建定义不会自动运行或关闭任务。</p>
      <p className={muted}>新定义统一采用完整本机权限、无需逐次审批；两个条件使用相同配置。{current && "若旧定义采用其他权限，新修订会明确改为此配置；旧修订及其尝试保持原样。"}</p>
    </div>
    <div className="flex min-w-0 flex-col gap-2">
      <Field label="共同任务" hint="按名称搜索并选择一个进行中的任务；选中后读取它的固定来源。">{control =>
        <TaskChoice projectId={projectId} control={control} label="共同任务" value={taskId} inProgressOnly emptyText="已读的任务里没有进行中的任务。"
          onChange={id => { setTaskId(id); setRequested(id); }} />}</Field>
      {taskId && <Button className="w-fit" variant={ready ? "ghost" : "secondary"} onClick={read} disabled={source.isFetching}>
        {source.isFetching ? "读取中…" : requested === taskId ? "重新读取固定来源" : "读取固定来源"}</Button>}
    </div>
    {requested && source.isError && !source.isFetching && <Notice tone="error">共同任务没有读回：{errorText(source.error)}。重新读取成功之前不能冻结定义。<ErrorDetails error={source.error} /></Notice>}
    {ready && <>
      <div className="flex flex-col gap-1 rounded-lg bg-accent px-4 py-3">
        <p className="m-0 text-small text-foreground"><strong className="font-semibold">《{ready.task.task.title}》</strong> · 当前进行中修订已固定 · 固定依据 {ready.sourceSignature.basis.length} 项</p>
        <FullIdentifiers summary="完整标识" rows={[{ label: "共同任务", value: ready.task.task.id }, { label: "来源任务修订", value: ready.sourceTaskRevisionId }]} />
      </div>
      {wikiRequired
        ? <Notice tone="error">共同任务已要求 Wiki；直接条件不能移除必需来源，请先调整任务基线。</Notice>
        : <EvaluationForm key={`${current?.id ?? "create"}:${ready.sourceTaskRevisionId}`} collapsible={false} hold={hold}
          context={{ ...context, draftScope: `evaluation-definition:${current?.evaluationId ?? "new"}`, draftBaseline: `${current?.id ?? "create"}:${ready.sourceTaskRevisionId}` }}
          review title={current ? "冻结新定义修订" : "冻结评价定义"} fields={fields}
          build={values => definitionCommand(values, { taskId: ready.task.task.id, sourceTaskRevisionId: ready.sourceTaskRevisionId, sourceSignature: ready.sourceSignature }, current)}
          onApplied={result => onApplied?.(result.entityId)} />}
    </>}
  </section>;
}
