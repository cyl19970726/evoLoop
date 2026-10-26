import { ArrowLeft } from "lucide-react";
import { href } from "../ui/shared";
import { ActionForm, option, type MutationContext } from "./ActionForm";
import { useRoleChoices } from "./useRoleChoices";
import "./create-task.css";

const taskKinds = { implementation: "实施", research: "调研", validation: "验证" } as const;

export function CreateTaskPage({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const canWrite = context.principal.permissions.includes("write");
  const roleChoices = useRoleChoices(context.token, projectId, refresh, canWrite);
  return <div className="content create-task-page">
    <a className="create-task-back" href={href(projectId, "work")}><ArrowLeft size={15} aria-hidden="true" />返回任务列表</a>
    <h1>创建任务</h1><p className="lede">先把要做的事说清楚，再安排合适的会话。</p>
    {!canWrite ? <div className="notice" role="status">当前身份没有写入权限，不能创建任务。<a href={href(projectId, "work")}>返回任务列表</a></div> : <>
    <div className="create-task-steps" aria-label="创建任务步骤"><strong><span>1</span>说明任务</strong><i aria-hidden="true" /><span><b>2</b>保存后安排 Session</span></div>
    <div className="create-task-grid"><section className="panel create-task-form"><h2>任务内容与责任</h2>
      {roleChoices.loading && <p>正在读取可用职责…</p>}
      {roleChoices.error && <p role="alert">职责未完整读回：{roleChoices.error}。请先重试，避免把任务分给错误的人。</p>}
      {!roleChoices.loading && !roleChoices.error && <ActionForm context={{ ...context, draftScope: "new-task" }} embedded title="保存任务，继续安排" fields={[
        { name: "title", label: "任务名称" },
        { name: "content", label: "为什么要做", kind: "textarea" },
        { name: "outcome", label: "期望结果", kind: "textarea" },
        { name: "acceptance", label: "怎样独立验收", kind: "textarea" },
        { name: "owner", label: "负责角色", kind: "select", options: roleChoices.options.length ? roleChoices.options : [option(context.principal.actorId, "当前身份（项目尚无可用角色）")] },
        { name: "consumer", label: "独立验收人", value: context.principal.actorId, hint: "填写实际会签收使用结果的身份 ID；默认当前身份。" },
        { name: "useRequired", label: "是否要求实际使用", kind: "select", options: [option("no", "不要求"), option("yes", "要求验收人记录实际使用")] },
        { name: "kind", label: "任务类型（可选）", kind: "select", optional: true, advanced: true, options: Object.entries(taskKinds).map(([key, label]) => option(key, label)) },
        { name: "evidence", label: "创建依据（可选）", kind: "textarea", optional: true, advanced: true },
        { name: "stopCondition", label: "停止条件（可选）", kind: "textarea", optional: true, advanced: true },
      ]} build={v => ({ type: "task.create", taskId: crypto.randomUUID(), title: v.title, kind: v.kind || null,
        content: `${v.content.trim()}\n\n期望结果\n${v.outcome.trim()}`, acceptance: v.acceptance, owner: v.owner,
        consumer: v.consumer.trim(), useRequired: v.useRequired === "yes", ...(v.evidence.trim() ? { evidence: v.evidence.trim() } : {}),
        ...(v.stopCondition.trim() ? { stopCondition: v.stopCondition.trim() } : {}) })}
        onApplied={result => { window.location.hash = `/p/${projectId}/tasks/${result.entityId}`; }} />}
    </section><aside className="create-task-check"><h2>交办前检查</h2><ol><li><strong>目标具体</strong><span>说明要解决的问题和可交付结果。</span></li><li><strong>结果可核对</strong><span>写明独立验收要看的证据。</span></li><li><strong>验收人明确</strong><span>指定实际观察和签收的身份。</span></li></ol><p>创建只保存任务记录。具体 Session 分派、队列与运行在任务详情里另行确认。</p></aside></div></>}
  </div>;
}
