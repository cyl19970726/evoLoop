// One page that throws while rendering shows its own error; the shell, the login and other visited pages stay.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, resetChunks } from "./chunkLoad";
import { api } from "../shared/api";

/**
 * The look of a page that stopped rendering (here and the router's error page). Plain classes on tokens, written out
 * because this module is in the first load, which does not carry @evoloop/ui (its Button needs tailwind-merge).
 */
export const errorPage = {
  root: "mx-auto flex w-full max-w-[880px] flex-col items-start gap-3 px-4 py-5 compact:px-8 compact:py-7",
  title: "text-title font-semibold leading-(--leading-tight) text-foreground",
  lede: "text-small text-text-secondary",
  summary: "cursor-pointer text-label text-text-secondary",
  detail: "mt-2 max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-caption [overflow-wrap:anywhere]",
  button: "inline-flex h-9 items-center justify-center rounded-md bg-brand px-4 text-small font-medium text-on-brand outline-none hover:bg-brand-hover active:bg-brand-pressed focus-visible:shadow-[var(--focus-ring)]",
};

/** What a stopped page tells: shown on the page, copyable, and kept by the service (Task c3a8e5d1). */
export interface PageErrorReport { message: string; componentStack: string; route: string; commit: string | null; occurredAt: string }
type Saved = { state: "saving" } | { state: "saved"; id: string } | { state: "failed"; reason: string };

/** The text the page shows and copies. Plain text, one line per fact, so it pastes into a report as it is. */
export function pageErrorText(report: PageErrorReport, saved: Saved | null): string {
  return [
    `错误信息：${report.message}`,
    `路由：${report.route}`,
    `构建 commit：${report.commit ?? "未读到"}`,
    `时间：${report.occurredAt}`,
    `服务端记录：${!saved || saved.state === "saving" ? "正在记录" : saved.state === "saved" ? `已记录，编号 ${saved.id}` : `没有记录成功（${saved.reason}）`}`,
    `组件栈：${report.componentStack.trim() || "（没有）"}`,
  ].join("\n");
}
const projectOfRoute = (path: string) => /^\/p\/([^/]+)/.exec(path)?.[1] ?? null;

export class PageBoundary extends Component<{ children: ReactNode; active?: boolean }, { error: unknown; report: PageErrorReport | null; saved: Saved | null; copied: boolean }> {
  state: { error: unknown; report: PageErrorReport | null; saved: Saved | null; copied: boolean } = { error: null, report: null, saved: null, copied: false };
  static getDerivedStateFromError(error: unknown) { return { error, report: null, saved: null, copied: false }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("页面渲染出错", error, info.componentStack);
    void this.capture(error, info.componentStack ?? "");
  }
  /** Builds the report, shows it at once, then asks the service to keep it. Nothing here may throw: a failure to record is shown, not raised. */
  private async capture(error: unknown, componentStack: string) {
    const route = typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
    const report: PageErrorReport = { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error), componentStack, route, commit: null, occurredAt: new Date().toISOString() };
    this.setState({ report, saved: { state: "saving" } });
    try {
      const project = projectOfRoute(route);
      report.commit = (await api().version(undefined, project ? decodeURIComponent(project) : undefined).catch(() => null))?.commit ?? null;
      this.setState({ report: { ...report } });
      if (!project) { this.setState({ saved: { state: "failed", reason: "这一页不属于某个项目" } }); return; }
      const result = await api().reportClientError(decodeURIComponent(project), report);
      this.setState({ saved: { state: "saved", id: result.id } });
    } catch (failure) { this.setState({ saved: { state: "failed", reason: failure instanceof Error ? failure.message : "未知原因" } }); }
  }
  private copy = async () => {
    const { report, saved } = this.state; if (!report) return;
    try { await navigator.clipboard.writeText(pageErrorText(report, saved)); this.setState({ copied: true }); } catch { this.setState({ copied: false }); }
  };
  componentDidUpdate(previous: { active?: boolean }) {
    // Entering a page again after its chunk failed asks for the chunk again; only a second failure shows the state again.
    if (this.props.active && previous.active === false && this.state.error !== null && isChunkLoadError(this.state.error)) this.retry();
  }
  private retry = () => { resetChunks(); this.setState({ error: null, report: null, saved: null, copied: false }); };
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    if (isChunkLoadError(this.state.error)) return <section data-ui="" className={errorPage.root} role="alert" data-chunk-failed="">
      <h1 className={errorPage.title}>工作台已经更新到新版本</h1>
      <p className={errorPage.lede}>这一页需要刷新后才能打开。刷新后需要重新输入访问令牌。</p>
      <p className={errorPage.lede}>页面不会自动刷新，因为刷新会丢掉当前的登录。想先保留现在的内容，可以重试：文件恢复后无需刷新就能打开。</p>
      <details><summary className={errorPage.summary}>错误信息</summary><pre className={errorPage.detail}>{message}</pre></details>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={errorPage.button} onClick={() => window.location.reload()}>刷新页面</button>
        <button type="button" className={errorPage.button} onClick={this.retry}>重试</button>
      </div>
    </section>;
    const { report, saved, copied } = this.state;
    return <section data-ui="" className={errorPage.root} role="alert">
      <h1 className={errorPage.title}>这一页显示出错</h1>
      <p className={errorPage.lede}>已停止显示这一页，其余页面和登录不受影响。可以重试显示，或换到别的页面后再回来。展开下面的错误信息可以看到原因，并复制给维护者。</p>
      <details data-page-error=""><summary className={errorPage.summary}>错误信息</summary>
        <pre className={errorPage.detail} data-page-error-text="">{report ? pageErrorText(report, saved) : `错误信息：${message}`}</pre>
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={errorPage.button} onClick={() => this.setState({ error: null, report: null, saved: null, copied: false })}>重试显示</button>
        <button type="button" className={errorPage.button} onClick={() => void this.copy()} data-page-error-copy="">{copied ? "已复制" : "复制错误信息"}</button>
      </div>
    </section>;
  }
}
