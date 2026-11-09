import { useEffect, useState } from "react";
import { commandSchema, type Command, type TaskDetail } from "@evoloop/contracts";
import { api, errorText, type TaskTimingView } from "../../shared/api";
import { href } from "../../shared/ui/shared";
import { ActionForm, option, type Field, type MutationContext, type RecoverableCommand } from "../../shared/ActionForm";
import { formatScheduled, nextTimingLabel, repeatLabel, timingSetPayload, timingStopPayload, timingVersion } from "./taskTimingPresentation";

function validateTimingCommand(command: Record<string, unknown>) {
  commandSchema.parse(command);
}

function TimingFacts({ timing, projectId }: { timing: TaskTimingView; projectId: string }) {
  const stateLabels = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
  return <>
    <dl className="task-timing-facts">
      <div><dt>本次约定执行</dt><dd>{formatScheduled(timing.executeAtUtc, timing.timezone)}</dd></div>
      <div><dt>重复规则</dt><dd>{repeatLabel(timing.repeat)}{timing.repeat === "daily" ? ` · ${timing.seriesState === "active" ? "继续重复" : "已停止后续复制"}` : ""}</dd></div>
      <div><dt>后续复制</dt><dd>{nextTimingLabel(timing)}</dd></div>
      <div><dt>重复工作</dt><dd><code title={timing.seriesId}>{timing.seriesId.slice(0, 8)}</code> · 每份任务单独执行和验收</dd></div>
      {timing.repeat === "daily" && <div><dt>调度授权范围</dt><dd><code>task-timing:{timing.rootTaskId}</code></dd></div>}
      {timing.waitingReason && <div><dt>当前等待</dt><dd>{timing.waitingReason}</dd></div>}
    </dl>
    {(timing.previousTaskId || timing.nextTaskId) && <p>
      {timing.previousTaskId && <><a href={href(projectId, "task", timing.previousTaskId)}>上一份任务 →</a>{" · "}</>}
      {timing.nextTaskId && <a href={href(projectId, "task", timing.nextTaskId)}>后一份已生成任务 →</a>}
    </p>}
    {timing.occurrences?.length > 0 && <details><summary>同系列最近任务与各自状态（{timing.occurrences.length}）</summary>
      <ol>{timing.occurrences.map(item => <li key={item.taskId}>
        <a href={href(projectId, "task", item.taskId)}>{formatScheduled(item.executeAtUtc, timing.timezone)}</a> · {stateLabels[item.state]}
      </li>)}</ol></details>}
  </>;
}

