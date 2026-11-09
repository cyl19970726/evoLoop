// 原聊天入口: ask this machine to open the original chat, or copy its full reference to find it by hand. Opening is a
// request only; nothing here shows that the chat received or read anything.
import { useState } from "react";
import { Button } from "@evoloop/ui";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { errorText, request } from "../../shared/api";
import { codexThreadHref } from "../../shared/externalHostEntry";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { mutedText } from "../../shared/ui/PageParts";

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

export function SessionOpenEntry({ session, projectId, currentRead, active }: {
  session: ObservedSession;
  /** Kept for callers; reads use the signed-in identity. */
  token?: string;
  projectId: string; currentRead: boolean; active: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<{ ref: string; state: "copied" | "failed" } | null>(null);
  const linkId = session.target.kind === "external" ? session.target.linkId : null;
  const read = useProjectQuery(projectId, ["hosts", linkId], async signal => {
    const host = await request<HostLink>("", `/api/projects/${encodeURIComponent(projectId)}/hosts/${encodeURIComponent(linkId!)}`, 15000, { signal });
    if (host.projectId !== projectId || host.id !== linkId || host.host.kind !== "external") throw new Error("会话引用与当前项目不符");
    return host;
  }, { enabled: active && !!linkId });
  const host = linkId && !read.isError ? read.data ?? null : null;
  const fullRef = sessionOriginalRef(session, host);
  const openHref = currentRead ? sessionOpenHref(session, host) : null;
  const latestReason = host?.state === "revoked" ? "最新连接已撤权。"
    : host?.state === "registered" ? "最新连接尚未核实。"
      : host && !host.verifiedCapabilities.includes("open") ? "最新连接未核实打开能力。"
        : host && !openHref ? "最新连接与会话观察不一致，须重新核对。" : null;
  const copied = copyStatus?.ref === fullRef ? copyStatus.state : null;
  async function copy() {
    if (!fullRef) return;
    setCopyStatus(null);
    try { await navigator.clipboard.writeText(fullRef); setCopyStatus({ ref: fullRef, state: "copied" }); }
    catch { setCopyStatus({ ref: fullRef, state: "failed" }); }
  }
  return <div className="flex min-w-0 flex-col items-start gap-1.5 text-small">
    {openHref && <a className="text-primary hover:underline" href={openHref} target="_blank" rel="noopener noreferrer">请求在 Codex Desktop 打开原聊天</a>}
    {fullRef && <Button size="compact" variant="ghost" onClick={() => void copy()}>复制完整引用</Button>}
    {copied === "copied" && <small className={mutedText} role="status">已复制，请在 Codex 中核对原聊天。</small>}
    {copied === "failed" && <small className="text-caption text-destructive" role="alert">复制失败；可展开下方完整标识，选中原聊天引用手工复制。</small>}
    {linkId && read.isPending && <small className={mutedText} role="status">正在读取原聊天引用…</small>}
    {linkId && read.isError && <small className="text-caption text-destructive" role="alert">原聊天引用暂不可读：{errorText(read.error)}。{read.data ? "上次读回的引用不再用于打开。" : ""}</small>}
    {!openHref && <small className={mutedText}>{currentRead ? latestReason || session.capabilities.open.reason || "打开能力尚未核实。" : "当前状态尚未读回；不能据上次观察请求打开。"}可用完整引用人工查找；这里不表示消息已送达。</small>}
    {openHref && <small className={mutedText}>仅向本机请求打开；是否打开、阅读或收到消息须在原聊天另行核对。</small>}
    <FullIdentifiers rows={[{ label: "原聊天引用", value: fullRef }]} />
  </div>;
}
