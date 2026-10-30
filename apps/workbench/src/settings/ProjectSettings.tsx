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
  return <div className="content project-settings"><div className="page-title-row"><div><h1>项目设置</h1><p className="lede">核对项目、登录身份和可用权限。</p></div><button type="button" onClick={context.onChanged} disabled={reading}>重新读取</button></div>
    <nav className="context-links" aria-label="设置各部分"><button type="button" onClick={() => document.getElementById("settings-project")?.scrollIntoView()}>当前项目</button><button type="button" onClick={() => document.getElementById("settings-access")?.scrollIntoView()}>身份与权限</button><button type="button" onClick={() => document.getElementById("settings-sources")?.scrollIntoView()}>事实来源</button></nav>
    {error && <Alert kind="error">项目本次读取失败：{error}。{current && "保留上次读回。"}<button onClick={context.onChanged}>重新读取</button></Alert>}
    <section className="settings-section" id="settings-project"><h2>当前项目</h2><dl className="settings-facts"><div><dt>名称</dt><dd><strong>{current?.project.title ?? (reading ? "正在核对项目…" : "项目尚未读回")}</strong></dd></div><div><dt>项目建立于</dt><dd>{current ? date(current.project.createdAt) : "待读回"}</dd></div><div><dt>最后读取时间</dt><dd>{current ? <>{date(current.observedAt)}{error ? " · 旧数据" : reading ? " · 正在重新核对" : ""}</> : "待读回"}</dd></div></dl><details><summary>项目标识</summary><code>{context.projectId}</code></details></section>
    <section className="settings-section" id="settings-access"><h2>当前登录身份</h2><dl className="settings-facts"><div><dt>身份</dt><dd><strong>{context.principal.actorId}</strong></dd></div><div><dt>可用权限</dt><dd>{context.principal.permissions.length ? <ul>{context.principal.permissions.map(permission=><li key={permission}>{permissionLabel[permission] ?? permission}<span>已声明</span></li>)}</ul> : "未声明权限"}</dd></div></dl><p className="settings-note">具体对象、操作和固定版本仍由服务端核验；连接已有会话不会自动获得消息或启动执行的权限。</p><details><summary>身份类型</summary>{context.principal.identityKind ?? "未报告"}</details></section>
    <section className="settings-section" id="settings-sources"><h2>从相应权威继续</h2><div className="project-source-links"><a href={href(context.projectId,"work")}><strong>工作记录</strong><span>Task、交付与使用</span></a><a href={href(context.projectId,"repository")}><strong>仓库正式文档</strong><span>产品、前端与开发规则</span></a><a href={href(context.projectId,"knowledge")}><strong>知识空间</strong><span>外置认识与固定来源</span></a><a href={href(context.projectId,"runtime")}><strong>团队与具体会话</strong><span>职责、承接与实际执行</span></a><a href={href(context.projectId,"operations")}><strong>待核对操作</strong><span>当前身份的操作回执</span></a></div></section>
  </div>;
}
