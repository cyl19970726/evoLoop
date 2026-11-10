// 承接智能体 in the task's right column: who concretely took the task, with assigned / accepted / running kept apart,
// and the binding form. Confirming acceptance and releasing stay in 运行与关联 with the full assignment history.
import React from "react";
import type { Task } from "@evoloop/contracts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { LeaderWorkRunFact } from "@evoloop/contracts/work-index";
import { AgentAvatar, Button, Field, Input, Notice, Select, StatusTag, Textarea } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { sessionClient } from "../../shared/sessionClient";
import { date } from "../../shared/ui/shared";
import { sessionHref } from "../sessions";
import { CommandFrame, overLimitText, useCommand } from "../../shared/command";
import { readAgent } from "./agentRead";
import { agentFacts, assignmentKey, type Read, type ReadState } from "./taskFactsPresentation";
import { assignmentSetCommand } from "./taskCommands";
import { taskOrigin } from "./taskOrigin";

const directoryPageLimit = 10;

/** Agents that may take this task: current members holding the task's Role whose activity can be observed. */
async function bindableAgents(projectId: string, role: string, signal: AbortSignal): Promise<{ items: ObservedSession[]; truncated: boolean }> {
  const client = sessionClient("", projectId);
  let page = await client.directory({}, signal), items = page.items, pages = 1;
  while (page.nextCursor && pages < directoryPageLimit) { page = await client.directory({ cursor: page.nextCursor }, signal); items = [...items, ...page.items]; pages++; }
  return { items: items.filter(item => item.roles?.some(entry => entry.id === role) && item.membership === "current" && item.capabilities?.observe.available), truncated: !!page.nextCursor };
}

export function TaskAgentBlock({ context, task, run, runtimeHref }: {
  context: MutationContext; task: Task; run: Read<LeaderWorkRunFact | null>; runtimeHref: string;
}) {
  const projectId = context.projectId;
  const assignmentRead = useProjectQuery(projectId, ["task", task.id, "assignment"], async signal => {
    const value = await sessionClient("", projectId).assignment(task.id, signal);
    if (value && (value.projectId !== projectId || value.taskId !== task.id)) throw new Error("分派响应与当前任务不符");
    return value;
  });
  // A failed reread keeps nothing to conclude from: the facts say 无法判断 and binding waits for a fresh read.
  const assignmentState: ReadState = assignmentRead.isPending ? "loading" : assignmentRead.isError ? "failed" : "ready";
  const assignment = assignmentState === "ready" ? assignmentRead.data ?? null : null;
  const key = assignment ? assignmentKey(assignment) : null;
  const agentRead = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key });
  const agent = agentRead.data;
  const agentName = agent?.profile?.displayName?.trim() || agent?.title || "";
  const [binding, setBinding] = React.useState(false);
  const facts = agentFacts(task, { state: assignmentState, value: assignment }, run);
  const closed = task.state === "done" || task.state === "cancelled";
  return <div className="flex flex-col gap-2.5" data-task-agent="">
    {assignmentRead.isPending && <p role="status" className="text-label text-muted-foreground">正在核对承接的智能体…</p>}
    {assignmentRead.error && <Notice tone="error" action={<Button size="compact" disabled={assignmentRead.isFetching} onClick={() => void assignmentRead.refetch()}>重新读取</Button>}>
      承接暂不可读取：{errorText(assignmentRead.error)}。这不表示无人承接。</Notice>}
    {assignmentState === "ready" && (assignment
      ? <div className="flex items-center gap-2.5">
        <AgentAvatar seed={key!} roleSeed={agent?.roles[0]?.id ?? task.owner} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">{agentName || (agentRead.error ? "智能体名称暂不可读" : agentRead.isPending ? "正在读取名称…" : "未登记名称的智能体")}</p>
          <p className="text-caption text-muted-foreground">{closed ? "历史承接" : assignment.target.kind === "owned" ? "项目内智能体" : "外部接入的智能体"} · 更新于 {date(assignment.updatedAt)}</p>
        </div>
        <a href={sessionHref(projectId, key!, taskOrigin(projectId, task, context.principal.actorId))} className="shrink-0 text-label text-primary hover:underline">进入对话</a>
      </div>
      : <p className="text-label text-text-secondary">尚未绑定具体的智能体。负责职责仍在任务上，但不能据此推定哪个智能体已接手。</p>)}
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
      {facts.map(fact => <React.Fragment key={fact.label}>
        <dt className="text-caption text-muted-foreground">{fact.label}</dt>
        <dd className="min-w-0"><StatusTag tone={fact.tone} label={fact.value} /></dd>
      </React.Fragment>)}
    </dl>
    {assignment?.ack && !closed && <p className="text-caption text-muted-foreground">{assignment.ack.method === "direct" ? "执行者本人确认" : "负责人观察到接手"} · {date(assignment.ack.at)}</p>}
    {!closed && task.state === "todo" && <p className="text-caption text-muted-foreground">任务开始后再绑定：开始会产生新的固定修订，之前的绑定和接手不会沿用。</p>}
    {task.state === "in_progress" && !binding && <div className="flex flex-wrap gap-2">
      <Button size="compact" disabled={assignmentState !== "ready"} title={assignmentState === "ready" ? undefined : "先读到当前分派，才能绑定或更换"}
        onClick={() => setBinding(true)}>{assignment && assignment.state !== "released" ? "更换智能体" : "绑定智能体"}</Button>
      <a href={runtimeHref} className="self-center text-label text-primary hover:underline">确认接手或释放</a>
    </div>}
    {task.state === "in_progress" && binding && assignmentState === "ready" && <BindAgentForm context={context} task={task} currentVersion={assignment?.version ?? 0}
      currentKey={assignment && assignment.state !== "released" ? key : null} onDone={() => setBinding(false)} />}
  </div>;
}

