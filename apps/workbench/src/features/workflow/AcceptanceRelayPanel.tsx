import { useEffect, useState } from "react";
import type { AcceptanceRelayView } from "@evoloop/contracts/acceptance-relay";
import { api, errorText } from "../../shared/api";
import { date } from "../../shared/ui/shared";

const stageLabel = { candidate: "候选验收", formal: "正式复验" };
const stateLabel = { pending: "等待投递或接手", linked: "消息已入队", blocked: "投递受阻", superseded: "已被替代", released: "已释放" };

export function AcceptanceRelayPanel({token,projectId,taskId,refresh}: {
  token:string; projectId:string; taskId:string; refresh:number;
}) {
  const [items,setItems]=useState<AcceptanceRelayView[]|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let current=true;
    setItems(null);setError("");
    api(token).acceptanceRelay(projectId,taskId).then(result=>{
      if(current)setItems(result.items);
    }).catch(cause=>{if(current)setError(errorText(cause));});
    return ()=>{current=false;};
  },[token,projectId,taskId,refresh]);
  return <section className="panel task-focus" aria-label="验收接力">
    <h2>验收接力</h2>
    {error && <p role="status">验收安排暂未读回：{error}</p>}
    {!error && items===null && <p role="status">正在读取验收安排…</p>}
    {items?.length===0 && <p>当前没有具体的验收安排。</p>}
    {items?.map(item=><div key={item.relayId} className="task-result-facts">
      <p><strong>{stageLabel[item.stage]} · {item.scopeKey}</strong> · {stateLabel[item.state]}</p>
      <p>{item.scopeDescription}</p>
      <p>接续：{item.mode==="human"?"指定的人":item.mode==="leader"?"指定 Leader Session":"指定业务 Session"} · {item.recipientActorId}
        {item.sessionId && <> · Session {item.sessionId.slice(0,8)}</>}</p>
      <p>固定交付 {item.deliveryId.slice(0,8)} · {date(item.createdAt)}</p>
      {item.entrypoint && <p>使用入口：{item.entrypoint}</p>}
      {item.blockedReason && <p role="status">待处理：{item.blockedReason}</p>}
      <p>消息：{item.messageState??"尚未投递"} · 运行：{item.processingState??"尚未开始"} · 接收者读取：{item.readActorId||item.humanReadAt?"已记录":"未记录"} · 使用观察：{item.observationResult??"尚未关联"}</p>
    </div>)}
  </section>;
}
