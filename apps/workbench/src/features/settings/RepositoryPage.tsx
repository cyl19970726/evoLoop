// 仓库规范: which capabilities the server declared for this identity and project, the registration of fixed Git sources,
// and links to evoLoop's own repository docs, kept apart from the project's process documents. The server gives no
// list of a project's repositories and no repository address, so the page says what it cannot tell instead.
import type { ReactNode } from "react";
import { ArrowLeft, BookOpen, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag } from "@evoloop/ui";
import { errorDetail, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { Facts, LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import { capabilityRows, capabilityTag } from "./settingsPresentation";
import { readSession, sessionKey } from "./sessionRead";

/** evoLoop's own docs: GitHub, main branch, the current text (not a fixed version). Not this project's repository. */
const evoLoopDocs = "https://github.com/cyl19970726/evoLoop/blob/main";

function Capabilities({ projectId }: { projectId: string }) {
  const session = useProjectQuery(projectId, sessionKey, readSession);
  const reread = <Button size="compact" variant="ghost" onClick={() => void session.refetch()} disabled={session.isFetching}>
    <RefreshCw aria-hidden="true" className={session.isFetching ? "animate-spin" : undefined} />重新读取</Button>;
  if (!session.data) return session.isError
    ? <ErrorState title="能力声明暂不可读取" happened={errorText(session.error)} diagnostics={errorDetail(session.error) ?? undefined}
      next="现在无法判断哪些能力已配置；可以重新读取。" action={reread} />
    : <LoadingState lines={3} label="正在读取服务端声明的能力" />;
  const rows = capabilityRows(session.data.capabilities, session.data.principal.projectIds, projectId);
  return <>
    {session.stale && <Notice tone="waiting" title="上次读回，当前待核对">重新读取失败：{errorText(session.error)}。下面是上次读回的能力声明。</Notice>}
    <Facts rows={[
      ...rows.map(row => [row.label, <span key={row.label} className="flex flex-col items-start gap-1">
        <StatusTag tone={capabilityTag[row.state].tone} label={capabilityTag[row.state].label} /><span>{row.text}</span></span>] as [string, ReactNode]),
      ["本项目的仓库", <span key="repositories" className="flex flex-col items-start gap-1">
        <StatusTag tone="unknown" label="无法判断" />
        <span>服务端没有提供列出仓库的接口，这里列不出本项目配置了哪些仓库，也没有仓库网址。登记时要填的仓库标识请向管理员确认（本机运行时写在 <code className="font-mono text-caption">.local/integrations.json</code> 的 repositories 里）。</span></span>],
    ]} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-caption text-muted-foreground">按服务端在 {date(new Date(session.dataUpdatedAt).toISOString())} 读回的能力声明；具体对象和操作仍由服务端核验。</p>
      {session.checking && !session.isError ? <RefreshingIndicator label="正在重新读取能力声明" /> : reread}
    </div>
  </>;
}

export function RepositoryPage({ projectId, reference }: { projectId: string; reference: ReactNode }) {
  return <SettingsPage title="仓库规范" description="哪些能力已配置可用，怎样登记固定 Git 来源；产品、架构与开发规范在仓库 docs 维护，与项目的过程文档分开。"
    className="repository-page" action={<Button asChild size="compact" variant="ghost"><a href={href(projectId, "settings")}><ArrowLeft aria-hidden="true" />项目设置</a></Button>}>
    <SettingsSection title="已配置的能力">
      <SectionBoundary label="能力声明"><Capabilities projectId={projectId} /></SectionBoundary>
    </SettingsSection>
    <SettingsSection title="登记固定 Git 来源与正式采用">
      <SectionBoundary label="固定来源登记">{reference}</SectionBoundary>
    </SettingsSection>
    <SettingsSection title="evoLoop 自身的规范">
      <p className="text-caption text-muted-foreground">下面的链接固定打开 evoLoop 仓库 main 分支的现行文档，不随项目变化；服务端没有提供本项目仓库的网址，所以这里不能生成本项目自己的规范链接。任务实际采用哪一版，请回任务查看固定的 commit。</p>
      <h3 className="text-caption font-semibold text-text-secondary">从这里开始</h3>
      <LinkList label="从这里开始" items={[
        { href: `${evoLoopDocs}/CONTRIBUTING.md`, title: "贡献与变更入口", detail: "怎样参与贡献、提交变更与验证要求。", icon: <FileText />, external: true },
        { href: `${evoLoopDocs}/docs/README.md`, title: "按任务选择阅读和检查路径", detail: "按当前问题找到要读的正式正文。", icon: <FolderOpen />, external: true },
      ]} />
      <h3 className="text-caption font-semibold text-text-secondary">按问题查阅</h3>
      <LinkList label="按问题查阅" items={[
        { href: `${evoLoopDocs}/docs/frontend/README.md`, title: "前端页面与交互", detail: "页面、共同设计与实现边界。", icon: <BookOpen />, external: true },
        { href: `${evoLoopDocs}/docs/product/definition.md`, title: "产品目标与双循环", detail: "为什么做，以及怎样判断效果。", icon: <BookOpen />, external: true },
        { href: `${evoLoopDocs}/docs/decisions.md`, title: "当前决定", detail: "已采纳的选择与被取代的依据。", icon: <FileText />, external: true },
      ]} />
    </SettingsSection>
    <p className="text-caption text-muted-foreground">项目工作中产生的方案、报告和讨论是过程文档，不在这里。<a href={href(projectId, "documents")} className="ml-1 text-foreground underline">查看过程文档</a></p>
  </SettingsPage>;
}
