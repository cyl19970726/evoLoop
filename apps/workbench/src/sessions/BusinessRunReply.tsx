import { useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import { MarkdownBody } from "../ui/MarkdownBody";
import { runtimeClient, type NativeResult } from "../runtime/client";
import { acceptRunReplyForScope, businessRunStateText, runReplyScope, terminalRunStates, type BusinessRun } from "./businessRunReplyModel";
import "./workspace.css";

function preview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 420 ? `${plain.slice(0, 420)}…` : plain;
}

export function BusinessRunReply({ token, projectId, sessionKey, run, taskTitle, taskHref, current }: {
  token: string; projectId: string; sessionKey: string; run: BusinessRun; taskTitle: string | null; taskHref: string | null; current: boolean;
}) {
  const [result, setResult] = useState<NativeResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const terminal = terminalRunStates.has(run.state);
  const scopeRef = useRef(runReplyScope(sessionKey, run.id));
  scopeRef.current = runReplyScope(sessionKey, run.id);
  useEffect(() => {
    if (!terminal) { setResult(null); setError(""); setLoading(false); return; }
    let active = true;
    setResult(null); setError(""); setLoading(true);
    const requestScope = runReplyScope(sessionKey, run.id);
    runtimeClient(token, projectId).result(run.id)
      .then(value => { const accepted = acceptRunReplyForScope(requestScope, scopeRef.current, value); if (active && accepted) setResult(accepted); })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, sessionKey, run.id, run.state, terminal]);
  const title = current ? "本次工作回复" : "最近业务工作回复";
  return <section className="business-run-reply" aria-label={title}>
    <header className="business-run-head">
      <div><p className="business-run-kicker">{title}</p>
        <h2>{taskTitle ? <a href={taskHref ?? href(projectId, "task", run.taskId ?? "")}>{taskTitle}</a> : "任务标题未提供"}</h2>
        <p className="business-run-context">Run <code>{run.id.slice(0, 8)}</code> · {businessRunStateText(run.state)} · {date(run.updatedAt)}</p>
      </div>
      <span className={`business-run-state ${terminal ? "terminal" : "active"}`}>{businessRunStateText(run.state)}</span>
    </header>
    {!terminal && <p className="business-run-note">本次业务工作仍在进行，公开最终答复尚未生成。当前工具进展见下方“当前工作”。</p>}
    {terminal && loading && <p className="business-run-note" role="status">正在读取本次 Run 的公开最终答复…</p>}
    {terminal && error && <Alert kind="error">本次工作回复暂不可读：{error}</Alert>}
    {terminal && result && <>
      {result.finalPhaseConfirmed
        ? <p className="business-run-note">来源：受管业务 Run 的公开最终答复，不是普通消息，也不代表已读或已验收。</p>
        : <Alert>原生记录未标记最终答复阶段；以下内容需复核。</Alert>}
      {result.messages.length === 0
        ? <p className="business-run-note">当前原生记录没有可显示的公开答复。</p>
        : <>
          <p className="business-run-preview">{preview(result.messages[0]!)}</p>
          <details className="business-run-full">
            <summary>展开完整回复</summary>
            <div className="business-run-full-body">
              {result.messages.map((message, index) => <MarkdownBody key={`${run.id}:${index}`} source={message}
                identity={`run-reply:${run.id}:${index}`} projectId={projectId} />)}
            </div>
          </details>
        </>}
      <p className="business-run-source">只显示公开最终答复；内部 reasoning 不展示。完整工作轨迹需按项目读取与复核权限另行核对。</p>
    </>}
  </section>;
}
