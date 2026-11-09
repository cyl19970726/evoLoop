import type { AcceptanceHumanItem, AcceptanceOverviewView } from "@evoloop/contracts/acceptance-relay";
import { ShortId, href } from "../../shared/ui/shared";
import { leaderPhaseLabel } from "../../shared/leaderWorkLoad";

const phaseOrder = ["rework", "blocked", "awaiting_delivery", "awaiting_acceptance",
  "awaiting_assignment", "ready", "running", "unassigned", "unknown"] as const;

export function AcceptanceCapacitySummary({ overview, projectId, error }: {
  overview: AcceptanceOverviewView | null; projectId: string; error: string;
}) {
  if (error) return <section className="panel leader-capacity" aria-label="阶段与验收容量">
    <h2>阶段与验收容量</h2><p role="status">容量暂未读回：{error}</p></section>;
  if (!overview) return <section className="panel leader-capacity" aria-label="阶段与验收容量">
    <h2>阶段与验收容量</h2><p role="status">正在读取阶段与容量…</p></section>;
  const counts = overview.work?.counts;
  const capacity = Array.isArray(overview.capacity) ? overview.capacity : [];
  const ready = capacity.filter(item => item.readyForAcceptance).length;
  const idle = capacity.filter(item => item.persistedWorkIdle).length;
  const missing = capacity.filter(item => item.missingCapabilities.length > 0).length;
  return <section className="panel leader-capacity" aria-label="阶段与验收容量">
    <header><div><p className="eyebrow">Leader 容量对账</p><h2>哪些阶段可以并行，谁还能接工作</h2></div>
      <p>{overview.observedAt ? `读于 ${new Date(overview.observedAt).toLocaleString("zh-CN")}` : "尚未读回"}</p></header>
    {counts && <div className="leader-work-phases">{phaseOrder.filter(phase => counts[phase]).map(phase =>
      <span key={phase} className={`leader-phase phase-${phase}`}>{leaderPhaseLabel[phase]} <strong>{counts[phase]}</strong></span>)}
    </div>}
    <p className="leader-capacity-summary">{capacity.length} 个 Session · {ready} 个可接新验收 · {idle} 个持久工作已清 · {missing} 个有能力缺项</p>
    {capacity.length ? <ul className="leader-capacity-list">{capacity.map(item =>
      <li key={item.sessionId}>
        <strong>{item.isLeader ? "Leader" : <ShortId value={item.roleId}/>}</strong>
        <span>{item.state} · {item.tenure} · Session <ShortId value={item.sessionId}/></span>
        <span>{item.persistedWorkIdle ? "持久工作已清" : "仍在工作"} · 验收 {item.openAcceptance} · 消息 {item.pendingMessages} · 队列 {item.queueEntries}</span>
        <span>{item.readyForAcceptance ? "可接验收" : item.missingCapabilities.length
          ? `缺：${item.missingCapabilities.join("、")}` : "不可接验收"}</span>
        <a href={`${href(projectId, "sessions")}?session=${encodeURIComponent(`owned:${item.sessionId}`)}&tab=overview`}>打开 Session</a>
      </li>)}</ul> : <p className="empty">当前没有可读取的 Session。</p>}
    <footer>容量只说明数据库义务已清；原生 writer、当前执行配置和消息授权仍按缺项单独核对。此处不会自动创建授权。</footer>
  </section>;
}

export function HumanAcceptanceInbox({ items, projectId, error }: {
  items: AcceptanceHumanItem[] | null; projectId: string; error: string;
}) {
  return <section className="panel impact-summary" aria-label="待我验收">
    <div className="panel-head"><h2>待我验收</h2><span>{items?.length ?? 0} 项</span></div>
    {error && <p role="status">待验收列表暂未读回：{error}</p>}
    {!error && items === null && <p role="status">正在读取待验收事项…</p>}
    {items?.length === 0 && <p className="empty">当前没有分配给我的验收事项。</p>}
    {!!items?.length && <ul className="impact-list">{items.map(item => <li key={item.relayId}>
      <a href={href(projectId, "task", item.taskId)}>
        <strong>{item.stage === "formal" ? "正式复验" : "候选验收"} · {item.scopeKey}</strong>
        <span>{item.scopeDescription}</span>
        <span>固定交付 <ShortId value={item.deliveryId}/> · 安排 v{item.version} · 读于 {item.readAt ? new Date(item.readAt).toLocaleString("zh-CN") : "尚未读取"} · {item.observationId ? "已有观察" : "尚未留观察"}</span>
        <span>{item.entrypoint ?? "按当前交付读取"}</span>
        <span>本人读取和观察用 CLI：work acceptance read/observe</span>
      </a>
    </li>)}</ul>}
  </section>;
}
