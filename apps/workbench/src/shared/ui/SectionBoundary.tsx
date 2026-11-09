// A part of a page that throws while rendering shows a short notice in its place; the rest of the page stays.
import { Component, type ErrorInfo, type ReactNode } from "react";

export class SectionBoundary extends Component<{ label: string; children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error(`${this.props.label}渲染出错`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-small text-destructive">
      {this.props.label}暂时无法显示：{this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}。
      <button type="button" className="ml-1 underline underline-offset-4" onClick={() => this.setState({ error: null })}>重试</button>
    </p>;
  }
}
