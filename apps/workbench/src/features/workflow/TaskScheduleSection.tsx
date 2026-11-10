// 执行时间与重复 (tasks.md 重开与重复): when this occurrence is to run and whether it repeats daily. Each repetition
// is its own task with its own result; editing changes this occurrence by default, “本次及后续” is chosen
// explicitly, and stopping the series is separate from cancelling one occurrence.
import React from "react";
import { commandSchema, type TaskDetail } from "@evoloop/contracts";
import { api, errorText, type TaskTimingView } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { href } from "../../shared/ui/shared";
import { CommandForm, type FormField } from "../../shared/command";
import { seriesCurrentPromptCommand, seriesFuturePromptCommand, taskStateLabel } from "./taskCommands";
import { ActionRow, Fact, Fine, ReadNote, TabSection, reasonField } from "./TaskForms";
import { formatScheduled, nextTimingLabel, repeatLabel, timingSetPayload, timingStopPayload, timingVersion, timingWaitingText } from "./taskTimingPresentation";

type Scope = "this" | "this_and_future" | "future";
// As the old forms: the shared schema checks the command, which is then sent exactly as built.
const timingOptions = { validate: (candidate: Record<string, unknown>) => { commandSchema.parse(candidate); } };

/** The timing read the task table also uses (same key). */
export function useTaskTiming(projectId: string, taskId: string) {
  return useProjectQuery(projectId, ["tasks", "timing", taskId], () => api().taskTiming(projectId, taskId));
}

/** One line for the task's text: when it is to run and whether it repeats. */
export function timingSummary(timing: TaskTimingView): string {
  return `${formatScheduled(timing.executeAtUtc, timing.timezone)} · ${repeatLabel(timing.repeat)}${timing.repeat === "daily" ? ` · ${nextTimingLabel(timing)}` : ""}`;
}

