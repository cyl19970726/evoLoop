import { useEffect, useRef, useState } from "react";
import type { BusinessDomain, DomainRoute, HostLink } from "@evoloop/contracts/resident-hosts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { errorText, request } from "../api";
import { href } from "../ui/shared";
import { externalHostOpenHref, externalHostOpenReason } from "./externalHostEntry";
import "./presence.css";

const key = encodeURIComponent;
const statusLabel: Record<DomainRoute["status"], string> = {
  unassigned: "未指定职责", "role-unavailable": "职责尚不可承接", unlinked: "未链接承载",
  "owned-ready": "自有会话可承接", "external-manual": "外部宿主需人工领取", "host-unverified": "宿主能力未核实",
};
const capabilityLabel = { open: "打开", read: "读取", "manual-claim": "人工领取", start: "启动", send: "发送", interrupt: "中断" };
type PresenceSnapshot = { scope: string; readScope: string; hosts: HostLink[]; domains: BusinessDomain[]; observedAt: string };

export function RolePresenceCard({ token, projectId, roleId, roleState, refresh }: { token: string; projectId: string; roleId: string; roleState: RoleRecord["state"]; refresh: number }) {
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const [routes, setRoutes] = useState<Record<string, DomainRoute>>({});
  const [routeErrors, setRouteErrors] = useState<Record<string, string>>({});
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ scope: string; message: string } | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const routeEpoch = useRef(0);
  const routeRequests = useRef<Record<string, number>>({});
  const base = `/api/projects/${key(projectId)}`;
  const scope = JSON.stringify([token, projectId, roleId]);
  const readScope = JSON.stringify([scope, refresh, readVersion]);
  const currentSnapshot = snapshot?.scope === scope ? snapshot : null;
  const loading = loadingScope === readScope;
  const error = readError?.scope === readScope ? readError.message : "";
  const currentRead = !!currentSnapshot && currentSnapshot.readScope === readScope && !loading && !error;
  const hosts = currentSnapshot?.hosts ?? [];
  const domains = currentSnapshot?.domains ?? [];
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    routeEpoch.current += 1;
    routeRequests.current = {};
    setLoadingScope(readScope); setReadError(null); setRoutes({}); setRouteErrors({});
    void Promise.all([
      request<HostLink[]>(token, `${base}/roles/${key(roleId)}/hosts`, 15000),
      request<BusinessDomain[]>(token, `${base}/domains`, 15000),
    ]).then(([links, allDomains]) => {
      if (!active) return;
      if (links.some(link => link.projectId !== projectId || link.roleId !== roleId) || allDomains.some(domain => domain.projectId !== projectId))
        throw new Error("职责承载响应与当前项目不符");
      setSnapshot({ scope, readScope, hosts: links, domains: allDomains.filter(domain => domain.roleId === roleId), observedAt: new Date().toLocaleString("zh-CN") });
      setRoutes({}); setRouteErrors({});
    }).catch(cause => { if (active) setReadError({ scope: readScope, message: errorText(cause) }); })
      .finally(() => { if (active) setLoadingScope(null); });
    return () => { active = false; routeEpoch.current += 1; };
  }, [expanded, token, projectId, roleId, refresh, readVersion, scope, readScope]);
  async function readRoute(domainId: string) {
    if (!currentRead) return;
    const epoch = routeEpoch.current;
    const requestId = (routeRequests.current[domainId] ?? 0) + 1;
    routeRequests.current[domainId] = requestId;
    const current = () => routeEpoch.current === epoch && routeRequests.current[domainId] === requestId;
    setRoutes(previous => { const next = { ...previous }; delete next[domainId]; return next; });
    setRouteErrors(previous => { const next = { ...previous }; delete next[domainId]; return next; });
    try {
      const route = await request<DomainRoute>(token, `${base}/domains/${key(domainId)}/route`, 15000);
      if (!current()) return;
      if (route.domain.projectId !== projectId || route.domain.id !== domainId) throw new Error("业务领域路由响应不匹配");
      setRoutes(previous => ({ ...previous, [domainId]: route }));
      setRouteErrors(previous => { const next = { ...previous }; delete next[domainId]; return next; });
    } catch (cause) { if (current()) setRouteErrors(previous => ({ ...previous, [domainId]: errorText(cause) })); }
  }
  return <details className="role-presence" onToggle={event => {
    setExpanded(event.currentTarget.open);
    if (event.currentTarget.open) setReadVersion(value => value + 1);
  }}>
    <summary>承载与业务领域</summary>
    {expanded && <>
      <div className="role-presence-head"><span>{currentSnapshot ? `${currentRead ? "读于" : "上次读于"} ${currentSnapshot.observedAt}` : "当前身份尚未读回"}</span><button type="button" onClick={() => { routeEpoch.current += 1; setReadVersion(value => value + 1); }}>重新读取</button></div>
      {loading && <p>正在核对承载与领域…</p>}
      {error && <p role="alert" className="role-presence-error">读取失败：{error}；{currentSnapshot ? "所示内容是上次读回，不能视为当前状态。" : "当前身份没有已核对的承载与领域，不能沿用其他身份的入口。"}</p>}
      {!loading && !error && currentRead && hosts.length === 0 && domains.length === 0 && <p>尚无已登记宿主或业务领域。</p>}
      {hosts.map(host => <article className="role-presence-item" key={host.id}>
        <strong>{host.host.kind === "owned" ? "自有受管 Session" : host.host.provider === "codex-desktop" ? "外部 Codex Desktop 宿主" : "外部宿主（类型未支持）"} · {host.state === "verified" ? "已核实" : host.state === "revoked" ? "已撤权" : "仅登记"}</strong>
        {host.host.kind === "owned" ? <p className="break-anywhere">{currentRead && <><a href={`${href(projectId, "runtime")}?session=${key(host.host.sessionId)}`}>打开 Session 与原线程历史</a> · </>}<code>{host.host.sessionId}</code>{!currentRead && " · 上次读回，暂不可作为当前入口"}</p>
          : <ExternalHostEntry key={`${host.id}:${host.version}:${host.host.ref}`} host={host} roleState={roleState} currentRead={currentRead} />}
        <p>声称能力：{host.claimedCapabilities.map(capability => capabilityLabel[capability]).join("、") || "未声明"}</p>
        <p>已核能力：{host.state === "verified" ? host.verifiedCapabilities.map(capability => capabilityLabel[capability]).join("、") || "无" : "未核实"}</p>
        {host.host.kind === "external" && <p>外部宿主仅按已核能力人工操作；这里不宣称可自动启动或写入。</p>}
      </article>)}
      {domains.map(domain => <article className="role-presence-item" key={domain.id}>
        <strong>业务领域 · {domain.title} · {domain.state === "active" ? "使用中" : "已停用"}</strong>
        <p>{domain.routingReason}</p>
        <button type="button" disabled={!currentRead} onClick={() => void readRoute(domain.id)}>核对当前路由</button>
        {currentRead && routeErrors[domain.id] && <p role="alert" className="role-presence-error">路由读取失败：{routeErrors[domain.id]}；当前路由尚待核对。</p>}
        {currentRead && routes[domain.id] && <p>路由观察：{statusLabel[routes[domain.id]!.status]}。{routes[domain.id]!.session ? `Session ${routes[domain.id]!.session!.id}` : ""}{routes[domain.id]!.status === "external-manual" ? "需要人工领取。" : ""}</p>}
      </article>)}
    </>}
  </details>;
}

