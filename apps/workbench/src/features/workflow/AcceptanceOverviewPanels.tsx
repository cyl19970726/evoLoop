import type { AcceptanceHumanItem } from "@evoloop/contracts/acceptance-relay";
import { ShortId, href } from "../../shared/ui/shared";

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