export function TaskScheduleSection({ context, detail }: { context: MutationContext; detail: TaskDetail }) {
  const projectId = context.projectId;
  const task = detail.task;
  const read = useTaskTiming(projectId, task.id);
  const timing = read.data ?? null;
  let version: number | null = null, versionError = "";
  if (read.data !== undefined) try { version = timingVersion(timing); } catch (cause) { versionError = errorText(cause); }
  const permissions = context.principal.permissions;
  const canWrite = permissions.includes("write"), canReview = canWrite && permissions.includes("review");
  const editableThis = task.state === "todo";
  // A failed reread keeps the last answer on screen but nothing is written from it.
  const writable = read.data !== undefined && !read.error && !versionError && version !== null;
  const baseline = { taskVersion: task.version, timingVersion: version ?? 0, executeAt: timing?.executeAtUtc ?? "", seriesState: timing?.seriesState ?? "" };
  const timingAt = (seen: typeof baseline) => timing ? { ...timing, version: seen.timingVersion } : null;
  const timeFields: FormField[] = [
    { name: "executeAtUtc", label: "约定执行时间", initial: timing?.executeAtUtc ?? "", placeholder: "2026-11-07T08:00:00+08:00",
      hint: "带 Z 或时区偏移的 ISO 8601 时间。每天重复时按下面的时区换算成本地时分，秒须为 00。" },
    { name: "timezone", label: "重复使用的时区", initial: timing?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei"), hint: "IANA 时区，例如 Asia/Shanghai。" },
  ];
  const set = (repeat: "none" | "daily", scope: Scope) => (values: Record<string, string>, seen: typeof baseline) =>
    timingSetPayload(task.id, seen.taskVersion, timingAt(seen), { executeAtUtc: values.executeAtUtc ?? "", timezone: values.timezone ?? "",
      repeat: (values.repeat as "none" | "daily" | undefined) ?? repeat, scope: (values.scope as Scope | undefined) ?? scope, reason: values.reason ?? "" });
  const actions: { key: string; title: string; description: string; needs: "write" | "review"; form: React.ReactNode }[] = [];
  if (writable && !timing && editableThis) {
    actions.push({ key: "set-once", title: "设置本次执行时间", description: "只这一次在约定时间执行。", needs: "write",
      form: <CommandForm context={context} options={timingOptions} submitLabel="保存执行时间" baseline={baseline} fields={[...timeFields, reasonField("调整理由")]} build={set("none", "this")} /> });
    actions.push({ key: "set-daily", title: "设置每天重复", description: "从本次起每天在同一时刻生成一份独立的任务。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="设置每天重复" baseline={baseline} fields={[...timeFields, reasonField("调整理由")]} build={set("daily", "this_and_future")} /> });
  }
  if (writable && timing?.repeat === "none" && editableThis) {
    actions.push({ key: "adjust-once", title: "调整本次执行时间", description: "只改这一次。", needs: "write",
      form: <CommandForm context={context} options={timingOptions} submitLabel="保存执行时间" baseline={baseline} fields={[...timeFields, reasonField("调整理由")]} build={set("none", "this")} /> });
    actions.push({ key: "make-daily", title: "改为每天重复", description: "从本次起每天生成一份独立的任务。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="改为每天重复" baseline={baseline} fields={[...timeFields, reasonField("调整理由")]} build={set("daily", "this_and_future")} /> });
  }
  if (writable && timing?.repeat === "daily") {
    actions.push({ key: "adjust-daily", title: "调整执行时间与重复规则", description: editableThis ? "默认只改本次；“本次及后续”要另选。" : "本次已开始或结束，只能改以后的。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="保存调整" baseline={baseline} build={set("daily", editableThis ? "this" : "future")} fields={[...timeFields,
        { name: "repeat", label: "重复规则", kind: "select", initial: timing.repeat, options: [{ value: "none", label: "仅本次" }, { value: "daily", label: "每天固定时间" }] },
        { name: "scope", label: "修改范围", kind: "select", initial: editableThis ? "this" : "future", options: [
          ...(editableThis ? [{ value: "this", label: "只改本次（默认）" }, { value: "this_and_future", label: "本次及后续" }] : []),
          { value: "future", label: "只改以后的；本次不变" }] },
        reasonField("调整理由")]} /> });
    if (timing.seriesState === "active") actions.push({ key: "stop", title: "停止以后重复", description: "只停止以后生成；已经生成或正在执行的任务各自保留。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="停止以后重复" danger baseline={baseline} fields={[reasonField("停止理由")]}
        build={(values, seen) => timingStopPayload(task.id, timingAt(seen)!, values.reason ?? "")} /> });
    if (timing.seriesState === "active" && editableThis) actions.push({ key: "prompt-this", title: "修改本次任务要求", description: "默认只改本次；可以选“本次及后续”。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="保存本次任务要求" baseline={baseline} fields={[
        { name: "scope", label: "修改范围", kind: "select", initial: "this", options: [{ value: "this", label: "只改本次（默认）" }, { value: "this_and_future", label: "本次及后续" }] },
        { name: "title", label: "任务名称", initial: task.title, maxLength: 240 },
        { name: "content", label: "任务正文", kind: "textarea", rows: 6, initial: task.content, maxLength: 65536 },
        { name: "acceptance", label: "验收要求", kind: "textarea", initial: task.acceptance, maxLength: 4000 },
        reasonField("修改理由")]}
        build={(values, seen) => seriesCurrentPromptCommand(detail, seen, { scope: values.scope ?? "", title: values.title ?? "",
          content: values.content ?? "", acceptance: values.acceptance ?? "", reason: values.reason ?? "" })} /> });
    if (timing.seriesState === "active") actions.push({ key: "prompt-future", title: "只修改以后的任务要求", description: "已生成的任务和它们固定的执行依据不变。", needs: "review",
      form: <CommandForm context={context} options={timingOptions} submitLabel="保存以后的任务要求" baseline={{ ...baseline, template: timing.futureTemplate.content }} fields={[
        { name: "title", label: "以后的任务名称", initial: timing.futureTemplate.title, maxLength: 4000 },
        { name: "content", label: "以后的任务正文", kind: "textarea", rows: 6, initial: timing.futureTemplate.content, maxLength: 65536 },
        { name: "acceptance", label: "以后的验收要求", kind: "textarea", initial: timing.futureTemplate.acceptance, maxLength: 4000 },
        reasonField("修改理由")]}
        build={(values, seen) => seriesFuturePromptCommand(task.id, seen, timing, { title: values.title ?? "", content: values.content ?? "",
          acceptance: values.acceptance ?? "", reason: values.reason ?? "" })} /> });
  }
  const shown = actions.filter(action => action.needs === "write" ? canWrite : canReview);
  const hidden = actions.length - shown.length;
  return <TabSection id="task-schedule" title="执行时间与重复">
    <ReadNote read={read} what="执行时间" />
    {versionError && <p role="alert" className="text-label text-destructive">执行时间暂不可核对：{versionError}</p>}
    {read.data !== undefined && (timing ? <TimingFacts projectId={projectId} timing={timing} />
      : <p className="text-label text-text-secondary">这项任务没有约定执行时间。</p>)}
    {read.data !== undefined && !editableThis && <Fine>本次任务已经开始或结束，本次的执行依据保持固定。{timing?.repeat === "daily" ? "仍可修改以后的要求或停止以后重复。" : ""}</Fine>}
    {shown.length > 0 && <div className="flex flex-col">{shown.map(action => <ActionRow key={action.key} title={action.title} description={action.description}>{action.form}</ActionRow>)}</div>}
    {hidden > 0 && <Fine>另有 {hidden} 项时间调整需要审阅权限，当前身份不能执行。</Fine>}
  </TabSection>;
}

function TimingFacts({ projectId, timing }: { projectId: string; timing: TaskTimingView }) {
  return <div className="flex flex-col gap-3">
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-compact:grid-cols-1">
      <Fact label="本次约定执行">{formatScheduled(timing.executeAtUtc, timing.timezone)}</Fact>
      <Fact label="重复规则">{repeatLabel(timing.repeat)}{timing.repeat === "daily" ? ` · ${timing.seriesState === "active" ? "继续重复" : "已停止以后生成"}` : ""}</Fact>
      <Fact label="以后生成">{nextTimingLabel(timing)}</Fact>
      <Fact label="每份任务">单独执行，单独验收</Fact>
      {timing.waitingReason && <Fact label="当前等待">{timingWaitingText(timing.waitingReason)}</Fact>}
    </div>
    {(timing.previousTaskId || timing.nextTaskId) && <p className="flex flex-wrap gap-x-4 text-label">
      {timing.previousTaskId && <a className="text-primary hover:underline" href={href(projectId, "task", timing.previousTaskId)}>上一份任务</a>}
      {timing.nextTaskId && <a className="text-primary hover:underline" href={href(projectId, "task", timing.nextTaskId)}>后一份已生成的任务</a>}
    </p>}
    {timing.occurrences?.length > 0 && <details><summary className="w-fit cursor-pointer text-label text-primary hover:underline">同系列最近的任务（{timing.occurrences.length}）</summary>
      <ol className="mt-2 flex flex-col gap-1">{timing.occurrences.map(item => <li key={item.taskId} className="text-label text-text-secondary">
        <a className="text-primary hover:underline" href={href(projectId, "task", item.taskId)}>{formatScheduled(item.executeAtUtc, timing.timezone)}</a> · {taskStateLabel[item.state]}
      </li>)}</ol></details>}
    <FullIdentifiers rows={[{ label: "重复系列", value: timing.seriesId }, { label: "等待原文", value: timing.waitingReason, text: true }, ...(timing.repeat === "daily" ? [{ label: "调度授权范围", value: `task-timing:${timing.rootTaskId}` }] : [])]} />
  </div>;
}
