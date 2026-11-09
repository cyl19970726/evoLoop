// 承接智能体 in the task's right column: who concretely took the task, with assigned / accepted / running kept apart,
// and the binding form. Confirming acceptance and releasing stay in 运行与关联 with the full assignment history.
import React from "react";
import type { Task } from "@evoloop/contracts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { AgentAvatar, Button, Field, Input, Notice, Select, StatusTag, Textarea } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { sessionClient } from "../../shared/sessionClient";
import { date } from "../../shared/ui/shared";
import { sessionHref } from "../sessions";
import { readAgent } from "./agentRead";
import { agentFacts, assignmentKey } from "./taskAgentPresentation";
import { useCommand } from "./useCommand";

const directoryPageLimit = 10;

/** Agents that may take this task: current members holding the task's Role whose activity can be observed. */
async function bindableAgents(projectId: string, role: string, signal: AbortSignal): Promise<{ items: ObservedSession[]; truncated: boolean }> {
  const client = sessionClient("", projectId);
  let page = await client.directory({}, signal), items = page.items, pages = 1;
  while (page.nextCursor && pages < directoryPageLimit) { page = await client.directory({ cursor: page.nextCursor }, signal); items = [...items, ...page.items]; pages++; }
  return { items: items.filter(item => item.roles?.some(entry => entry.id === role) && item.membership === "current" && item.capabilities?.observe.available), truncated: !!page.nextCursor };
}

export function TaskAgentBlock({ context, task, leader, leaderKnown, runtimeHref }: {
  context: MutationContext; task: Task; leader: LeaderWorkTask | null | undefined; leaderKnown: boolean; runtimeHref: string;
}) {
  const projectId = context.projectId;
  const assignmentRead = useProjectQuery(projectId, ["task", task.id, "assignment"], async signal => {
    const value = await sessionClient("", projectId).assignment(task.id, signal);
    if (value && (value.projectId !== projectId || value.taskId !== task.id)) throw new Error("分派响应与当前任务不符");
    return value;
  });
  const assignment = assignmentRead.data ?? null;
  const key = assignment ? assignmentKey(assignment) : null;
  const agentRead = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key });
  const agent = agentRead.data;
  const agentName = agent?.profile?.displayName?.trim() || agent?.title || "";
  const [binding, setBinding] = React.useState(false);
  const facts = agentFacts(task, assignment, leader?.latestRun, leaderKnown);
  const closed = task.state === "done" || task.state === "cancelled";
  return <div className="flex flex-col gap-2.5" data-task-agent="">
    {assignmentRead.isPending && <p role="status" className="text-label text-muted-foreground">正在核对承接的智能体…</p>}
    {assignmentRead.error && <Notice tone="error">承接暂不可读取：{errorText(assignmentRead.error)}。这不表示无人承接。</Notice>}
    {assignmentRead.isSuccess && (assignment
      ? <div className="flex items-center gap-2.5">
        <AgentAvatar seed={key!} roleSeed={agent?.roles[0]?.id ?? task.owner} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">{agentName || (agentRead.error ? "智能体名称暂不可读" : agentRead.isPending ? "正在读取名称…" : "未登记名称的智能体")}</p>
          <p className="text-caption text-muted-foreground">{closed ? "历史承接" : assignment.target.kind === "owned" ? "项目内智能体" : "外部接入的智能体"} · 更新于 {date(assignment.updatedAt)}</p>
        </div>
        <a href={sessionHref(projectId, key!)} className="shrink-0 text-label text-primary hover:underline">进入对话</a>
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
      <Button size="compact" onClick={() => setBinding(true)}>{assignment && assignment.state !== "released" ? "更换智能体" : "绑定智能体"}</Button>
      <a href={runtimeHref} className="self-center text-label text-primary hover:underline">确认接手或释放</a>
    </div>}
    {task.state === "in_progress" && binding && <BindAgentForm context={context} task={task} currentVersion={assignment?.version ?? 0}
      currentKey={assignment && assignment.state !== "released" ? key : null} onDone={() => setBinding(false)} />}
  </div>;
}

function BindAgentForm({ context, task, currentVersion, currentKey, onDone }: {
  context: MutationContext; task: Task; currentVersion: number; currentKey: string | null; onDone(): void;
}) {
  const choicesRead = useProjectQuery(context.projectId, ["task", task.id, "bindable-agents", task.owner], signal => bindableAgents(context.projectId, task.owner, signal));
  const choices = choicesRead.data?.items ?? [];
  const [target, setTarget] = React.useState("");
  const [recipient, setRecipient] = React.useState("");
  const [reason, setReason] = React.useState("");
  const command = useCommand({ ...context, draftScope: `assignment:${task.id}`, draftBaseline: `${task.version}:${currentVersion}` });
  const allowed = context.principal.permissions.includes("review");
  const dirty = !!(target || recipient || reason);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const chosen = choices.find(item => item.key === target);
    if (!chosen) return;
    const applied = await command.submit(() => ({ type: "task.assignment.set", taskId: task.id, expectedTaskVersion: task.version,
      expectedVersion: currentVersion, target: chosen.target, recipientActorId: recipient.trim() || null, reason: reason.trim() }));
    if (applied) onDone();
  }
  return <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg bg-muted p-3" data-dirty={dirty ? "true" : undefined} aria-label="绑定智能体">
    {choicesRead.isPending && <p role="status" className="text-label text-muted-foreground">正在读取同一职责下可以承接的智能体…</p>}
    {choicesRead.error && <Notice tone="error">可选智能体暂不可读取：{errorText(choicesRead.error)}</Notice>}
    {choicesRead.data?.truncated && <Notice tone="waiting">智能体目录超过本次读取范围，下面只列出已读到的部分。</Notice>}
    {choicesRead.isSuccess && !choices.length && <p className="text-label text-text-secondary">没有读到承担本任务职责、且属于当前团队的智能体。可以先在团队分工里连接或归类智能体。</p>}
    {choices.length > 0 && <>
      <Field label="承接的智能体">{control => <Select {...control} required value={target} onChange={event => setTarget(event.target.value)} className="w-full">
        <option value="">请选择</option>
        {choices.map(item => <option key={item.key} value={item.key} disabled={item.key === currentKey}>
          {(item.profile?.displayName?.trim() || item.title)}{item.kind === "external" ? " · 外部接入" : ""}{item.key === currentKey ? " · 当前" : ""}</option>)}
      </Select>}</Field>
      <Field label="指定执行者身份（可选）" hint="只填已核实的真实执行者身份；本人确认接手时按这个身份核验。">{control => <Input {...control} value={recipient} onChange={event => setRecipient(event.target.value)} autoComplete="off" />}</Field>
      <Field label="分派依据">{control => <Textarea {...control} required value={reason} onChange={event => setReason(event.target.value)} rows={3} />}</Field>
    </>}
    {!allowed && <p className="text-caption text-muted-foreground">当前身份没有审阅权限，不能绑定智能体。</p>}
    {context.blocked && <p className="text-caption text-muted-foreground">本项目仍有结果未确认的操作，请先核对回执。</p>}
    {command.outcome && <Notice tone={command.outcome.failed ? "error" : "info"}>{command.outcome.message}</Notice>}
    <div className="flex gap-2">
      <Button type="submit" variant="primary" size="compact" disabled={!allowed || context.blocked || command.busy || !target || !reason.trim()}>{command.busy ? "保存中…" : "保存绑定"}</Button>
      <Button size="compact" variant="ghost" onClick={onDone}>取消</Button>
    </div>
  </form>;
}
