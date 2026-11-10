// An address inside the project that names no page (a mistyped or outdated link, such as `/task/{id}` for
// `/tasks/{id}`). It says so instead of quietly showing the overview, keeps the address for the reader to check, and
// offers the two usual ways on (docs/frontend/layout.md 导航与项目范围).
import { Button } from "@evoloop/ui";
import { href } from "../shared/routes";

export function NotFoundPage({ projectId, path }: { projectId: string; path: string }) {
  return <div data-ui="" data-not-found="" className="mx-auto flex w-full max-w-[880px] flex-col items-start gap-3 px-4 py-5 compact:px-8 compact:py-7">
    <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">找不到这个页面</h1>
    <p className="text-small text-text-secondary">地址栏里的地址在项目里没有对应的页面，可能拼错了，或者来自改名前的旧链接。项目里的内容没有变化。</p>
    <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">完整地址</summary>
      <code className="mt-1 block font-mono [overflow-wrap:anywhere]">{path.split("?")[0]}</code></details>
    <div className="flex flex-wrap gap-2 pt-1">
      <Button asChild variant="primary" size="compact"><a href={href(projectId, "overview")}>回到总览</a></Button>
      <Button asChild size="compact"><a href={href(projectId, "work")}>回到任务</a></Button>
    </div>
  </div>;
}
