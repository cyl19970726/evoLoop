// 项目设置: the project, the signed-in identity and its permissions, and where each kind of record lives.
import { BookOpen, ClipboardCheck, FileText, ListChecks, RefreshCw, Users } from "lucide-react";
import { Button, Notice } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { Facts, LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";

const permissionLabel: Record<string, string> = { read: "读取项目", write: "提交业务变更", review: "审阅与复核", approve: "接受与验收" };
const identityLabel: Record<string, string> = { human: "人", agent: "智能体" };

export function ProjectSettings({ context }: { context: MutationContext; refresh: number }) {
  const { projectId, principal, token } = context;
  const project = useProjectQuery(projectId, ["project"], async () => {
    const value = await api(token).project(projectId);
    if (value.id !== projectId) throw new Error("项目响应与当前范围不符");
    return value;
  });
  const current = project.data;
  const reading = project.isFetching;
  const error = project.error ? errorText(project.error) : "";
  const observed = project.dataUpdatedAt ? date(new Date(project.dataUpdatedAt).toISOString()) : "";
  return <SettingsPage title="项目设置" description="核对项目、登录身份和可用权限。" className="project-settings"
    action={<Button onClick={() => void project.refetch()} disabled={reading}><RefreshCw aria-hidden="true" className={reading ? "animate-spin" : undefined} />重新读取</Button>}>
    {error && <Notice tone="error" title="项目本次读取失败">{error}。{current ? "下面是上次读回的内容。" : ""}</Notice>}
    <SettingsSection id="settings-project" title="当前项目">
      <Facts rows={[
        ["名称", <strong key="t" className="font-semibold">{current?.title ?? (reading ? "正在核对项目…" : "项目尚未读回")}</strong>],
        ["建立于", current ? date(current.createdAt) : "待读回"],
        ["最后读取", current ? `${observed}${error ? " · 旧数据" : reading ? " · 正在重新核对" : ""}` : "待读回"],
        ["项目标识", <code key="i" className="break-all font-mono text-caption">{projectId}</code>],
      ]} />
    </SettingsSection>
    <SettingsSection id="settings-access" title="当前登录身份">
      <Facts rows={[
        ["身份", <strong key="a" className="font-semibold">{principal.actorId}</strong>],
        ["身份类型", principal.identityKind ? identityLabel[principal.identityKind] ?? principal.identityKind : "未报告"],
        ["可用权限", principal.permissions.length
          ? <ul key="p" className="flex flex-wrap gap-1.5">{principal.permissions.map(permission => <li key={permission} className="rounded-full bg-field px-2.5 py-0.5 text-caption text-foreground">{permissionLabel[permission] ?? permission}</li>)}</ul>
          : "未声明权限"],
      ]} />
      <p className="text-caption text-muted-foreground">具体对象、操作和固定版本仍由服务端核验；连接已有智能体不会自动获得发消息或启动执行的权限。</p>
    </SettingsSection>
    <SettingsSection id="settings-sources" title="各类记录在哪里">
      <LinkList label="各类记录的入口" items={[
        { href: href(projectId, "work"), title: "工作记录", detail: "任务、交付与使用", icon: <ListChecks /> },
        { href: href(projectId, "repository"), title: "仓库规范", detail: "产品、前端与开发规则", icon: <FileText /> },
        { href: href(projectId, "knowledge"), title: "知识空间", detail: "外置认识与固定来源", icon: <BookOpen /> },
        { href: href(projectId, "runtime"), title: "团队与智能体", detail: "职责、承接与实际执行", icon: <Users /> },
        { href: href(projectId, "operations"), title: "待核对操作", detail: "当前身份保存的操作回执", icon: <ClipboardCheck /> },
      ]} />
    </SettingsSection>
  </SettingsPage>;
}
