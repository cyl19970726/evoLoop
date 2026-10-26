import { useEffect, useState } from "react";
import type { Project } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";

export function ProjectSettings({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api(context.token).project(context.projectId).then(value => { if (active) { setProject(value); setError(""); } })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  return <div className="content narrow"><h1>项目设置</h1><p className="lede">查看当前项目和访问范围。会话授权与项目设置分开核对，连接现有聊天不会自动获得发送或运行权限。</p>
    {error && <Alert kind="error">项目暂不可读取：{error}<button onClick={context.onChanged}>重试</button></Alert>}
    {project && <section className="panel"><h2>{project.title}</h2><dl><div><dt>项目建立时间</dt><dd>{date(project.createdAt)}</dd></div><div><dt>当前身份</dt><dd>{context.principal.actorId}</dd></div><div><dt>当前权限</dt><dd>{context.principal.permissions.join("、") || "只读范围待核对"}</dd></div></dl></section>}
    <section className="panel"><h2>来源与操作</h2><div className="context-links"><a href={href(context.projectId, "repository")}>仓库正式文档</a><a href={href(context.projectId, "operations")}>待核对操作</a><a href={href(context.projectId, "roles")}>职责与会话连接</a></div><p className="muted">Task、Schedule 和过程文档以当前项目记录为准；仓库正式文档保留在 Git，知识原文保留在外置知识空间。</p></section>
  </div>;
}
