// One page that throws while rendering shows its own error; the shell, the login and other visited pages stay.
import { Component, type ErrorInfo, type ReactNode } from "react";

export class PageBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("页面渲染出错", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return <section className="content" role="alert">
      <h1>这一页显示出错</h1>
      <p className="lede">已停止显示这一页，其余页面和登录不受影响。可以重试显示，或换到别的页面后再回来。</p>
      <details><summary>错误信息</summary><pre>{message}</pre></details>
      <button type="button" className="primary" onClick={() => this.setState({ error: null })}>重试显示</button>
    </section>;
  }
}
