import { useEffect, useRef, useState } from "react";
import type { DeliveryAttempt, DeliveryRecord, IncomingRecord } from "@evoloop/contracts/delivery";
import { api, errorText, isUnconfirmed } from "../api";
import { Notice, type MutationContext } from "../workflow/ActionForm";
import { collaborationClient } from "./client";

const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const deliveryLabel: Record<DeliveryRecord["state"],string> = { pending:"待投影",claimed:"已领取",dispatching:"正在请求",applied:"远端回读已匹配",unknown:"结果未知，需对账",conflict:"远端冲突",failed:"请求失败" };
type Receipt = { projectId:string;actorId:string;kind:"reconcile"|"retry"|"poll"|"review";id:string;operationId?:string;createdAt:string };
const storageKey = "evoloop:collaboration:uncertain";
function receipts(): Receipt[] { try { const value=JSON.parse(sessionStorage.getItem(storageKey) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
function remember(receipt: Receipt): void { try { sessionStorage.setItem(storageKey,JSON.stringify([...receipts().filter(x=>!(x.projectId===receipt.projectId && x.kind===receipt.kind && x.id===receipt.id)),receipt].slice(-100))); } catch { /* in-memory warning still shown */ } }
function clearReceipt(projectId:string,kind:Receipt["kind"],id:string): void { try { sessionStorage.setItem(storageKey,JSON.stringify(receipts().filter(x=>!(x.projectId===projectId && x.kind===kind && x.id===id)))); } catch { /* UI still refreshes */ } }

export function CollaborationPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [configured,setConfigured]=useState(false), [verifiedAt,setVerifiedAt]=useState<string|null>(null), [connectionError,setConnectionError]=useState<string|null>(null);
  const [deliveries,setDeliveries]=useState<DeliveryRecord[]>([]), [deliveryCursor,setDeliveryCursor]=useState<string|null>(null);
  const [incoming,setIncoming]=useState<IncomingRecord[]>([]), [incomingCursor,setIncomingCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(""), [moreError,setMoreError]=useState(""), [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<Receipt[]>([]);
  const epoch=useRef(0), moreBusy=useRef(false);
  const client=collaborationClient(context.token,context.projectId);
  useEffect(()=>{
    const current=++epoch.current; let active=true;
    setLoading(true);setError("");setMoreError("");setDeliveries([]);setIncoming([]);setDeliveryCursor(null);setIncomingCursor(null);
    setPending(receipts().filter(x=>x.projectId===context.projectId && x.actorId===context.principal.actorId));
    collaborationClient(context.token,context.projectId).overview().then(value=>{ if(!active||epoch.current!==current)return;
      setConfigured(value.configured);setVerifiedAt(value.verifiedAtUtc);setConnectionError(value.error);
      setDeliveries(value.deliveries.items);setDeliveryCursor(value.deliveries.nextCursor);
      setIncoming(value.incoming.items);setIncomingCursor(value.incoming.nextCursor);
    }).catch(cause=>{if(active&&epoch.current===current)setError(errorText(cause));}).finally(()=>{if(active&&epoch.current===current)setLoading(false);});
    return ()=>{active=false;if(epoch.current===current)epoch.current++;};
  },[context.token,context.projectId,context.principal.actorId,refresh]);
  async function loadMore(which:"deliveries"|"incoming") {
    const cursor=which==="deliveries"?deliveryCursor:incomingCursor;
    if(!cursor||moreBusy.current)return; moreBusy.current=true;setMoreError(""); const current=epoch.current;
    try { if(which==="deliveries") { const page=await client.deliveries(cursor); if(epoch.current===current){setDeliveries(old=>[...new Map([...old,...page.items].map(x=>[x.eventId,x])).values()]);setDeliveryCursor(page.nextCursor);} }
      else {const page=await client.incoming(cursor);if(epoch.current===current){setIncoming(old=>[...new Map([...old,...page.items].map(x=>[x.id,x])).values()]);setIncomingCursor(page.nextCursor);}}
    } catch(cause){if(epoch.current===current)setMoreError(errorText(cause));} finally{moreBusy.current=false;}
  }
  async function action(kind:Receipt["kind"],id:string,operationId:string|undefined,send:()=>Promise<unknown>) {
    if(busy||context.blocked)return;setBusy(true);setError("");
    try {const result=await send();
      if (typeof result === "object" && result !== null && "state" in result && result.state === "unknown") {
        const receipt:Receipt={projectId:context.projectId,actorId:context.principal.actorId,kind,id,operationId,createdAt:new Date().toISOString()};
        remember(receipt);setPending(receipts().filter(x=>x.projectId===context.projectId&&x.actorId===context.principal.actorId));
        setError("原操作结果仍未核实；保留回执，稍后按原 ID 回读。");context.onChanged();return;
      }
      clearReceipt(context.projectId,kind,id);setPending(receipts().filter(x=>x.projectId===context.projectId&&x.actorId===context.principal.actorId));context.onChanged();}
    catch(cause){if(isUnconfirmed(cause)){const receipt:Receipt={projectId:context.projectId,actorId:context.principal.actorId,kind,id,operationId,createdAt:new Date().toISOString()};remember(receipt);setPending(receipts().filter(x=>x.projectId===context.projectId&&x.actorId===context.principal.actorId));}
      setError(`${errorText(cause)}${isUnconfirmed(cause)?"；已保留对象/操作 ID，请回读核对，确认前不要重复提交。":""}`);}
    finally{setBusy(false);}
  }
  async function checkReceipt(receipt:Receipt) {
    if(busy)return;setBusy(true);setError("");
    try {
      let settled=false;let message="结果仍未核实；保留原对象/操作 ID，稍后回读尝试记录。";
      if(receipt.kind==="review") {
        const item=await client.incomingItem(receipt.id);
        settled=!!item&&["applied","rejected","conflict"].includes(item.state);
        if(!settled&&receipt.operationId) {
          try { const operation=await api(context.token).operation(context.projectId,receipt.operationId);
            message=`原任务操作已记录为 ${operation.result.status}，候选仍需审阅结案；保留回执。`;
          } catch { message="原任务操作仍未核实；保留回执，不重发。"; }
        }
      } else if(receipt.kind==="poll") {
        const overview=await client.overview(); settled=!!overview.verifiedAtUtc&&Date.parse(overview.verifiedAtUtc)>=Date.parse(receipt.createdAt);
      } else {
        const item=await client.delivery(receipt.id);
        settled=!!item&&(receipt.kind==="reconcile"?["applied","conflict","failed"].includes(item.state):item.state!=="failed");
      }
      if(settled){clearReceipt(context.projectId,receipt.kind,receipt.id);setPending(receipts().filter(x=>x.projectId===context.projectId&&x.actorId===context.principal.actorId));context.onChanged();}
      else setError(message);
    }catch(cause){setError(`核对失败：${errorText(cause)}。保留回执。`);}finally{setBusy(false);}
  }
  const allowed=context.principal.permissions.includes("review")&&context.principal.permissions.includes("write")&&!context.blocked;
  return <div className="journey-board"><section className="panel"><div className="panel-head"><h2>飞书任务协作</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {loading&&<p>正在读取协作状态…</p>}{error&&<Notice error>{error}</Notice>}
    {!loading&&!error&&<><p><strong>{!configured?"未配置":verifiedAt?"已核实远端读取":"已配置，尚未核实远端读取"}</strong>{verifiedAt&&` · 最近核实 ${stamp(verifiedAt)}`}</p>
      {connectionError&&<Notice error>{connectionError}</Notice>}
      <p>任务、投影同步、通知和实际阅读分别核对；远端表格不会直接改写已接受任务。</p>
      {configured&&<button type="button" disabled={!allowed||busy||pending.some(x=>x.kind==="poll")} onClick={()=>void action("poll",context.projectId,undefined,()=>client.poll())}>回读远端变化</button>}
      {pending.length>0&&<Notice error>有 {pending.length} 项写入结果尚未核实。仅保存项目、对象与操作 ID，没有保存令牌。先回读状态和尝试记录；未知投影只可对账。</Notice>}
      {pending.map(receipt=><p key={`${receipt.kind}:${receipt.id}`} className="break-anywhere">{receipt.kind} · {receipt.id}{receipt.operationId&&` · 操作 ${receipt.operationId}`} <button type="button" disabled={busy} onClick={()=>void checkReceipt(receipt)}>按原 ID 核对</button>{receipt.kind==="review"&&incoming.some(item=>item.id===receipt.id&&item.state==="unknown")&&<button type="button" disabled={busy||!allowed} onClick={()=>void action("review",receipt.id,receipt.operationId,()=>client.review(receipt.id,"apply","按原任务操作 ID 复核结案"))}>按原任务操作结案</button>}</p>)}
      <h3>投影状态</h3>{deliveries.length===0&&<p className="empty">尚无任务投影记录；未配置或无待投影事件不能解释为已同步。</p>}
      {deliveries.map(item=><DeliveryCard key={item.eventId} item={item} context={context} busy={busy||pending.some(x=>x.id===item.eventId)} configured={configured} onAction={action} />)}
      {deliveryCursor&&<button type="button" className="more" onClick={()=>void loadMore("deliveries")}>加载更多投影</button>}
      <h3>远端修改候选</h3>{incoming.length===0&&<p className="empty">尚无远端候选；轮询没有可靠修改人身份时只能人工审阅。</p>}
      {incoming.map(item=><IncomingCard key={item.id} item={item} context={context} busy={busy||pending.some(x=>x.id===item.id)} onAction={action} />)}
      {incomingCursor&&<button type="button" className="more" onClick={()=>void loadMore("incoming")}>加载更多候选</button>}
      {moreError&&<Notice error>{moreError}</Notice>}
    </>}
  </section></div>;
}

function DeliveryCard({item,context,busy,configured,onAction}:{item:DeliveryRecord;context:MutationContext;busy:boolean;configured:boolean;onAction:(kind:Receipt["kind"],id:string,operationId:string|undefined,send:()=>Promise<unknown>)=>Promise<void>}) {
  const [attempts,setAttempts]=useState<DeliveryAttempt[]|null>(null),[error,setError]=useState(""),[reason,setReason]=useState("");
  const client=collaborationClient(context.token,context.projectId);
  const allowed=configured&&context.principal.permissions.includes("review")&&context.principal.permissions.includes("write")&&!context.blocked&&!busy;
  return <article className="decision"><strong>{deliveryLabel[item.state]}</strong><p>任务 <code>{item.taskId}</code> · 本地版本 {item.taskVersion}</p><p>{item.lastReason??"等待协调器处理"}</p>
    <small>事件 {item.eventId} · 更新 {stamp(item.updatedAtUtc)}</small>
    {(item.state==="unknown"||item.state==="failed")&&<div className="workflow-form"><label>处理依据<input value={reason} onChange={event=>setReason(event.target.value)} /></label>
      <button type="button" disabled={!allowed||!reason.trim()} onClick={()=>void onAction(item.state==="unknown"?"reconcile":"retry",item.eventId,item.operationId,
        ()=>item.state==="unknown"?client.reconcile(item.eventId,reason):client.retry(item.eventId,reason))}>{item.state==="unknown"?"按稳定键对账":"请求重新投影"}</button></div>}
    <button type="button" onClick={()=>void client.attempts(item.eventId).then(setAttempts).catch(cause=>setError(errorText(cause)))}>阅读尝试证据</button>
    {error&&<Notice error>{error}</Notice>}{attempts?.map(attempt=><p key={attempt.id}>{attempt.action} → {deliveryLabel[attempt.outcome]} · {attempt.reason} · {stamp(attempt.createdAtUtc)}</p>)}
  </article>;
}
function IncomingCard({item,context,busy,onAction}:{item:IncomingRecord;context:MutationContext;busy:boolean;onAction:(kind:Receipt["kind"],id:string,operationId:string|undefined,send:()=>Promise<unknown>)=>Promise<void>}) {
  const [reason,setReason]=useState(""); const client=collaborationClient(context.token,context.projectId);
  const allowed=context.principal.permissions.includes("review")&&context.principal.permissions.includes("write")&&!context.blocked&&!busy;
  const canApply=item.state==="pending"&&!item.reviewOnly&&!!item.actor?.verified&&!!item.patch.title&&!item.patch.status;
  return <article className="decision"><strong>{item.state}{item.reviewOnly?" · 仅供审阅":""}</strong><p>任务 <code>{item.entityId}</code> · 观察的本地版本 {item.observedLocalVersion}</p>
    <p>远端记录 {item.remoteRecordId} · 修改人 {item.actor?.verified?item.actor.projectActorId:"未核实"}</p>
    <p>建议字段：{item.patch.title?`标题「${item.patch.title}」`:"无标题修改"}{item.patch.status?`；远端状态「${item.patch.status}」须走普通任务流程`:""}</p>
    {item.reason&&<p>限制：{item.reason}</p>}
    {(["pending","review-only"] as string[]).includes(item.state)&&<div className="workflow-form"><label>审阅理由<input value={reason} onChange={event=>setReason(event.target.value)} /></label>
      {canApply&&<button type="button" disabled={!allowed||!reason.trim()} onClick={()=>void onAction("review",item.id,item.operationId,()=>client.review(item.id,"apply",reason))}>按当前基线提出任务修订</button>}
      <button type="button" disabled={!allowed||!reason.trim()} onClick={()=>void onAction("review",item.id,item.operationId,()=>client.review(item.id,"reject",reason))}>保留记录并拒绝回写</button></div>}
    {item.state==="unknown"&&<Notice error>任务操作结果未知：按操作 ID <code>{item.operationId}</code> 回读后再决定；请勿重建新操作。</Notice>}
  </article>;
}
