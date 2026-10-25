import { useEffect, useRef, useState } from "react";
import type { BusinessDomain, DomainRoute, HostLink } from "@evoloop/contracts/resident-hosts";
import { errorText, request } from "../api";
import { href } from "../ui/shared";
import "./presence.css";

const key = encodeURIComponent;
const statusLabel: Record<DomainRoute["status"], string> = {
  unassigned: "未指定职责", "role-unavailable": "职责尚不可承接", unlinked: "未链接承载",
  "owned-ready": "自有会话可承接", "external-manual": "外部宿主需人工领取", "host-unverified": "宿主能力未核实",
};
const capabilityLabel = { open: "打开", read: "读取", "manual-claim": "人工领取", start: "启动", send: "发送", interrupt: "中断" };

export function RolePresenceCard({ token, projectId, roleId, refresh }: { token: string; projectId: string; roleId: string; refresh: number }) {
  const [expanded, setExpanded] = useState(false);
  const [hosts, setHosts] = useState<HostLink[]>([]);
  const [domains, setDomains] = useState<BusinessDomain[]>([]);
  const [routes, setRoutes] = useState<Record<string, DomainRoute>>({});
  const [routeErrors, setRouteErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const routeEpoch = useRef(0);
  const routeRequests = useRef<Record<string, number>>({});
  const base = `/api/projects/${key(projectId)}`;
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    routeEpoch.current += 1;
    routeRequests.current = {};
    setLoading(true); setError("");
    void Promise.all([
      request<HostLink[]>(token, `${base}/roles/${key(roleId)}/hosts`, 15000),
      request<BusinessDomain[]>(token, `${base}/domains`, 15000),
    ]).then(([links, allDomains]) => {
      if (!active) return;
      if (links.some(link => link.projectId !== projectId || link.roleId !== roleId) || allDomains.some(domain => domain.projectId !== projectId))
        throw new Error("职责承载响应与当前项目不符");
      setHosts(links); setDomains(allDomains.filter(domain => domain.roleId === roleId)); setRoutes({}); setRouteErrors({});
      setObservedAt(new Date().toLocaleString("zh-CN"));
    }).catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; routeEpoch.current += 1; };
  }, [expanded, token, projectId, roleId, refresh, readVersion]);
  async function readRoute(domainId: string) {
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
  return <details className="role-presence" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>承载与业务领域</summary>
    {expanded && <>
      <div className="role-presence-head"><span>{observedAt ? `读于 ${observedAt}` : "尚未读回"}</span><button type="button" onClick={() => { routeEpoch.current += 1; setReadVersion(value => value + 1); }}>重新读取</button></div>
      {loading && <p>正在核对承载与领域…</p>}
      {error && <p role="alert" className="role-presence-error">读取失败：{error}；所示内容是上次读回，不能视为当前状态。</p>}
      {!loading && !error && hosts.length === 0 && domains.length === 0 && <p>尚无已登记宿主或业务领域。</p>}
      {hosts.map(host => <article className="role-presence-item" key={host.id}>
        <strong>{host.host.kind === "owned" ? "自有受管 Session" : "外部 Codex Desktop 宿主"} · {host.state === "verified" ? "已核实" : host.state === "revoked" ? "已撤权" : "仅登记"}</strong>
        <p className="break-anywhere">{host.host.kind === "owned" ? <><a href={`${href(projectId, "runtime")}?session=${key(host.host.sessionId)}`}>打开 Session 与原线程历史</a> · <code>{host.host.sessionId}</code></> : <>人工宿主引用：<code>{host.host.ref}</code></>}</p>
        <p>声称能力：{host.claimedCapabilities.map(capability => capabilityLabel[capability]).join("、") || "未声明"}</p>
        <p>已核能力：{host.state === "verified" ? host.verifiedCapabilities.map(capability => capabilityLabel[capability]).join("、") || "无" : "未核实"}</p>
        {host.host.kind === "external" && <p>外部宿主仅按已核能力人工操作；这里不宣称可自动启动或写入。</p>}
      </article>)}
      {domains.map(domain => <article className="role-presence-item" key={domain.id}>
        <strong>业务领域 · {domain.title} · {domain.state === "active" ? "使用中" : "已停用"}</strong>
        <p>{domain.routingReason}</p>
        <button type="button" onClick={() => void readRoute(domain.id)}>核对当前路由</button>
        {routeErrors[domain.id] && <p role="alert" className="role-presence-error">路由读取失败：{routeErrors[domain.id]}；当前路由尚待核对。</p>}
        {routes[domain.id] && <p>路由观察：{statusLabel[routes[domain.id]!.status]}。{routes[domain.id]!.session ? `Session ${routes[domain.id]!.session!.id}` : ""}{routes[domain.id]!.status === "external-manual" ? "需要人工领取。" : ""}</p>}
      </article>)}
    </>}
  </details>;
}