export function TaskSchedulePanel({ context, detail, refresh }: { context: MutationContext; detail: TaskDetail; refresh: number }) {
  const { token, projectId } = context;
  const taskId = detail.task.id;
  const [read, setRead] = useState<{ projectId: string; taskId: string; timing: TaskTimingView | null; error: string } | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(null);
    api(token).taskTiming(projectId, taskId).then(timing => {
      if (live) setRead({ projectId, taskId, timing, error: "" });
    }).catch(cause => { if (live) setRead({ projectId, taskId, timing: null, error: errorText(cause) }); });
    return () => { live = false; };
  }, [token, projectId, taskId, refresh, again]);
  const current = read?.projectId === projectId && read.taskId === taskId ? read : null;
  const timing = current?.timing ?? null;
  let version: number | null = null;
  let versionError = "";
  if (current && !current.error) try { version = timingVersion(timing); } catch (cause) { versionError = errorText(cause); }
  const writable = !!current && !current.error && !versionError && version !== null;
  const formContext = { ...context, blocked: context.blocked || !writable,
    draftScope: `task-timing:${taskId}`, draftBaseline: `${detail.task.version}:${version ?? "unread"}:${timing?.executeAtUtc ?? ""}:${timing?.seriesState ?? ""}` };
  const canReview = context.principal.permissions.includes("review");
  const editableThis = detail.task.state === "todo";
  const fields: Field[] = [
    { name: "executeAtUtc", label: "约定执行时间（带 Z 或时区偏移的 ISO 8601）", value: timing?.executeAtUtc ?? "", hint: "例如 2026-11-07T08:00:00+08:00。每天按此时点换算到下方时区后的本地时分重复；秒须为 00。" },
    { name: "timezone", label: "重复使用的 IANA 时区", value: timing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Asia/Taipei" },
    { name: "reason", label: "调整理由", kind: "textarea" as const },
  ];
  const send = (command: Command | (Record<string, unknown> & RecoverableCommand)) => api(token).command(command as Command);
  return <section className="panel task-focus" id="task-schedule" aria-label="执行时间与重复任务">
    <div className="panel-head"><h2>执行时间与重复</h2><button type="button" className="quiet" onClick={() => setAgain(value => value + 1)}>重新读取</button></div>
    {!current && <p role="status">正在读取执行时间与重复规则…</p>}
    {(current?.error || versionError) && <p role="alert">执行时间暂不可核对：{current?.error || versionError}</p>}
    {current && !current.error && !versionError && <>
      {timing ? <TimingFacts timing={timing} projectId={projectId} /> : <p>这项普通任务尚未设置约定执行时间。</p>}
      {!editableThis && <p className="muted">本次任务已经开始或结束；本次执行依据保持固定。重复任务仍可修改后续要求或停止未来复制。</p>}
      {!timing && editableThis && <>
        <ActionForm context={formContext} title="设置本次执行时间" fields={fields} validateCommand={validateTimingCommand}
          sendCommand={send} build={v => timingSetPayload(taskId, detail.task.version, null,
            { executeAtUtc: v.executeAtUtc, timezone: v.timezone, repeat: "none", scope: "this", reason: v.reason })} onApplied={() => setAgain(value => value + 1)} />
        {canReview && <ActionForm context={formContext} review requiredPermissions={["write", "review"]} title="设置每天重复" fields={fields}
          validateCommand={validateTimingCommand} sendCommand={send}
          build={v => timingSetPayload(taskId, detail.task.version, null,
            { executeAtUtc: v.executeAtUtc, timezone: v.timezone, repeat: "daily", scope: "this_and_future", reason: v.reason })} onApplied={() => setAgain(value => value + 1)} />}
      </>}
      {timing?.repeat === "none" && editableThis && <ActionForm context={formContext} title="调整本次执行时间" fields={fields}
        validateCommand={validateTimingCommand} sendCommand={send}
        build={v => timingSetPayload(taskId, detail.task.version, timing,
          { executeAtUtc: v.executeAtUtc, timezone: v.timezone, repeat: "none", scope: "this", reason: v.reason })}
        onApplied={() => setAgain(value => value + 1)} />}
      {timing?.repeat === "none" && editableThis && canReview && <ActionForm context={formContext} review requiredPermissions={["write", "review"]}
        title="改为每天重复" fields={fields} validateCommand={validateTimingCommand} sendCommand={send}
        build={v => timingSetPayload(taskId, detail.task.version, timing,
          { executeAtUtc: v.executeAtUtc, timezone: v.timezone, repeat: "daily", scope: "this_and_future", reason: v.reason })}
        onApplied={() => setAgain(value => value + 1)} />}
      {timing?.repeat === "daily" && <>
        <ActionForm context={formContext} review requiredPermissions={["write", "review"]} title="调整执行时间与重复规则"
          fields={[...fields.slice(0, 2),
            { name: "repeat", label: "重复规则", kind: "select", value: timing.repeat, options: [option("none", "仅本次"), option("daily", "每天固定时间")] },
            { name: "scope", label: "修改范围", kind: "select", value: editableThis ? "this" : "future", options: [
              ...(editableThis ? [option("this", "只改本次（默认）"), option("this_and_future", "本次及后续")] : []),
              option("future", "仅后续；本次固定不变")] }, fields[2]]}
          validateCommand={validateTimingCommand} sendCommand={send}
          build={v => timingSetPayload(taskId, detail.task.version, timing,
            { executeAtUtc: v.executeAtUtc, timezone: v.timezone, repeat: v.repeat as "none" | "daily",
              scope: v.scope as "this" | "this_and_future" | "future", reason: v.reason })} onApplied={() => setAgain(value => value + 1)} />
        {timing.seriesState === "active" && <ActionForm context={formContext} review requiredPermissions={["write", "review"]} title="停止以后重复"
          fields={[{ name: "reason", label: "停止理由", kind: "textarea" }]} validateCommand={validateTimingCommand} sendCommand={send}
          build={v => timingStopPayload(taskId, timing, v.reason)}
          onApplied={() => setAgain(value => value + 1)} />}
        <p className="muted">停止只影响以后生成的任务；已经生成或正在执行的任务各自保留状态与结果。</p>
      </>}
      {timing?.repeat === "daily" && timing.seriesState === "active" && <SeriesPromptForm context={formContext} detail={detail} timing={timing} onApplied={() => setAgain(value => value + 1)} />}
    </>}
  </section>;
}

