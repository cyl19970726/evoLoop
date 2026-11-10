// 仓库规范: the capabilities the service judged for this project (GET /capabilities), the repositories it configured
// for it (GET /repositories), the registration of fixed Git sources, and links to evoLoop's own repository docs, kept
// apart from the project's process documents. A view the service cannot give is said as such, never as "none"; the
// service gives no repository address, so the page links no project repository.
import type { ReactNode } from "react";
import { ArrowLeft, BookOpen, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag } from "@evoloop/ui";
import { errorDetail, errorText } from "../../shared/api";
import { useProjectCapabilities, useProjectRepositories } from "../../shared/projectConfiguration";
import { allowedPathsText, repositoryStanding } from "../../shared/repositoryPresentation";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date, href } from "../../shared/ui/shared";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { Facts, LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import { capabilitiesUnavailableText, capabilityNotices, capabilityRows } from "./capabilityPresentation";

/** evoLoop's own docs: GitHub, main branch, the current text (not a fixed version). Not this project's repository. */
const evoLoopDocs = "https://github.com/cyl19970726/evoLoop/blob/main";
const note = "text-caption text-muted-foreground";

/** The read line under a section: when it was read, a reread running, or the button to read again. */
function ReadLine({ what, read }: { what: string; read: { dataUpdatedAt: number; isFetching: boolean; isError: boolean; checking: boolean; refetch(): unknown } }) {
  const button = <Button size="compact" variant="ghost" onClick={() => void read.refetch()} disabled={read.isFetching}>
    <RefreshCw aria-hidden="true" className={read.isFetching ? "animate-spin" : undefined} />重新读取</Button>;
  return <div className="flex flex-wrap items-center justify-between gap-2">
    <p className={note}>按服务端在 {date(new Date(read.dataUpdatedAt).toISOString())} 读回的{what}；具体对象和操作仍由服务端核验。</p>
    {read.checking && !read.isError ? <RefreshingIndicator label={`正在重新读取${what}`} /> : button}
  </div>;
}

function Capabilities({ projectId }: { projectId: string }) {
  const read = useProjectCapabilities(projectId);
  const reread = <Button size="compact" variant="ghost" onClick={() => void read.refetch()} disabled={read.isFetching}>
    <RefreshCw aria-hidden="true" className={read.isFetching ? "animate-spin" : undefined} />重新读取</Button>;
  if (!read.data) return read.isError
    ? <ErrorState title="能力结论暂不可读取" happened={errorText(read.error)} diagnostics={errorDetail(read.error) ?? undefined}
      next="现在无法判断哪些能力已为本项目配置；可以重新读取。" action={reread} />
    : <LoadingState lines={3} label="正在读取本项目的能力" />;
  const view = read.data;
  const stale = read.stale && <Notice tone="waiting" title="上次读回，当前待核对">重新读取失败：{errorText(read.error)}。下面是上次读回的能力结论。</Notice>;
  if (view.status === "unavailable") {
    const said = capabilitiesUnavailableText(view);
    return <>{stale}<Notice tone="waiting" title="无法判断">{said.text}</Notice>
      <FullIdentifiers rows={[{ label: "原因代码", value: said.code }]} /><ReadLine what="能力结论" read={read} /></>;
  }
  const rows = capabilityRows(view.items);
  return <>
    {stale}
    {capabilityNotices(view.items).map(text => <Notice key={text} tone="waiting">{text}</Notice>)}
    <Facts rows={rows.map(row => [row.label, <span key={row.key} className="flex flex-col items-start gap-1" data-capability={row.key}>
      <span className="flex flex-wrap items-center gap-2"><StatusTag tone={row.tag.tone} label={row.tag.label} /><span className={note}>{row.scope}</span></span>
      <span>{row.text}</span>
      {row.caller && <span className="text-text-secondary">{row.caller}</span>}
      {row.pending && <span className="text-text-secondary">{row.pending}</span>}
      <span className={note}>{row.readAt}</span>
      <FullIdentifiers rows={row.codes} summary="原因代码" />
    </span>] as [string, ReactNode])} />
    <ReadLine what="能力结论" read={read} />
  </>;
}

function Repositories({ projectId }: { projectId: string }) {
  const read = useProjectRepositories(projectId);
  const reread = <Button size="compact" variant="ghost" onClick={() => void read.refetch()} disabled={read.isFetching}>重新读取</Button>;
  if (!read.data) return read.isError
    ? <ErrorState title="仓库清单暂不可读取" happened={errorText(read.error)} diagnostics={errorDetail(read.error) ?? undefined}
      next="现在无法判断本项目配置了哪些仓库；可以重新读取。" action={reread} />
    : <LoadingState lines={2} label="正在读取本项目的仓库" />;
  const standing = repositoryStanding(read.data);
  return <>
    {read.stale && <Notice tone="waiting" title="上次读回，当前待核对">重新读取失败：{errorText(read.error)}。下面是上次读回的仓库清单。</Notice>}
    {standing.kind === "listed" ? <p className="text-small text-text-secondary">{standing.text}</p>
      : <Notice tone={standing.kind === "refused" ? "error" : "waiting"} title={standing.kind === "none" ? "本项目没有配置仓库"
        : standing.kind === "refused" ? "仓库登记被拒，现在读不了 Git" : "无法判断"}>{standing.text}</Notice>}
    {standing.items.length > 0 && <Facts rows={standing.items.map(item => [item.repositoryId, <span key={item.repositoryId} className="flex flex-col gap-0.5">
      <span>允许读取：{allowedPathsText(item.allowedPaths)}</span>
      {standing.kind === "refused" && <span className={note}>整份登记被拒，这个仓库现在读不了。</span>}
    </span>] as [string, ReactNode])} />}
    {standing.kind === "unknown" && <FullIdentifiers rows={[{ label: "原因代码", value: standing.code }]} />}
    <p className={note}>只列仓库标识和允许读取的路径；服务器上的检出位置不在页面上，服务端也没有仓库网址。</p>
    <ReadLine what="仓库清单" read={read} />
  </>;
}

export function RepositoryPage({ projectId, reference }: { projectId: string; reference: ReactNode }) {
  return <SettingsPage title="仓库规范" description="本项目有哪些能力和仓库，怎样登记固定 Git 来源；产品、架构与开发规范在仓库 docs 维护，与项目的过程文档分开。"
    className="repository-page" action={<Button asChild size="compact" variant="ghost"><a href={href(projectId, "settings")}><ArrowLeft aria-hidden="true" />项目设置</a></Button>}>
    <SettingsSection title="已配置的能力">
      <SectionBoundary label="能力结论"><Capabilities projectId={projectId} /></SectionBoundary>
    </SettingsSection>
    <SettingsSection title="本项目的仓库">
      <SectionBoundary label="仓库清单"><Repositories projectId={projectId} /></SectionBoundary>
    </SettingsSection>
    <SettingsSection title="登记固定 Git 来源与正式采用">
      <SectionBoundary label="固定来源登记">{reference}</SectionBoundary>
    </SettingsSection>
    <SettingsSection title="evoLoop 自身的规范">
      <p className={note}>下面的链接固定打开 evoLoop 仓库 main 分支的现行文档，不随项目变化；服务端没有提供本项目仓库的网址，所以这里不能生成本项目自己的规范链接。任务实际采用哪一版，请回任务查看固定的 commit。</p>
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
    <p className={note}>项目工作中产生的方案、报告和讨论是过程文档，不在这里。<a href={href(projectId, "documents")} className="ml-1 text-foreground underline">查看过程文档</a></p>
  </SettingsPage>;
}
