// 项目设置: the project, the signed-in identity and its permissions, and where each kind of record lives. 重新读取
// reads the project and the identity again; each says when it was read, and a failed reread keeps what was there.
import { BookOpen, ClipboardCheck, FileText, ListChecks, RefreshCw, Users } from "lucide-react";
import { Button, Notice } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { Facts, LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import { operationsTitle } from "./operationsPresentation";
import { identityChanges, identityLabel, identityReadText, permissionLabel } from "./settingsPresentation";
import { readSession, sessionKey } from "./sessionRead";

const readTime = (at: number) => at ? date(new Date(at).toISOString()) : "";

export function ProjectSettings({ context }: { context: MutationContext; refresh: number }) {
  const { projectId, principal: login } = context;
  const project = useProjectQuery(projectId, ["project"], async () => {
    const value = await api().project(projectId);
    if (value.id !== projectId) throw new Error("项目响应与当前范围不符");
    return value;
  });
  const session = useProjectQuery(projectId, sessionKey, readSession);
  const current = project.data;
  const reading = project.isFetching || session.isFetching;
  const error = project.error ? errorText(project.error) : "";
  const observed = readTime(project.dataUpdatedAt);
  // The identity read on this page once it is back; until then (or when it never came back) the one read at login.
  const principal = session.data?.principal ?? login;
  const changes = session.data ? identityChanges(login, session.data.principal, projectId) : [];
  const identityError = session.error ? errorText(session.error) : "";
  return <SettingsPage title="项目设置" description="核对项目、登录身份和可用权限。" className="project-settings"
    action={<Button onClick={() => { void project.refetch(); void session.refetch(); }} disabled={reading}>
      <RefreshCw aria-hidden="true" className={reading ? "animate-spin" : undefined} />重新读取</Button>}>
    {error && <Notice tone="error" title="项目本次读取失败">{error}。{current ? "下面是上次读回的内容。" : ""}</Notice>}
    <SettingsSection id="settings-project" title="当前项目">
      <Facts rows={[
        ["名称", <strong key="t" className="font-semibold">{current?.title ?? (project.isFetching ? "正在核对项目…" : "项目尚未读回")}</strong>],
        ["建立于", current ? date(current.createdAt) : "待读回"],
        ["最后读取", current ? `${observed}${error ? " · 旧数据" : project.isFetching ? " · 正在重新核对" : ""}` : "待读回"],
      ]} />
      <FullIdentifiers summary="完整标识" rows={[{ label: "项目", value: projectId }]} />
    </SettingsSection>
    <SettingsSection id="settings-access" title="当前登录身份">
      {identityError && <Notice tone="waiting" title="上次读回，当前待核对">身份与权限本次重新读取失败：{identityError}。
        {session.data ? `下面是 ${readTime(session.dataUpdatedAt)} 读回的内容。` : "下面是登录时读回的内容。"}</Notice>}
      {changes.length > 0 && <Notice tone="waiting" title="与登录时读回的不同">{changes.join("；")}。工作台其他页面仍按登录时的身份显示入口，提交时服务端按最新权限核验；要让各页按新权限显示，请回项目列表点“刷新项目”。</Notice>}
      <Facts rows={[
        ["身份", <strong key="a" className="font-semibold">{principal.actorId}</strong>],
        ["身份类型", principal.identityKind ? identityLabel[principal.identityKind] ?? principal.identityKind : "未报告"],
        ["可用权限", principal.permissions.length
          ? <ul key="p" className="flex flex-wrap gap-1.5">{principal.permissions.map(permission => <li key={permission} className="rounded-full bg-field px-2.5 py-0.5 text-caption text-foreground">{permissionLabel[permission] ?? permission}</li>)}</ul>
          : "未声明权限"],
        ["最后读取", identityReadText({ hasData: !!session.data, fetching: session.isFetching, failed: !!session.error, readAt: readTime(session.dataUpdatedAt) })],
      ]} />
      <p className="text-caption text-muted-foreground">具体对象、操作和固定版本仍由服务端核验；连接已有智能体不会自动获得发消息或启动执行的权限。</p>
    </SettingsSection>
    <SettingsSection id="settings-sources" title="各类记录在哪里">
      <LinkList label="各类记录的入口" items={[
        { href: href(projectId, "work"), title: "工作记录", detail: "任务、交付与使用", icon: <ListChecks /> },
        { href: href(projectId, "repository"), title: "仓库规范", detail: "规范文档、已配置的能力与固定 Git 来源", icon: <FileText /> },
        { href: href(projectId, "knowledge"), title: "知识空间", detail: "外置认识与固定来源", icon: <BookOpen /> },
        { href: href(projectId, "runtime"), title: "团队与智能体", detail: "职责、承接与实际执行", icon: <Users /> },
        { href: href(projectId, "operations"), title: operationsTitle, detail: "当前身份保存的操作回执", icon: <ClipboardCheck /> },
      ]} />
    </SettingsSection>
  </SettingsPage>;
}
