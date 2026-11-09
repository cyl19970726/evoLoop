// The bottom of the agent page: the checklist of the running turn and the queued messages above the composer, the
// composer itself (Enter, Cmd/Ctrl+Enter, stop, / skills and commands, @ other agents), and one line of facts under it.
// What Enter does follows composerPlan; the commands are the ones the project already has (ordinary message,
// 即时输入, cancel, interrupt), each sent with a recovery receipt.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { WorkspaceEntry, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import {
  AgentAvatar, Button, Composer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, QueuedMessages, Textarea, TodoList,
  composerMenu, type ComposerAgent, type ComposerAttachment, type ComposerCommand,
} from "@evoloop/ui";
import { commandDrafts, type MutationContext } from "../../shared/ActionForm";
import { errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";
import { sessionClient } from "../../shared/sessionClient";
import type { SubmissionOutcome } from "../../shared/submissionOutcome";
import type { NativeProgressView } from "./NativeSessionPanel";
import { composerPlan, contextUseText, mentionedAgents, messageWithSkill } from "./composerPresentation";
import { latestPlan, planExplanation, planSteps } from "./conversationPresentation";
import { agentStatusLabel } from "./sessionStatusPresentation";
import { sendSessionCommand } from "./sessionCommand";
import { useDirectInput } from "./useDirectInput";

type Agent = ComposerAgent & { target: SessionTarget };
type Skill = { id: string; name: string; slug: string };
const skillSourceLabel: Record<string, string> = { evoloop: "evoLoop 业务", project: "项目", personal: "个人", builtin: "运行时内置" };

/** Where the running turn came from, for stopping it: an ordinary message (with its processing record) or a task's run. */
type TurnSource = { kind: "message" | "run"; id: string };

export function SessionComposer({ context, snapshot, entries, activeTurn, live, progress, facts, readingScope, onApplied }: {
  context: MutationContext; snapshot: SessionSnapshot; entries: WorkspaceEntry[]; activeTurn: WorkspaceTurn | undefined; live: boolean;
  progress: NativeProgressView | null; facts: string[]; readingScope: ReactNode; onApplied(): void;
}) {
  const { session } = snapshot;
  const { projectId, principal } = context;
  const owned = session.kind === "owned" && session.target.kind === "owned" ? session.target.sessionId : null;
  const draftKey = `${principal.actorId}:${projectId}:session-composer:${session.key}`;
  const [value, setValue] = useState(() => String((commandDrafts.get(draftKey)?.values as { content?: string } | undefined)?.content ?? ""));
  const [taskAttached, setTaskAttached] = useState(true);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [picked, setPicked] = useState<Agent[]>([]);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  useEffect(() => {
    setValue(String((commandDrafts.get(draftKey)?.values as { content?: string } | undefined)?.content ?? ""));
    setTaskAttached(true); setSkill(null); setPicked([]); setOutcome(null); setStopOpen(false);
  }, [draftKey]);
  const change = (next: string) => {
    setValue(next);
    if (next) commandDrafts.set(draftKey, { values: { content: next } }); else commandDrafts.delete(draftKey);
  };
  const direct = useDirectInput({ projectId, sessionId: owned ?? "", actorId: principal.actorId, active: !!owned, onAccepted: onApplied });
  const running = live && !!activeTurn || session.busy === true;
  const plan = composerPlan({
    kind: session.kind, canSave: session.capabilities.send.available, saveReason: session.capabilities.send.reason,
    direct: direct.capability, directPending: direct.pending, running, canWrite: principal.permissions.includes("write"), blocked: context.blocked,
  });

  // Messages I saved that are still waiting: they can be withdrawn until they are handled.
  const queued = entries.filter((entry): entry is Extract<WorkspaceEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "input"
    && entry.origin?.kind === "message" && entry.state === "pending" && entry.author.kind === "actor" && entry.author.id === principal.actorId);

  // The running turn's checklist: its latest plan entry, or the native observation's plan for the same turn.
  const todo = useMemo(() => {
    if (!live || !activeTurn) return null;
    const entry = latestPlan(entries, activeTurn.id);
    const steps = entry ? planSteps(entry.body) : null;
    if (entry && steps) return { items: steps, note: [planExplanation(entry.body), entry.freshness === "live" ? "" : "上次读回，当前待核对"].filter(Boolean).join(" · ") };
    const native = progress?.freshness === "live" && progress.plan?.turnId === activeTurn.id ? progress.plan : null;
    return native ? { items: native.steps.map(step => ({ text: step.step, status: step.status === "completed" ? "done" as const : step.status === "inProgress" ? "active" as const : "todo" as const })),
      note: native.explanation ?? "" } : null;
  }, [entries, activeTurn, live, progress]);

  const source: TurnSource | null = live && activeTurn
    ? activeTurn.origin && (activeTurn.origin.kind === "message" || activeTurn.origin.kind === "run") ? { kind: activeTurn.origin.kind, id: activeTurn.origin.id }
      : progress?.freshness === "live" && progress.turn?.id === activeTurn.id && progress.turn.source ? { kind: progress.turn.source.kind, id: progress.turn.source.id } : null
    : null;
  const mayStop = !!owned && !!source && principal.permissions.includes("review") && !context.blocked;
  const stopNote = !running ? null : !live || !activeTurn ? "这一轮的实时状态未读回，暂不能从这里停止"
    : !source ? "这一轮的来源未关联，不能从这里停止" : !principal.permissions.includes("review") ? "停止这一轮需要复核权限" : null;

  const menu = composerMenu(value);
  const roleId = owned ? session.roles[0]?.id : undefined;
  const skills = useProjectQuery(projectId, ["roles", roleId, "runtime"], async () => {
    const view = await roleClient("", projectId).runtime(roleId!);
    if (view.projectId !== projectId || view.roleId !== roleId) throw new Error("运行时响应与当前职责不符");
    return view;
  }, { enabled: !!roleId && menu?.kind === "command" });
  const directory = useProjectQuery(projectId, ["session-work", "directory", "current"], async signal => {
    const page = await sessionClient("", projectId).directory({ membership: "current" }, signal);
    if (!Array.isArray(page.items)) throw new Error("智能体目录响应不完整");
    return page;
  }, { enabled: menu?.kind === "mention" || picked.length > 0 });
  const agents: Agent[] = (directory.data?.items ?? []).filter(item => item.key !== session.key).map(item => ({
    id: item.key, name: item.title, target: item.target, state: agentStatusLabel(item),
    // A copy is saved as an ordinary message to that agent and handled in its order: never promised as delivered now.
    delivery: "queued", system: item.roles.length > 0 && item.roles.every(role => role.roleClass === "system"),
    avatar: <AgentAvatar seed={item.key} roleSeed={item.roles[0]?.id ?? item.title} size={28} />,
  }));
  const commands: ComposerCommand[] = [
    ...(skills.data?.skills ?? []).filter(item => item.selected).map(item => ({ id: `skill:${item.source}:${item.name}`, name: item.name,
      description: item.description ?? undefined, slug: skillSourceLabel[item.source] ?? item.source, kind: "skill" as const })),
    ...(mayStop && running ? [{ id: "stop", name: "停止这一轮", description: "中断正在进行的这一轮", slug: "/stop", kind: "command" as const }] : []),
    ...(queued.length ? [{ id: "withdraw", name: "撤回排队消息", description: "撤回最后一条还没处理的消息", slug: "/withdraw", kind: "command" as const }] : []),
    ...(snapshot.currentWork && !taskAttached ? [{ id: "task", name: "关联当前任务", description: snapshot.currentWork.title, slug: "/task", kind: "command" as const }] : []),
  ];
  const attachments: ComposerAttachment[] = [
    ...(snapshot.currentWork && taskAttached && session.kind === "owned" ? [{ id: "task", label: `关联任务 · ${snapshot.currentWork.title}`, kind: "task" as const }] : []),
    ...(skill ? [{ id: "skill", label: `技能 · ${skill.name}`, kind: "skill" as const }] : []),
  ];

  async function withdraw(messageId: string) {
    setOutcome(null);
    try {
      const detail = await sessionClient("", projectId).message(messageId);
      if (detail.message.id !== messageId || detail.message.projectId !== projectId) throw new Error("消息与当前智能体不符");
      if (!["queued", "manual_pending"].includes(detail.message.state)) { setOutcome({ text: "这条消息已经开始处理或已结束，不能再撤回。", failed: true }); onApplied(); return; }
      const result = await sendSessionCommand(context, { type: "session.message.cancel", messageId, expectedVersion: detail.message.version,
        reason: "发送者在输入框上方撤回了这条排队消息" });
      setOutcome({ text: result.applied ? "已撤回，正在读取消息记录。" : result.message, failed: result.failed });
      if (result.applied) onApplied();
    } catch (cause) { setOutcome({ text: `撤回前读取消息失败：${errorText(cause)}；没有撤回。`, failed: true }); }
  }

  async function deliver(action: "start" | "steer" | "post", text: string) {
    if (sending || !text.trim()) return;
    const content = messageWithSkill(text.trim(), skill);
    setSending(true); setOutcome(null);
    let result: SubmissionOutcome | null = null, sent = false;
    if (action === "post") {
      result = await sendSessionCommand(context, { type: "session.message.post", messageId: crypto.randomUUID(), target: session.target, content,
        ...(session.kind === "owned" && taskAttached && snapshot.currentWork ? { context: { taskId: snapshot.currentWork.id, taskRevisionId: snapshot.currentWork.revisionId } } : {}) });
      sent = result.applied;
    } else sent = await direct.send(content);
    // @: a copy of the same message to each agent still named in the text, saved as an ordinary message to it.
    const copies: string[] = [], failedCopies: string[] = [];
    if (sent) for (const agent of mentionedAgents(text, picked)) {
      const copy = await sendSessionCommand(context, { type: "session.message.post", messageId: crypto.randomUUID(), target: agent.target, content });
      (copy.applied ? copies : failedCopies).push(agent.name);
    }
    if (sent) { change(""); setSkill(null); setPicked([]); onApplied(); }
    const parts = [result ? result.message : sent ? "已送入运行时，正在读取记录。" : "",
      copies.length ? `已另发一份给 ${copies.join("、")}。` : "", failedCopies.length ? `另发给 ${failedCopies.join("、")} 没有成功，请在对方页面核对后重发。` : ""].filter(Boolean);
    setOutcome(parts.length ? { text: parts.join(""), failed: !!result?.failed || failedCopies.length > 0 } : null);
    setSending(false);
  }

  const queueCount = queued.length;
  const usage = contextUseText(progress?.usage);
  const meta = [...facts, ...(usage ? [usage] : []), ...(queueCount ? [`排队 ${queueCount} 条`] : []),
    ...(plan.hint ? [plan.hint] : []), ...(running && mayStop ? ["Esc 停止"] : stopNote && running ? [stopNote] : [])];
  return <div className="session-composer-host relative flex shrink-0 flex-col gap-2 pt-2">
    {todo && <TodoList items={todo.items} note={todo.note || undefined} />}
    {queued.length > 0 && <QueuedMessages items={queued.map(entry => ({ id: entry.origin!.id, text: entry.body || "（没有可公开的正文）" }))}
      note={running ? "这一轮结束后按顺序处理" : "按顺序处理"} onCancel={id => void withdraw(id)} />}
    {direct.receipt}
    {plan.disabledReason && <p role="status" className="text-caption text-muted-foreground">{plan.disabledReason}</p>}
    {outcome && <p role={outcome.failed ? "alert" : "status"} className={outcome.failed ? "text-caption text-destructive" : "text-caption text-muted-foreground"}>{outcome.text}</p>}
    <Composer
      value={value}
      onChange={change}
      label="消息"
      maxLength={16000}
      placeholder={plan.placeholder}
      disabled={!!plan.disabledReason}
      busy={sending || direct.busy || direct.pending}
      running={plan.running}
      sendMode={plan.sendMode}
      onSend={text => { if (plan.enter) void deliver(plan.enter, text); }}
      onQueue={plan.modEnter ? text => void deliver("post", text) : undefined}
      onStop={mayStop ? () => setStopOpen(true) : undefined}
      attachments={attachments}
      onRemoveAttachment={id => { if (id === "task") setTaskAttached(false); if (id === "skill") setSkill(null); }}
      commands={commands}
      skillScope={session.roles[0]?.title ? `${session.roles[0].title}可用` : undefined}
      onPickCommand={command => {
        if (command.kind === "skill") setSkill({ id: command.id, name: command.name, slug: command.slug });
        else if (command.id === "stop") setStopOpen(true);
        else if (command.id === "withdraw" && queued.at(-1)) void withdraw(queued.at(-1)!.origin!.id);
        else if (command.id === "task") setTaskAttached(true);
      }}
      agents={agents}
      onPickAgent={agent => { const found = agents.find(item => item.id === agent.id); if (found) setPicked(old => [...old.filter(item => item.id !== found.id), found]); }}
      meta={meta.map(item => <span key={item}>{item}</span>)}
    />
    {readingScope}
    {mayStop && source && <StopTurn context={context} sessionId={owned!} source={source} open={stopOpen} onOpenChange={setStopOpen}
      onStopped={() => { setStopOpen(false); onApplied(); }} />}
  </div>;
}

/** Stopping the running turn: the original message's processing or the task's run, with the reason the command needs. */
function StopTurn({ context, sessionId, source, open, onOpenChange, onStopped }: {
  context: MutationContext; sessionId: string; source: TurnSource; open: boolean; onOpenChange(open: boolean): void; onStopped(): void;
}) {
  const [reason, setReason] = useState("在智能体页手动停止这一轮");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function stop() {
    setBusy(true); setProblem("");
    try {
      let result: SubmissionOutcome;
      if (source.kind === "run") result = await sendSessionCommand(context, { type: "runtime.run.interrupt", runId: source.id, reason });
      else {
        const detail = await sessionClient("", context.projectId).message(source.id);
        const processing = detail.processing;
        if (detail.message.id !== source.id || !processing || processing.sessionId !== sessionId || !processing.nativeTurnId)
          throw new Error("这一轮的消息处理记录与当前智能体不符");
        result = await sendSessionCommand(context, { type: "session.message.interrupt", messageId: source.id, sessionId, processingId: processing.id,
          nativeTurnId: processing.nativeTurnId, expectedMessageVersion: detail.message.version, expectedProcessingVersion: processing.version, reason });
      }
      if (result.applied) onStopped(); else setProblem(result.message);
    } catch (cause) { setProblem(`停止前读取这一轮的来源失败：${errorText(cause)}；没有发送停止请求。`); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby="session-stop-description">
      <DialogTitle>停止这一轮</DialogTitle>
      <DialogDescription id="session-stop-description">{source.kind === "run" ? "请求中断这次任务运行。" : "请求中断正在处理这条消息的这一轮。"}是否停下以运行时的最终状态为准，已经做出的改动不会撤回。</DialogDescription>
      <Field label="停止原因">{control => <Textarea {...control} value={reason} maxLength={4000} onChange={event => setReason(event.target.value)} />}</Field>
      {problem && <p role="alert" className="text-small text-destructive">{problem}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void stop()}>{busy ? "正在请求…" : "停止这一轮"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
