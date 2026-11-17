// 智能体 with no agent selected (`/sessions`): only the directory. The list itself is the inner rail (SessionNavigation; on a narrow screen the project
// navigation drawer); this page says what it is for and points to 统筹安排 for everything about who is free, the queues and conflicts (Task 0f8c7a15).
import { LayoutDashboard } from "lucide-react";
import { Button } from "@evoloop/ui";
import { href } from "../../shared/ui/shared";

export function AgentDirectory({ projectId }: { projectId: string }) {
  return <div data-ui="" className="agent-directory mx-auto flex w-full max-w-[980px] flex-col gap-4 px-4 py-5 compact:px-8 compact:py-7">
    <header className="min-w-0">
      <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>智能体</h1>
      <p className="mt-1 text-small text-text-secondary" data-page-role="">智能体目录：选一个智能体，看它的对话、活动和运行。谁空闲、队伍与冲突不在这里，看统筹安排。</p>
    </header>
    <section aria-label="怎样找到智能体" className="flex flex-col gap-2 rounded-xl bg-raised p-4 shadow-sm compact:p-5">
      <p className="text-small text-text-secondary">目录在左侧栏，可以搜索名称或职责；窄屏点左上角的“打开项目导航”。选中一个智能体进入它的对话。旧的 <code className="font-mono text-caption">?session=</code> 链接照常打开具体的智能体。</p>
      <Button asChild className="w-fit"><a href={href(projectId, "arrangement")} data-arrangement-entry=""><LayoutDashboard aria-hidden="true" />统筹安排</a></Button>
    </section>
  </div>;
}
