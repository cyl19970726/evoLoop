// 承载与业务领域: which hosts (项目受管智能体, external chats) carry this Role and which business domains route to it.
// An entry (open a chat, follow a session, check a route) is offered only while the last read is current; a failed or
// running reread keeps the old list on screen, says so, and withdraws the entries.
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { BusinessDomain, DomainRoute, HostLink } from "@evoloop/contracts/resident-hosts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { Button, LoadingState, Notice, cn } from "@evoloop/ui";
import { errorText, request } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { externalHostOpenHref, externalHostOpenReason } from "../../shared/externalHostEntry";
import { useProjectQuery } from "../../shared/query";
import { hereOrigin, withReturn } from "../../shared/returnLink";
import { href } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { SessionName } from "../../shared/ui/RecordName";
import { PageSection, mutedText } from "../../shared/ui/PageParts";
import { capabilitiesText, hostTitle, roleActions, routeStatusText } from "./rolePresentation";
import { registerHostForm, verifyHostForm } from "./roleForms";
import { failureOf, type Failure } from "../../shared/errorPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const key = encodeURIComponent;
const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });
type RouteRead = { epoch: number; route?: DomainRoute; error?: Failure };

export function RolePresence({ context, role }: { context: MutationContext; role: RoleRecord }) {
  const { projectId } = context;
  const base = `/api/projects/${key(projectId)}`;
  const read = useProjectQuery(projectId, ["roles", role.id, "presence"], async signal => {
    const [links, domains] = await Promise.all([
      request<HostLink[]>("", `${base}/roles/${key(role.id)}/hosts`, 15000, { signal }),
      request<BusinessDomain[]>("", `${base}/domains`, 15000, { signal }),
    ]);
    if (!Array.isArray(links) || !Array.isArray(domains)) throw new Error("承载响应不完整");
    if (links.some(link => link.projectId !== projectId || link.roleId !== role.id) || domains.some(domain => domain.projectId !== projectId))
      throw new Error("职责承载响应与当前项目不符");
    return { hosts: links, domains: domains.filter(domain => domain.roleId === role.id) };
  });
  const [routes, setRoutes] = useState<Record<string, RouteRead>>({});
  const error = read.error ? errorText(read.error) : "";
  const current = !!read.data && !read.isFetching && !error;
  const epoch = read.dataUpdatedAt;
  const hosts = read.data?.hosts ?? [];
  const domains = read.data?.domains ?? [];
  async function checkRoute(domainId: string) {
    if (!current) return;
    const started = epoch;
    setRoutes(previous => ({ ...previous, [domainId]: { epoch: started } }));
    try {
      const route = await request<DomainRoute>("", `${base}/domains/${key(domainId)}/route`, 15000);
      if (route.domain.projectId !== projectId || route.domain.id !== domainId) throw new Error("业务领域路由响应不匹配");
      setRoutes(previous => previous[domainId]?.epoch === started ? { ...previous, [domainId]: { epoch: started, route } } : previous);
    } catch (cause) {
      setRoutes(previous => previous[domainId]?.epoch === started ? { ...previous, [domainId]: { epoch: started, error: failureOf(cause) } } : previous);
    }
  }
  const actions = roleActions(role.state);
  return <PageSection title="承载与业务领域" description="谁在承载这项职责：项目受管智能体或已登记的外部聊天，以及按业务领域路由到这里的工作。"
    action={<Button size="compact" variant="ghost" aria-label="重新读取承载" disabled={read.isFetching && !read.data} onClick={() => void read.refetch()}>
      <RefreshCw aria-hidden="true" className={read.isFetching ? "animate-spin" : undefined} />重新读取</Button>}>
    <p className={mutedText} data-presence-read="">{read.data ? `${current ? "读于" : "上次读于"} ${stamp(epoch)}` : read.isPending ? "正在读取承载与业务领域…" : "当前身份尚未读回"}</p>
    {read.isPending && <LoadingState lines={2} label="正在读取承载" />}
    {error && <Notice tone="error" title="读取失败">读取失败：{error}；{read.data ? "所示内容是上次读回，不能视为当前状态。" : "当前身份没有已核对的承载与领域，不能沿用其他身份的入口。"}<ErrorDetails error={read.error} /></Notice>}
    {current && hosts.length === 0 && domains.length === 0 && <p className="text-small text-text-secondary">尚无已登记的承载或业务领域。</p>}
    {(hosts.length > 0 || domains.length > 0) && <ul aria-label="承载与业务领域" className="flex flex-col overflow-hidden rounded-xl bg-raised shadow-sm">
      {hosts.map(host => <li key={host.id} className="flex min-w-0 flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0">
        <strong className="text-small font-semibold text-foreground">{hostTitle(host)}</strong>
        {host.host.kind === "owned"
          ? <OwnedHost projectId={projectId} sessionId={host.host.sessionId} current={current} actorId={context.principal.actorId} />
          : <ExternalHost key={`${host.id}:${host.version}:${host.host.ref}`} host={host} roleState={role.state} current={current} />}
        <p className="text-small text-text-secondary">声称能力：{capabilitiesText(host.claimedCapabilities) || "未声明"}</p>
        <p className="text-small text-text-secondary">已核能力：{host.state === "verified" ? capabilitiesText(host.verifiedCapabilities) || "无" : "未核实"}</p>
        {host.host.kind === "external" && <p className={mutedText}>外部宿主仅按已核能力人工操作；这里不宣称可自动启动或写入。</p>}
        {host.host.kind === "external" && host.state === "registered" && actions.connect && current && <details className="text-small">
          <summary className="cursor-pointer text-primary">核实人工连接能力</summary>
          <ActionForm context={context} review embedded {...verifyHostForm(role, host)} />
        </details>}
      </li>)}
      {domains.map(domain => {
        const routeRead = routes[domain.id];
        const shown = current && routeRead?.epoch === epoch ? routeRead : undefined;
        return <li key={domain.id} className="flex min-w-0 flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0">
          <strong className="text-small font-semibold text-foreground">业务领域 · {domain.title} · {domain.state === "active" ? "使用中" : "已停用"}</strong>
          <p className="text-small text-text-secondary">{domain.routingReason}</p>
          <Button size="compact" className="w-fit" disabled={!current} onClick={() => void checkRoute(domain.id)}>核对当前路由</Button>
          {shown?.error && <div role="alert" className="text-small text-destructive">路由读取失败：{shown.error.text}；当前路由尚待核对。<ErrorDetails failure={shown.error} /></div>}
          {shown?.route && <p className="text-small text-foreground">路由观察：{routeStatusText(shown.route.status)}。{shown.route.session
            ? <><SessionName projectId={projectId} sessionKey={`owned:${shown.route.session.id}`} kind="受管智能体" />。</> : ""}{shown.route.status === "external-manual" ? "需要人工领取。" : ""}</p>}
          {shown?.route?.session && <FullIdentifiers rows={[{ label: "受管智能体", value: shown.route.session.id }]} />}
        </li>;
      })}
    </ul>}
    {actions.connect && <details className="text-small">
      <summary className="cursor-pointer text-primary">登记已有 Codex 聊天</summary>
      <p className={cn(mutedText, "mt-2")}>只登记原聊天引用；实际打开、读取和人工领取须另行核实。登记不表示会自动发送或启动。</p>
      <ActionForm context={context} review embedded {...registerHostForm(role)} />
    </details>}
  </PageSection>;
}

