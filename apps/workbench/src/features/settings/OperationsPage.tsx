// 待核对操作: the receipts this identity saved for commands whose result is not confirmed yet.
import type { ReactNode } from "react";
import { BookOpen, MessageSquare } from "lucide-react";
import { Button, EmptyState } from "@evoloop/ui";
import { href } from "../../shared/ui/shared";
import { LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";

export function OperationsPage({ projectId, checks }: { projectId: string; checks: ReactNode[] }) {
  return <SettingsPage title="待核对操作" description="查看当前身份保存的操作回执，按原操作核对结果。" className="operations-page">
    {checks.length ? <div className="flex flex-col gap-3">{checks}</div>
      : <EmptyState title="没有待核对的操作" reason="这里只列当前身份保存的回执；其他业务记录仍在各自的页面。"
        action={<Button asChild><a href={href(projectId, "work")}>返回当前工作</a></Button>} />}
    <SettingsSection title="其他操作回执">
      <LinkList label="其他操作回执" items={[
        { href: href(projectId, "runtime"), title: "消息与人工转交", detail: "送达与已读请回到具体智能体核对。", icon: <MessageSquare /> },
        { href: href(projectId, "knowledge"), title: "知识发布与撤回", detail: "专用回执仍在知识空间，按原操作查回。", icon: <BookOpen /> },
      ]} />
    </SettingsSection>
    <details className="rounded-xl bg-raised px-4 py-3 text-small shadow-sm">
      <summary className="cursor-pointer font-medium text-foreground">遇到结果未知时怎样处理</summary>
      <p className="mt-2 text-text-secondary">保留原操作 ID，先查回结果，再决定下一步；确认前不创建新操作重复提交。</p>
    </details>
  </SettingsPage>;
}
