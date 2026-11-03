import { useEffect, useState } from "react";
import type { Task } from "@evoloop/contracts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import { errorText } from "../api";
import { ActionForm, option, type MutationContext } from "../workflow/ActionForm";
import { Alert, date } from "../ui/shared";
import { sessionClient } from "./client";
import { assignedObservedSession, sameSessionTarget } from "./assignmentEligibility";
import { SessionIdentityMark } from "./SessionIdentityMark";
import { sessionHref } from "./SessionNavigation";

export function TaskAssignmentPanel({ context, task, refresh }: { context: MutationContext; task: Task; refresh: number }) {
  const [assignment, setAssignment] = useState<TaskSessionAssignment | null>(null);
  const [sessions, setSessions] = useState<ObservedSession[]>([]);
  const [exactAssigned, setExactAssigned] = useState<{ target: SessionTarget; session: ObservedSession } | null>(null);
  const [exactReadError, setExactReadError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const client = sessionClient(context.token, context.projectId);
    let active = true;
    setLoading(true); setError(""); setExactReadError(""); setExactAssigned(null);
    void (async () => {
      try {
        const [current, first] = await Promise.all([client.assignment(task.id, controller.signal), client.directory({}, controller.signal)]);
        if (current && (current.projectId !== context.projectId || current.taskId !== task.id)) throw new Error("分派响应与当前任务不符");
        let items = first.items, cursor = first.nextCursor, pages = 1;
        while (cursor && pages < 10) {
          const page = await client.directory({ cursor }, controller.signal);
          items = [...items, ...page.items]; cursor = page.nextCursor; pages++;
        }
        const eligible = items.filter(item => item.roles.some(role => role.id === task.owner));
        let exact: { target: SessionTarget; session: ObservedSession } | null = null;
        if (current && !assignedObservedSession(current, context.projectId, task.id, eligible)) {
          const key = current.target.kind === "owned" ? `owned:${current.target.sessionId}` : `external:${current.target.linkId}`;
          try {
            const specific = (await client.snapshot(key, controller.signal)).session;
            if (specific.kind === current.target.kind && specific.roles.some(role => role.id === task.owner))
              exact = { target: current.target, session: specific };
            else if (active) setExactReadError("分派目标与会话职责不符，身份标记暂不显示。");
          } catch (cause) { if (active) setExactReadError(`分派目标会话未核实：${errorText(cause)}。`); }
        }
        if (!active) return;
        setAssignment(current); setSessions(eligible); setExactAssigned(exact); setTruncated(!!cursor);
      } catch (cause) { if (active) setError(errorText(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [context.token, context.projectId, task.id, task.owner, refresh, reload]);
  const selected = assignedObservedSession(assignment, context.projectId, task.id, sessions)
    ?? (assignment && exactAssigned && sameSessionTarget(exactAssigned.target, assignment.target)
      ? exactAssigned.session : undefined);
  const markedSession = !loading && !error && selected && selected.identity?.projectId === context.projectId
    && sameSessionTarget(selected.identity.target, selected.target) ? selected : null;
  const valid = assignment && assignment.state !== "released" && assignment.taskRevisionId === task.currentRevisionId;
  const choices = sessions.filter(item => item.membership === "current" && item.capabilities.observe.available);
  return <section className="panel" aria-label="具体 Session 分派"><div className="panel-head"><h2>具体 Session 承接</h2><button type="button" className="quiet" onClick={() => setReload(value => value + 1)}>重新读取</button></div>
    {loading && <p>正在核对分派与同角色 Session…</p>}
    {error && <Alert kind="error">分派暂不可读取：{error}。请重试；以下不表示无人接手。</Alert>}
    {exactReadError && <Alert>{exactReadError}</Alert>}
    {truncated && <Alert>会话目录超过本次读取范围。请先在 Session 目录缩小范围，再核对目标。</Alert>}
    {assignment && <div><p>{markedSession && <><SessionIdentityMark target={markedSession.target} identity={markedSession.identity} name={markedSession.title} size="small" /> </>}<strong>{selected?.title || "原承接 Session"}</strong> · {assignment.state === "accepted" ? valid ? "已接手" : "旧修订的接手记录" : assignment.state === "assigned" ? valid ? "已分派，待确认接手" : "旧修订的分派记录" : "已释放"} · {date(assignment.updatedAt)}</p>
      {selected && <a href={sessionHref(context.projectId, selected.key)}>查看该 Session 的工作区</a>}
      {assignment.ack && <p className="muted">{assignment.ack.method === "direct" ? "指定执行者本人确认" : "负责人观察到接手"} · {assignment.ack.evidence}</p>}
      {!valid && assignment.state !== "released" && <Alert>任务当前修订与分派固定修订不同，旧接手证据仍保留，但不能视为新修订已接手。</Alert>}
    </div>}
    {!loading && !error && !assignment && <p className="empty">尚未指定具体 Session。角色责任仍在任务上，但不能据此推定某个会话已接手。</p>}
    {task.state === "todo" && <p className="muted">建议先启动任务再指定 Session。启动会产生新的固定任务修订，旧分派和接手证据不能自动沿用。</p>}
    {choices.length > 0 && !error && task.state === "in_progress" && <ActionForm context={{ ...context, draftScope: `assignment:${task.id}`, draftBaseline: `${task.version}:${assignment?.version ?? 0}` }} review title={assignment?.state === "released" ? "重新指定 Session" : assignment ? "变更具体 Session" : "指定具体 Session"} fields={[
      { name: "target", label: "承接 Session", kind: "select", options: choices.map(item => option(item.key, `${item.title} · ${item.kind === "owned" ? "受管" : "外部"}`)) },
      { name: "recipientActorId", label: "指定执行者身份（可选）", optional: true, hint: "仅填写已核实的真实执行者身份；本人确认接手会按此身份核验。" },
      { name: "reason", label: "分派依据", kind: "textarea" },
    ]} build={v => ({ type: "task.assignment.set", taskId: task.id, expectedTaskVersion: task.version, expectedVersion: assignment?.version ?? 0,
      target: choices.find(item => item.key === v.target)!.target, recipientActorId: v.recipientActorId || null, reason: v.reason })} onApplied={() => setReload(value => value + 1)} />}
    {!loading && !choices.length && !error && task.state === "in_progress" && <p>当前未读到同一负责角色下可选的当前团队 Session。可先在团队分工中连接或归类会话。</p>}
    {assignment?.state === "assigned" && valid && <div>
      {assignment.recipientActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `assignment-ack:${task.id}`, draftBaseline: `${task.version}:${assignment.version}` }} title="本人确认接手" fields={[{ name: "evidence", label: "实际接手证据", kind: "textarea" }, { name: "sourceRef", label: "来源引用（可选）", optional: true }]} build={v => ({ type: "task.assignment.acknowledge", taskId: task.id, expectedVersion: assignment.version, expectedTaskVersion: task.version, evidence: v.evidence, sourceRef: v.sourceRef || null })} onApplied={() => setReload(value => value + 1)} />}
      <ActionForm context={{ ...context, draftScope: `assignment-observe:${task.id}`, draftBaseline: `${task.version}:${assignment.version}` }} review title="记录负责人观察到接手" fields={[{ name: "evidence", label: "实际观察与证据", kind: "textarea" }, { name: "sourceRef", label: "来源引用（可选）", optional: true }]} build={v => ({ type: "task.assignment.observeAcceptance", taskId: task.id, expectedVersion: assignment.version, expectedTaskVersion: task.version, evidence: v.evidence, sourceRef: v.sourceRef || null })} onApplied={() => setReload(value => value + 1)} />
    </div>}
    {assignment && assignment.state !== "released" && <ActionForm context={{ ...context, draftScope: `assignment-release:${task.id}`, draftBaseline: `${task.version}:${assignment.version}` }} review title="释放具体分派" fields={[{ name: "reason", label: "释放原因", kind: "textarea" }]} build={v => ({ type: "task.assignment.release", taskId: task.id, expectedVersion: assignment.version, reason: v.reason })} onApplied={() => setReload(value => value + 1)} />}
  </section>;
}
