// 仓库规范: links to the repository's own docs, kept apart from the project's process documents.
import type { ReactNode } from "react";
import { BookOpen, FileText, FolderOpen } from "lucide-react";
import { href } from "../../shared/ui/shared";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";

const repo = "https://github.com/cyl19970726/evoLoop/blob/main";

export function RepositoryPage({ projectId, reference }: { projectId: string; reference: ReactNode }) {
  return <SettingsPage title="仓库规范" description="产品、架构与开发规范由仓库 docs 维护，与项目的过程文档分开保存。" className="repository-page">
    <SettingsSection title="从这里开始">
      <LinkList label="从这里开始" items={[
        { href: `${repo}/CONTRIBUTING.md`, title: "贡献与变更入口", detail: "怎样参与贡献、提交变更与验证要求。", icon: <FileText />, external: true },
        { href: `${repo}/docs/README.md`, title: "按任务选择阅读和检查路径", detail: "按当前问题找到要读的正式正文。", icon: <FolderOpen />, external: true },
      ]} />
    </SettingsSection>
    <SettingsSection title="按问题查阅">
      <LinkList label="按问题查阅" items={[
        { href: `${repo}/docs/frontend/README.md`, title: "前端页面与交互", detail: "页面、共同设计与实现边界。", icon: <BookOpen />, external: true },
        { href: `${repo}/docs/product/definition.md`, title: "产品目标与双循环", detail: "为什么做，以及怎样判断效果。", icon: <BookOpen />, external: true },
        { href: `${repo}/docs/decisions.md`, title: "当前决定", detail: "已采纳的选择与被取代的依据。", icon: <FileText />, external: true },
      ]} />
    </SettingsSection>
    <p className="text-caption text-muted-foreground">这里打开仓库现行文档。任务实际采用哪一版，请回任务查看固定的 commit。<a href={href(projectId, "documents")} className="ml-1 text-foreground underline">查看过程文档</a></p>
    <SettingsSection title="登记固定 Git 来源与正式采用">
      <SectionBoundary label="固定来源登记">{reference}</SectionBoundary>
    </SettingsSection>
  </SettingsPage>;
}
