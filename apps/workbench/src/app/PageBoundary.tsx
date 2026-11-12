// One page that throws while rendering shows its own error; the shell, the login and other visited pages stay.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, resetChunks } from "./chunkLoad";

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
  button: "inline-flex h-9 items-center justify-center rounded-full bg-foreground px-4 text-small font-medium text-background outline-none hover:opacity-90 focus-visible:shadow-[var(--focus-ring)]",
};

export class PageBoundary extends Component<{ children: ReactNode; active?: boolean }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("页面渲染出错", error, info.componentStack); }
  componentDidUpdate(previous: { active?: boolean }) {
    // Entering a page again after its chunk failed asks for the chunk again; only a second failure shows the state again.
    if (this.props.active && previous.active === false && this.state.error !== null && isChunkLoadError(this.state.error)) this.retry();
  }
  private retry = () => { resetChunks(); this.setState({ error: null }); };
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
    return <section data-ui="" className={errorPage.root} role="alert">
      <h1 className={errorPage.title}>这一页显示出错</h1>
      <p className={errorPage.lede}>已停止显示这一页，其余页面和登录不受影响。可以重试显示，或换到别的页面后再回来。</p>
      <details><summary className={errorPage.summary}>错误信息</summary><pre className={errorPage.detail}>{message}</pre></details>
      <button type="button" className={errorPage.button} onClick={() => this.setState({ error: null })}>重试显示</button>
    </section>;
  }
}
