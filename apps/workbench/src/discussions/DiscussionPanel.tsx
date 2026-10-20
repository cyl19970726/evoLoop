import { useEffect, useRef, useState } from "react";
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget, Document, Goal, Page, Stage, Task } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { api, errorText, request, safeArtifactHref } from "../api";
import { roleClient } from "../roles/client";
import { ActionForm, Notice, option, reasonField, type Field, type MutationContext } from "../workflow/ActionForm";

type Choices = { goals: Goal[]; stages: Stage[]; tasks: Task[]; documents: Document[]; roles: RoleRecord[] };
const emptyChoices: Choices = { goals: [], stages: [], tasks: [], documents: [], roles: [] };
const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const safeSessionRef = (value: string, projectId: string) =>
  !!safeArtifactHref(value, projectId) || /^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(value.trim());
export function discussionCopyEnvelope(origin: string, projectId: string, documentId: string, revisionId: string, body: string): string {
  const fixed = `${origin}/#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revisionId)}`;
  return `工作台入口：${origin}/\n固定原件入口：${fixed}\n以下正文才是被 SHA-256 核对的原件；此定位封套在复制时添加，不属于原件哈希。\n\n${body}`;
}
const statusLabel: Record<DiscussionRecord["status"], string> = {
  prepared: "交接包已准备，待人工承接", handed_off: "已人工登记承接观察",
  decided: "已登记讨论决定", linked: "已链接后续对象",
};
const kindLabel: Record<DiscussionRecord["kind"], string> = { allocation: "讨论当前分工", direction: "讨论下一阶段" };

async function complete<T>(label: string, load: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const values: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    values.push(...page.items);
    if (values.length > 1000 || (values.length === 1000 && page.nextCursor))
      throw new Error(`${label}超过 1000 项，无法完整提供选择；请缩小项目范围。`);
    if (!page.nextCursor) return values;
    if (seen.has(page.nextCursor)) throw new Error(`${label}分页游标重复，无法确认选择完整。`);
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}