/** Binds the task to one agent of its role, or changes the binding; shared by the right column and 运行与关联. */
export function BindAgentForm({ context, task, currentVersion, currentKey, onDone }: {
  context: MutationContext; task: Task; currentVersion: number; currentKey: string | null; onDone(): void;
}) {
  const choicesRead = useProjectQuery(context.projectId, ["task", task.id, "bindable-agents", task.owner], signal => bindableAgents(context.projectId, task.owner, signal));
  const choices = choicesRead.data?.items ?? [];
  const [target, setTarget] = React.useState("");
  const [recipient, setRecipient] = React.useState("");
  const [reason, setReason] = React.useState("");
  // What the person saw when the form opened. If the task or its assignment changes meanwhile, the form refuses to
  // submit until they have looked at the latest content; the versions sent are always the ones they saw.
  // A version conflict rereads the project, so the latest assignment is on screen before the person decides.
  // Applied, now or when an unknown result is read back: the form folds away and the reread shows the binding.
  const command = useCommand(context, { taskVersion: task.version, assignmentVersion: currentVersion, currentKey: currentKey ?? "" },
    { onStale: context.onChanged, onApplied: onDone });
  const dirty = !!(target || recipient || reason);
  // The rule of every task form: an untouched form follows the latest content; a typed one waits for the person.
  React.useEffect(() => {
    if (!dirty && command.baselineChanged && !command.awaitingReread) command.rebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, command.baselineChanged, command.awaitingReread]);
  const [tried, setTried] = React.useState(false);
  async function submit() {
    setTried(true);
    const chosen = choices.find(item => item.key === target);
    if (!chosen || !reason.trim() || overLimitText(reason, 4000) || overLimitText(recipient, 240)) return;
    await command.submit(seen => assignmentSetCommand(task.id, seen, { target: chosen.target, recipientActorId: recipient, reason }));
  }
  return <CommandFrame context={context} command={command} label="绑定智能体" submitLabel="保存绑定" dirty={dirty} permission="review" className="p-3"
    onSubmit={() => void submit()} onCancel={onDone} cancelLabel="取消"
    onRefill={() => { command.rebase(); setTarget(""); setRecipient(""); setReason(""); }}
    onKeep={() => { command.rebase(); if (target === currentKey) setTarget(""); }}
    keepNote="上面的“承接智能体”已是最新读回；保留我的修改：选择、执行者和依据不变，按最新的分派核对。">
    {choicesRead.isPending && <p role="status" className="text-label text-muted-foreground">正在读取同一职责下可以承接的智能体…</p>}
    {choicesRead.error && <Notice tone="error">可选智能体暂不可读取：{errorText(choicesRead.error)}</Notice>}
    {choicesRead.data?.truncated && <Notice tone="waiting">智能体目录超过本次读取范围，下面只列出已读到的部分。</Notice>}
    {choicesRead.isSuccess && !choices.length && <p className="text-label text-text-secondary">没有读到承担本任务职责、且属于当前团队的智能体。可以先在团队分工里连接或归类智能体。</p>}
    {choices.length > 0 && <>
      <Field label="承接的智能体" error={tried && !target ? "请选择承接的智能体。" : undefined}>{control => <Select {...control} required value={target} onChange={event => setTarget(event.target.value)} className="w-full">
        <option value="">请选择</option>
        {choices.map(item => <option key={item.key} value={item.key} disabled={item.key === currentKey}>
          {(item.profile?.displayName?.trim() || item.title)}{item.kind === "external" ? " · 外部接入" : ""}{item.key === currentKey ? " · 当前" : ""}</option>)}
      </Select>}</Field>
      <Field label="指定执行者身份（可选）" hint="只填已核实的真实执行者身份；本人确认接手时按这个身份核验。" error={overLimitText(recipient, 240) ?? undefined}>{control => <Input {...control} value={recipient} onChange={event => setRecipient(event.target.value)} autoComplete="off" />}</Field>
      <Field label="分派依据" error={tried && !reason.trim() ? "请填写分派依据。" : overLimitText(reason, 4000) ?? undefined}>{control => <Textarea {...control} required value={reason} onChange={event => setReason(event.target.value)} rows={3} />}</Field>
    </>}
  </CommandFrame>;
}
