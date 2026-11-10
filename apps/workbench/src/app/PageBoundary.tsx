// One page that throws while rendering shows its own error; the shell, the login and other visited pages stay.
import { Component, type ErrorInfo, type ReactNode } from "react";

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

export class PageBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("页面渲染出错", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return <section data-ui="" className={errorPage.root} role="alert">
      <h1 className={errorPage.title}>这一页显示出错</h1>
      <p className={errorPage.lede}>已停止显示这一页，其余页面和登录不受影响。可以重试显示，或换到别的页面后再回来。</p>
      <details><summary className={errorPage.summary}>错误信息</summary><pre className={errorPage.detail}>{message}</pre></details>
      <button type="button" className={errorPage.button} onClick={() => this.setState({ error: null })}>重试显示</button>
    </section>;
  }
}
