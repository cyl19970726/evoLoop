import { useEffect, useState } from "react";
import type { Project } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
const permissionLabel: Record<string,string> = {read:"读取项目",write:"提交业务变更",review:"审阅与复核",approve:"接受与验收"};

export function ProjectSettings({ context, refresh }: { context: MutationContext; refresh: number }) {
  const scope = `${context.projectId}:${context.principal.actorId}:${context.token}`;
  const [read, setRead] = useState<{scope: string; project: Project; observedAt: string} | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(true);
  useEffect(() => {
    let active = true;
    setReading(true);
    api(context.token).project(context.projectId).then(value => {
      if (value.id !== context.projectId) throw new Error("项目响应与当前范围不符");
      if (active) { setRead({scope,project:value,observedAt:new Date().toISOString()}); setError(""); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, scope, refresh]);
  const current = read?.scope === scope ? read : null;
  return <div className="content project-settings"><h1>项目设置</h1><p className="lede">核对当前项目、登录身份与事实来源。具体执行、消息和日程授权在各自对象中判断。</p>
    {error && <Alert kind="error">项目本次读取失败：{error}。{current && "保留上次读回。"}<button onClick={context.onChanged}>重新读取</button></Alert>}
    <section className="panel"><div className="panel-head"><h2>{current?.project.title ?? "正在核对项目…"}</h2><button className="quiet" onClick={context.onChanged}>重新读取</button></div>
      {current && <p className="muted">项目建立于 {date(current.project.createdAt)} · 读于 {date(current.observedAt)}{error ? "（旧数据）" : reading ? " · 正在重新核对" : ""}</p>}
      <div className="project-access-grid"><section><h3>当前登录身份</h3><strong>{context.principal.actorId}</strong><p>连接已有会话不自动获得向其发消息或启动Run的授权。</p></section><section><h3>权限声明</h3><ul>{context.principal.permissions.map(permission=><li key={permission}>{permissionLabel[permission] ?? permission}</li>)}</ul><p>具体对象、操作、固定版本与可用承载仍由服务端核验。</p></section></div>
      <details><summary>项目与身份标识</summary><p>项目 <code>{context.projectId}</code> · 身份类型 {context.principal.identityKind ?? "未报告"}</p></details>
    </section>
    <section className="panel"><h2>从相应权威继续</h2><div className="project-source-links"><a href={href(context.projectId,"work")}><strong>工作记录</strong><span>Task、交付、独立使用和下一责任</span></a><a href={href(context.projectId,"repository")}><strong>仓库正式文档</strong><span>产品、前端、架构与开发规则</span></a><a href={href(context.projectId,"knowledge")}><strong>知识空间</strong><span>外置正文、固定来源与反例</span></a><a href={href(context.projectId,"runtime")}><strong>团队与具体会话</strong><span>职责、承接、实际运行与能力</span></a><a href={href(context.projectId,"operations")}><strong>待核对操作</strong><span>当前身份的原操作回执与恢复</span></a></div></section>
  </div>;
}