export function DiscussionPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [items, setItems] = useState<DiscussionRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<DiscussionRecord | null>(null);
  const [events, setEvents] = useState<DiscussionEvent[]>([]);
  const [choices, setChoices] = useState<Choices>(emptyChoices);
  const [choicesLoading, setChoicesLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [choicesError, setChoicesError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const listEpoch = useRef(0);
  useEffect(() => { setSelectedId(""); }, [context.token, context.projectId]);
  useEffect(() => {
    let active = true; const epoch = ++listEpoch.current;
    setLoading(true); setError(""); setItems([]); setNextCursor(null);
    api(context.token).discussions(context.projectId)
      .then(page => { if (active && listEpoch.current === epoch) { setItems(page.items); setNextCursor(page.nextCursor); } })
      .catch(cause => { if (active && listEpoch.current === epoch) setError(errorText(cause)); })
      .finally(() => { if (active && listEpoch.current === epoch) setLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  useEffect(() => {
    let active = true; setChoices(emptyChoices); setChoicesLoading(true); setChoicesError("");
    const client = api(context.token), roles = roleClient(context.token, context.projectId);
    Promise.all([
      complete("目标", cursor => client.goals(context.projectId, cursor)),
      client.stages(context.projectId),
      complete("任务", cursor => client.tasks(context.projectId, cursor)),
      complete("过程文档", cursor => client.documents(context.projectId, cursor)),
      complete("职责", cursor => roles.list(cursor)),
    ]).then(([goals, stages, tasks, documents, roleItems]) => {
      if (active) setChoices({ goals, stages, tasks, documents, roles: roleItems });
    }).catch(cause => { if (active) setChoicesError(errorText(cause)); })
      .finally(() => { if (active) setChoicesLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  useEffect(() => {
    if (!selectedId) { setSelected(null); setEvents([]); return; }
    let active = true; setSelected(null); setEvents([]); setDetailError("");
    const client = api(context.token);
    Promise.all([client.discussion(context.projectId, selectedId), client.discussionEvents(context.projectId, selectedId)])
      .then(([record, history]) => { if (active) { setSelected(record); setEvents(history); } })
      .catch(cause => { if (active) setDetailError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, selectedId, refresh]);
  async function more() {
    if (!nextCursor || moreBusy) return;
    const epoch = listEpoch.current; setMoreBusy(true); setError("");
    try {
      const page = await api(context.token).discussions(context.projectId, nextCursor);
      if (epoch === listEpoch.current) {
        setItems(previous => [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()]);
        setNextCursor(page.nextCursor);
      }
    } catch (cause) { if (epoch === listEpoch.current) setError(errorText(cause)); }
    finally { if (epoch === listEpoch.current) setMoreBusy(false); }
  }
  return <section className="panel discussion-panel"><div className="panel-head"><h2>负责人讨论与交接</h2><button type="button" onClick={context.onChanged}>回读讨论</button></div>
    <p>从固定的项目材料准备已有会话的讨论包。准备不表示桌面会话已收到；人工观察、决定、对象变更与实际使用分别登记。</p>
    {choicesError && <Notice error>无法完整读取选择对象：{choicesError}。暂不生成交接包。</Notice>}
    {choicesLoading && <p>正在读取可固定的目标与来源…</p>}
    {!choicesLoading && !choicesError && choices.goals.length > 0 && <PrepareDiscussion context={context} choices={choices} onPrepared={setSelectedId} />}
    {!choicesLoading && !choicesError && !choices.goals.length && <p className="empty">先建立真实目标，才能固定讨论范围。</p>}
    <h3>已有讨论</h3>{loading && <p>正在读取讨论列表…</p>}{error && <Notice error>{error}</Notice>}
    {!loading && items.length === 0 && <p className="empty">尚无讨论交接包。没有新取舍时无需制造任务或常设职责。</p>}
    <div className="discussion-list">{items.map(item => <button type="button" key={item.id} className={item.id === selectedId ? "active" : ""} onClick={() => setSelectedId(item.id)}>
      <strong>{kindLabel[item.kind]}</strong><span>{item.question}</span><small>{statusLabel[item.status]} · v{item.version}</small>
    </button>)}</div>
    {nextCursor && <button type="button" className="more" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "加载中…" : "加载更多讨论"}</button>}
    {detailError && <Notice error>讨论详情或事件不可读：{detailError}。不能据列表状态提交后续动作。</Notice>}
    {selected && <DiscussionDetail key={`${selected.id}:${selected.version}`} context={context} record={selected} events={events} choices={choices} />}
  </section>;
}

function PrepareDiscussion({ context, choices, onPrepared }: { context: MutationContext; choices: Choices; onPrepared(id: string): void }) {
  const [kind, setKind] = useState<DiscussionRecord["kind"]>("allocation");
  const fields: Field[] = [
    { name: "title", label: "交接包标题" }, { name: "goalId", label: "固定目标", kind: "select", options: choices.goals.map(goal => option(goal.id, `${goal.outcome} · v${goal.version}`)) },
    { name: "stageId", label: "关联阶段（可选）", kind: "select", optional: true, options: choices.stages.map(stage => option(stage.id, `${stage.deliverable} · v${stage.version}`)) },
    { name: "taskId", label: "关联任务（可选）", kind: "select", optional: true, options: choices.tasks.map(task => option(task.id, `${task.title} · v${task.version}`)) },
    { name: "documentIds", label: "已采纳过程文档（可多选）", kind: "multi", optional: true, options: choices.documents.filter(document => !!document.adoptedRevisionId).map(document => option(document.id, document.title)) },
    { name: "question", label: "本次要讨论的具体问题", kind: "textarea" },
    { name: "options", label: "备选做法（每行一项，最多十项）", kind: "textarea" },
    { name: "authorizationBoundary", label: "授权与不能自行决定的边界", kind: "textarea" },
    { name: "targetSessionLabel", label: "拟交接的已有会话名称" },
    { name: "targetSessionRef", label: "已有会话的安全引用（可选）", optional: true, hint: "只接受本项目页面、http(s) 地址或固定 codex://threads/<ID>；记录引用不表示已送达。" },
    { name: "body", label: "补充上下文（固定来源由服务生成）", kind: "textarea", optional: true },
  ];
  return <details className="workflow-detail"><summary>准备负责人讨论</summary>
    <div className="actions"><button type="button" className={kind === "allocation" ? "primary" : ""} onClick={() => setKind("allocation")}>讨论当前分工</button>
      <button type="button" className={kind === "direction" ? "primary" : ""} onClick={() => setKind("direction")}>讨论下一阶段</button></div>
    <p className="muted">固定所见目标版本、可选阶段/任务及已采纳文档。系统生成完整来源头；正文只补充本次问题。</p>
    <ActionForm context={context} title="生成固定交接包" fields={fields} build={values => {
      const goal = choices.goals.find(item => item.id === values.goalId);
      const stage = choices.stages.find(item => item.id === values.stageId);
      const task = choices.tasks.find(item => item.id === values.taskId);
      const documents = (JSON.parse(values.documentIds || "[]") as string[]).map(id => choices.documents.find(item => item.id === id));
      if (!goal || values.stageId && (!stage || stage.goalId !== goal.id) || values.taskId && !task || documents.some(item => !item?.adoptedRevisionId)) throw new Error("关联对象不一致");
      if (values.targetSessionRef && !safeSessionRef(values.targetSessionRef, context.projectId)) throw new Error("会话引用不安全");
      return { type: "discussion.prepare", discussionId: crypto.randomUUID(), documentId: crypto.randomUUID(), kind,
        title: values.title, body: values.body ?? "", goal: { id: goal.id, version: goal.version },
        ...(stage ? { stage: { id: stage.id, version: stage.version } } : {}),
        ...(task ? { task: { id: task.id, revisionId: task.currentRevisionId } } : {}),
        adoptedDocuments: documents.map(item => ({ documentId: item!.id, revisionId: item!.adoptedRevisionId! })),
        question: values.question, options: lines(values.options || ""), authorizationBoundary: values.authorizationBoundary,
        targetSessionLabel: values.targetSessionLabel, ...(values.targetSessionRef ? { targetSessionRef: values.targetSessionRef } : {}),
      };
    }} onApplied={result => onPrepared(result.entityId)} />
  </details>;
}

function DiscussionDetail({ context, record, events, choices }: { context: MutationContext; record: DiscussionRecord; events: DiscussionEvent[]; choices: Choices }) {
  const [verifiedCurrentRevisionId, setVerifiedCurrentRevisionId] = useState<string | null>(null);
  const currentVerified = verifiedCurrentRevisionId === record.currentDocumentRevisionId;
  const latestDecision = events.filter(event => event.kind === "decision" && event.id === record.latestDecisionEventId)[0];
  const superseded = new Set(events.flatMap(event => event.supersedesDecisionEventId ? [event.supersedesDecisionEventId] : []));
  const targetChoices = [
    ...choices.tasks.map(task => ({ value: `task:${task.id}`, label: `任务：${task.title} · v${task.version}`, target: { kind: "task" as const, id: task.id, revisionId: task.currentRevisionId } })),
    ...choices.stages.map(stage => ({ value: `stage:${stage.id}`, label: `阶段：${stage.deliverable} · v${stage.version}`, target: { kind: "stage" as const, id: stage.id, version: stage.version } })),
    ...choices.roles.map(role => ({ value: `role:${role.id}`, label: `职责：${role.proposal.title} · ${role.state}`, target: { kind: "role" as const, id: role.id, revisionId: role.currentRevisionId } })),
    ...choices.documents.map(document => ({ value: `document:${document.id}`, label: `过程文档：${document.title} · 当前 v${document.version}`, target: { kind: "document" as const, id: document.id, revisionId: document.currentRevisionId } })),
  ];
  const decisionFields: Field[] = [
    { name: "choice", label: "本次取舍（也可明确维持现状）", kind: "textarea" },
    { name: "unresolved", label: "未解决的问题", kind: "textarea" },
    { name: "relookCondition", label: "重看条件", kind: "textarea" },
    { name: "evidence", label: "讨论证据与实际观察", kind: "textarea" }, reasonField,
  ];
  return <div className="discussion-detail"><h3>{kindLabel[record.kind]} · {statusLabel[record.status]}</h3>
    <p><strong>问题：</strong>{record.question}</p><p><strong>备选：</strong>{record.options.join("；")}</p>
    <p><strong>授权边界：</strong>{record.authorizationBoundary}</p><p>拟交接已有会话：{record.targetSessionLabel}
      {record.targetSessionRef && safeArtifactHref(record.targetSessionRef, context.projectId) && <> · <a href={safeArtifactHref(record.targetSessionRef, context.projectId)!} target="_blank" rel="noopener noreferrer">打开安全引用</a></>}
      {record.targetSessionRef && !safeArtifactHref(record.targetSessionRef, context.projectId) && <> · <code>{record.targetSessionRef}</code></>}</p>
    <p className="muted">讨论 v{record.version}；包内过程文档修订固定，后续事件追加新修订，旧包仍可回读。</p>
    <PackageReader context={context} record={record} revisionId={record.preparedDocumentRevisionId} label="最初准备的固定交接包"
      onVerified={record.currentDocumentRevisionId === record.preparedDocumentRevisionId ? setVerifiedCurrentRevisionId : undefined} />
    {record.currentDocumentRevisionId !== record.preparedDocumentRevisionId && <PackageReader context={context} record={record} revisionId={record.currentDocumentRevisionId} label="当前事件后的固定交接包" onVerified={setVerifiedCurrentRevisionId} />}
    {!currentVerified && <Notice error>当前固定交接包尚未完整核验，或原件不可读取。先读回当前修订并核对哈希，才能登记承接、决定或行动链接。</Notice>}
    {currentVerified && record.status === "prepared" && <ActionForm key={`handoff:${record.version}`} context={context} title="登记人工承接观察" fields={[
      { name: "evidence", label: "实际如何观察到已有会话承接", kind: "textarea", hint: "仅登记人工观察，不证明桌面自动投递或对方完成阅读。" }, reasonField,
    ]} build={values => ({ type: "discussion.handoff.record", discussionId: record.id, expectedVersion: record.version,
      documentRevisionId: record.currentDocumentRevisionId, ...values })} />}
    {currentVerified && record.status !== "prepared" && <details className="workflow-detail"><summary>{latestDecision ? "追加讨论决定纠正" : "登记讨论决定"}</summary>
      {latestDecision && <p>将明确纠正当前决定 <code>{latestDecision.id}</code>；旧决定与已链接对象仍保留历史，不会自动撤销行动。</p>}
      <ActionForm key={`decision:${record.version}:${record.latestDecisionEventId ?? "first"}`} context={context} review title={latestDecision ? "保存决定纠正" : "保存讨论决定"} fields={decisionFields}
        build={values => ({ type: "discussion.decision.record", discussionId: record.id, expectedVersion: record.version,
          documentRevisionId: record.currentDocumentRevisionId, ...values,
          ...(latestDecision ? { supersedesDecisionEventId: latestDecision.id } : {}) })} />
    </details>}
    {currentVerified && latestDecision && targetChoices.length > 0 && <details className="workflow-detail"><summary>链接实际后续对象</summary>
      <p>只链接已经存在且可读取的对象；讨论决定本身不会创建任务、阶段或常设职责。</p>
      <ActionForm key={`action:${record.version}:${latestDecision.id}`} context={context} review title="登记行动链接" fields={[
        { name: "target", label: "实际后续对象", kind: "select", options: targetChoices.map(item => option(item.value, item.label)) }, reasonField,
      ]} build={values => {
        const selected = targetChoices.find(item => item.value === values.target);
        if (!selected) throw new Error("目标对象未核实");
        return { type: "discussion.action.link", discussionId: record.id, expectedVersion: record.version,
          decisionEventId: latestDecision.id, target: selected.target, reason: values.reason };
      }} />
    </details>}
    <h3>不可变事件</h3>{events.length === 0 && <Notice error>事件历史为空；不能据摘要判断过程完整。</Notice>}
    {events.map(event => <article className="decision" key={event.id}><strong>{event.kind} · v{event.version}{superseded.has(event.id) ? " · 已被纠正" : ""}</strong>
      {event.choice && <p>取舍：{event.choice}</p>}{event.evidence && <p>证据：{event.evidence}</p>}{event.reason && <p>理由：{event.reason}</p>}
      {event.unresolved && <p>未解：{event.unresolved}</p>}{event.relookCondition && <p>重看条件：{event.relookCondition}</p>}
      {event.target && <DiscussionTargetLink target={event.target} choices={choices} projectId={context.projectId} />}
      {event.documentRevisionId && <p><a href={`#/p/${context.projectId}/documents/${record.documentId}?revision=${encodeURIComponent(event.documentRevisionId)}`}>阅读当次固定过程文档 →</a></p>}
      <small>{event.actorId} · {event.createdAt}</small>
    </article>)}
  </div>;
}

function DiscussionTargetLink({ target, choices, projectId }: { target: DiscussionTarget; choices: Choices; projectId: string }) {
  const id = encodeURIComponent(target.id);
  if (target.kind === "task") {
    const task = choices.tasks.find(item => item.id === target.id);
    return <p>实际后续任务：{task?.title ?? "名称暂不可读"} · 固定修订 <code>{target.revisionId}</code> · <a href={`#/p/${projectId}/tasks/${id}?revision=${encodeURIComponent(target.revisionId)}`}>阅读任务固定修订 →</a></p>;
  }
  if (target.kind === "document") {
    const document = choices.documents.find(item => item.id === target.id);
    return <p>实际后续过程文档：{document?.title ?? "名称暂不可读"} · 固定修订 <code>{target.revisionId}</code> · <a href={`#/p/${projectId}/documents/${id}?revision=${encodeURIComponent(target.revisionId)}`}>阅读目标文档固定原件 →</a></p>;
  }
  if (target.kind === "stage") {
    const stage = choices.stages.find(item => item.id === target.id);
    return <p>实际后续阶段：{stage?.deliverable ?? "名称暂不可读"} · 固定 v{target.version} · <a href={`#/p/${projectId}/overview`}>返回当前项目总览（不是固定历史） →</a></p>;
  }
  const role = choices.roles.find(item => item.id === target.id);
  return <p>实际后续职责：{role?.proposal.title ?? "名称暂不可读"} · 固定修订 <code>{target.revisionId}</code> · <a href={`#/p/${projectId}/work`}>返回当前工作区（不是固定历史） →</a></p>;
}

function PackageReader({ context, record, revisionId, label, onVerified }: { context: MutationContext; record: DiscussionRecord; revisionId: string; label: string; onVerified?: (revisionId: string | null) => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true; setBody(null); setError(""); setCopied(false);
    onVerified?.(null);
    void (async () => {
      if (onVerified) {
        const current = await api(context.token).document(context.projectId, record.documentId);
        if (current.document.currentRevisionId !== revisionId) throw new Error("交接包的当前文档指针已变化，请回读讨论状态");
      }
      const revision = await api(context.token).documentRevision(context.projectId, record.documentId, revisionId);
      let content = revision.body;
      if (content === null) {
        const original = await request<{ status: string; body?: string; assets?: unknown[] }>(context.token,
          `/api/projects/${encodeURIComponent(context.projectId)}/documents/${encodeURIComponent(record.documentId)}/revisions/${encodeURIComponent(revisionId)}/original`, 15000);
        if (original.status !== "available" || typeof original.body !== "string" || original.assets?.length)
          throw new Error("固定原件或资源不可完整读取");
        content = original.body;
      }
      if (revision.format !== "markdown" || content === null) throw new Error("交接包不是完整 Markdown 原文");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== revision.contentHash) throw new Error("交接包固定原文哈希不匹配");
      if (active) { setBody(content); onVerified?.(revisionId); }
    })().catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, record.documentId, revisionId]);
  async function copy() {
    if (body === null) return;
    try { await navigator.clipboard.writeText(discussionCopyEnvelope(window.location.origin, context.projectId, record.documentId, revisionId, body)); setCopied(true); }
    catch { setError("剪贴板不可用；请从下方完整原文手动选择复制。"); }
  }
  return <details className="workflow-detail"><summary>{label} · <code>{revisionId.slice(0, 8)}</code></summary>
    {error && <Notice error>{error}</Notice>}
    {body === null && !error && <p>正在核对完整原文与哈希…</p>}
    {body !== null && <><p>复制时会在原文前加入工作台入口与固定文档链接作为定位封套；原件哈希只核下方正文。复制不表示对方收到、阅读或同意。</p>
      <button type="button" onClick={() => void copy()}>{copied ? "已复制完整包" : "复制完整包"}</button>
      <pre className="discussion-package">{body}</pre></>}
  </details>;
}