function SeriesPromptForm({ context, detail, timing, onApplied }: {
  context: MutationContext; detail: TaskDetail; timing: TaskTimingView; onApplied: () => void;
}) {
  const task = detail.task;
  const editableThis = task.state === "todo";
  return <div className="task-series-prompt"><h3>修改重复任务要求</h3>
    <p className="muted">已生成任务与固定执行依据不会随未来要求变化。</p>
    {editableThis && <ActionForm context={{ ...context, draftScope: `series-current-prompt:${task.id}` }} title="保存本次任务要求" review requiredPermissions={["write", "review"]}
      fields={[
        { name: "scope", label: "修改范围", kind: "select", value: "this",
          options: [option("this", "只改本次（默认）"), option("this_and_future", "本次及后续")] },
        { name: "title", label: "任务名称", value: task.title },
        { name: "content", label: "任务正文 / prompt", kind: "textarea", value: task.content },
        { name: "acceptance", label: "验收要求", kind: "textarea", value: task.acceptance },
        { name: "reason", label: "修改理由", kind: "textarea" },
      ]}
      validateCommand={command => { commandSchema.parse(command); }}
      build={v => {
        if (!v.reason.trim() || !v.title.trim() || !v.content.trim() || !v.acceptance.trim()) throw new Error("请填写完整任务要求与理由");
        if (v.scope !== "this" && v.scope !== "this_and_future") throw new Error("请选择本次修改范围");
        return { type: "task.update", taskId: task.id, expectedVersion: task.version,
          title: v.title, content: v.content, acceptance: v.acceptance, owner: task.owner, kind: task.kind,
          documentIds: detail.links.map(link => link.documentId),
          ...(detail.proposal ? { ...(detail.proposal.consumer ? { consumer: detail.proposal.consumer } : {}),
            useRequired: detail.proposal.useRequired, ...(detail.proposal.evidence ? { evidence: detail.proposal.evidence } : {}),
            ...(detail.proposal.stopCondition ? { stopCondition: detail.proposal.stopCondition } : {}) } : {}),
          repeatScope: v.scope, ...(v.scope === "this_and_future" ? { expectedTimingVersion: timing.version } : {}), reason: v.reason.trim() };
      }}
      sendCommand={command => api(context.token).command(command as unknown as Command)} onApplied={onApplied} />}
    <ActionForm context={{ ...context, draftScope: `series-future-prompt:${task.id}`, draftBaseline: `${timing.version}:${timing.futureTemplate.content}` }}
      title="只修改以后任务要求" review requiredPermissions={["write", "review"]}
      fields={[
        { name: "title", label: "以后任务名称", value: timing.futureTemplate.title },
        { name: "content", label: "以后任务正文 / prompt", kind: "textarea", value: timing.futureTemplate.content },
        { name: "acceptance", label: "以后验收要求", kind: "textarea", value: timing.futureTemplate.acceptance },
        { name: "reason", label: "修改理由", kind: "textarea" },
      ]}
      validateCommand={command => { commandSchema.parse(command); }}
      build={v => {
        if (!v.reason.trim() || !v.title.trim() || !v.content.trim() || !v.acceptance.trim()) throw new Error("请填写完整的以后任务要求与理由");
        return { ...timingSetPayload(task.id, task.version, timing,
          { executeAtUtc: timing.executeAtUtc, timezone: timing.timezone, repeat: timing.repeat, scope: "future", reason: v.reason }),
          title: v.title, content: v.content, acceptance: v.acceptance };
      }}
      sendCommand={command => api(context.token).command(command as Command)} onApplied={onApplied} />
  </div>;
}
