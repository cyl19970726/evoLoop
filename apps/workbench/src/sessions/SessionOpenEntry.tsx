import { useEffect, useState } from "react";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { errorText, request } from "../api";
import { codexThreadHref } from "../roles/externalHostEntry";

/** A directory capability permits a request to open, not proof that the chat received anything. */
export function sessionOpenHref(session: ObservedSession, host: HostLink | null): string | null {
  if (!session.capabilities.open.available) return null;
  const observedRef = codexThreadHref(session.capabilities.open.ref);
  if (!observedRef) return null;
  if (session.kind === "external") {
    if (session.target.kind !== "external" || !host || host.id !== session.target.linkId
      || host.host.kind !== "external" || host.host.provider !== "codex-desktop"
      || host.state !== "verified" || !host.verifiedCapabilities.includes("open")
      || codexThreadHref(host.host.ref) !== observedRef) return null;
  }
  return observedRef;
}

export function sessionOriginalRef(session: ObservedSession, host: HostLink | null): string | null {
  const raw = session.capabilities.open.ref ?? (host?.host.kind === "external" ? host.host.ref : null);
  return codexThreadHref(raw) ?? raw;
}

export function SessionOpenEntry({ session, token, projectId, currentRead, active }: { session: ObservedSession; token: string; projectId: string; currentRead: boolean; active: boolean }) {
  const [read, setRead] = useState<{ scope: string; host: HostLink | null; error: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "failed">("");
  const linkId = session.target.kind === "external" ? session.target.linkId : null;
  const scope = `${projectId}:${session.key}:${linkId ?? ""}`;
  useEffect(() => {
    setCopyStatus(""); setRead(null);
    if (!active || !linkId) return;
    let mounted = true;
    request<HostLink>(token, `/api/projects/${encodeURIComponent(projectId)}/hosts/${encodeURIComponent(linkId)}`, 15000)
      .then(host => {
        if (host.projectId !== projectId || host.id !== linkId || host.host.kind !== "external") throw new Error("会话引用与当前项目不符");
        if (mounted) setRead({ scope, host, error: "" });
      })
      .catch(cause => { if (mounted) setRead({ scope, host: null, error: errorText(cause) }); });
    return () => { mounted = false; };
  }, [token, projectId, session.key, linkId, scope, active]);
  const current = read?.scope === scope ? read : null;
  const host = current?.host ?? null;
  const fullRef = sessionOriginalRef(session, host);
  const openHref = currentRead ? sessionOpenHref(session, host) : null;
  const latestReason = host?.state === "revoked" ? "最新连接已撤权。"
    : host?.state === "registered" ? "最新连接尚未核实。"
      : host && !host.verifiedCapabilities.includes("open") ? "最新连接未核实打开能力。"
        : host && !openHref ? "最新连接与会话观察不一致，须重新核对。" : null;
  async function copy() {
    if (!fullRef) return;
    setCopyStatus("");
    try { await navigator.clipboard.writeText(fullRef); setCopyStatus("copied"); }
    catch { setCopyStatus("failed"); }
  }
  return <div className="session-original-entry">
    {openHref && <a href={openHref} target="_blank" rel="noopener noreferrer">请求在 Codex Desktop 打开原聊天</a>}
    {fullRef && <><code className="break-anywhere">{fullRef}</code><button type="button" onClick={() => void copy()}>复制完整引用</button></>}
    {copyStatus === "copied" && <small role="status">已复制，请在 Codex 中核对原聊天。</small>}
    {copyStatus === "failed" && <small role="alert">复制失败；可选中上方完整引用手工复制。</small>}
    {session.kind === "external" && !current && <small>正在读取原聊天引用…</small>}
    {current?.error && <small role="alert">原聊天引用暂不可读：{current.error}。</small>}
    {!openHref && <small>{currentRead ? latestReason || session.capabilities.open.reason || "打开能力尚未核实。" : "当前状态尚未读回；不能据上次观察请求打开。"}可用完整引用人工查找；这里不表示消息已送达。</small>}
    {openHref && <small>仅向本机请求打开；是否打开、阅读或收到消息须在原聊天另行核对。</small>}
  </div>;
}