function OwnedHost({ projectId, sessionId, current, actorId }: { projectId: string; sessionId: string; current: boolean; actorId: string }) {
  return <>
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
      {current ? <>
        <a className="text-primary hover:underline" href={`${href(projectId, "runtime")}?session=${key(sessionId)}`}>查看运行与队列</a>
        <a className="text-primary hover:underline" href={withReturn(`${href(projectId, "sessions")}?session=${key(`owned:${sessionId}`)}`, hereOrigin(actorId))}>在智能体空间打开</a>
      </> : <span className={mutedText}>上次读回，暂不可作为当前入口</span>}
      <span className={mutedText}><SessionName projectId={projectId} sessionKey={`owned:${sessionId}`} /></span>
    </p>
    <FullIdentifiers rows={[{ label: "智能体", value: sessionId }]} />
  </>;
}

function ExternalHost({ host, roleState, current }: { host: HostLink; roleState: RoleRecord["state"]; current: boolean }) {
  const [copy, setCopy] = useState<"" | "copied" | "failed">("");
  const [opened, setOpened] = useState(false);
  if (host.host.kind !== "external") return null;
  const ref = host.host.ref;
  const openHref = current ? externalHostOpenHref(host, roleState) : null;
  const reason = externalHostOpenReason(host, roleState, current);
  return <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-2">
      {openHref && <Button asChild size="compact"><a href={openHref} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>请求在 Codex Desktop 打开聊天</a></Button>}
      <Button size="compact" variant="ghost" onClick={async () => {
        setCopy("");
        try { await navigator.clipboard.writeText(ref); setCopy("copied"); } catch { setCopy("failed"); }
      }}>复制完整引用</Button>
    </div>
    {reason && <p className="text-small text-destructive">{reason}</p>}
    {copy === "copied" && <p role="status" className="text-small text-text-secondary">已复制完整引用；请在 Codex 中核对目标聊天。</p>}
    {copy === "failed" && <p role="alert" className="text-small text-destructive">复制失败；可展开下方“完整标识”手工复制完整引用。</p>}
    {openHref && <p className={mutedText}>{opened ? "已尝试请求打开。" : "点击会向本机 Codex Desktop 请求打开。"}如未打开，请在 Codex 中按完整引用查找或人工交接；这里不能确认已打开或已送达。</p>}
    {!openHref && <p className={mutedText}>可展开下方“完整标识”按完整引用手工查找或交接；不要据此推定当前宿主可承接。</p>}
    <FullIdentifiers summary="完整标识" rows={[{ label: "聊天完整引用", value: ref }]} />
  </div>;
}