function ExternalHostEntry({host,roleState,currentRead}:{host:HostLink;roleState:RoleRecord["state"];currentRead:boolean}) {
  const [copyStatus,setCopyStatus] = useState<""|"copied"|"failed">("");
  const [openRequested,setOpenRequested] = useState(false);
  if (host.host.kind !== "external") return null;
  const ref = host.host.ref;
  const openHref = currentRead ? externalHostOpenHref(host,roleState) : null;
  const reason = externalHostOpenReason(host,roleState,currentRead);
  async function copy() {
    setCopyStatus("");
    try { await navigator.clipboard.writeText(ref); setCopyStatus("copied"); }
    catch { setCopyStatus("failed"); }
  }
  return <div className="external-host-entry">
    <p className="break-anywhere">人工宿主引用：<code>{ref}</code></p>
    <div className="external-host-actions">
      {openHref && <a href={openHref} target="_blank" rel="noopener noreferrer" onClick={() => setOpenRequested(true)}>请求在 Codex Desktop 打开聊天</a>}
      <button type="button" onClick={() => void copy()}>复制完整引用</button>
    </div>
    {reason && <p className="role-presence-error">{reason}</p>}
    {copyStatus === "copied" && <p role="status">已复制完整引用；请在 Codex 中核对目标聊天。</p>}
    {copyStatus === "failed" && <p role="alert" className="role-presence-error">复制失败；可选中上方完整引用手工复制。</p>}
    {openHref && <p>{openRequested ? "已尝试请求打开。" : "点击会向本机 Codex Desktop 请求打开。"}如未打开，请在 Codex 中按完整引用查找或人工交接；这里不能确认已打开或已送达。</p>}
    {!openHref && <p>可选中上方完整引用手工查找或交接；不要据此推定当前宿主可承接。</p>}
  </div>;
}
