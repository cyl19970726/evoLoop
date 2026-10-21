import { useEffect, useState } from "react";
import type { RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import { api } from "../api";
import { runtimeClient } from "../runtime/client";
import { deliveryTarget, verifiedDocumentTitle, type DeliveryArtifactInput, type DeliveryTarget } from "./deliveryPresentation";

type Delivery = NonNullable<TaskDetail["deliveries"]>[number];
type ArtifactName = { title: string | null; checked: boolean };

export function useDeliveryNames(token: string, projectId: string, deliveries: Delivery[]): Record<string, ArtifactName> {
  const [names, setNames] = useState<Record<string, ArtifactName>>({});
  useEffect(() => {
    let active = true;
    setNames({});
    // The task detail already bounds this collection. Read only the same project's
    // declared document IDs and exact fixed revisions; never fetch an artifact URL.
    void (async () => {
      for (const delivery of deliveries) {
        const target = deliveryTarget(delivery, projectId);
        if (target.kind !== "document") continue;
        let title: string | null = null;
        try {
          const [document, revision] = await Promise.all([
            api(token).document(projectId, target.documentId),
            api(token).documentRevision(projectId, target.documentId, target.revisionId),
          ]);
          title = verifiedDocumentTitle(delivery, target, projectId, document.document, revision);
        } catch { /* A failed read must not turn unverified metadata into a title. */ }
        if (!active) return;
        setNames(current => ({ ...current, [delivery.id]: { title, checked: true } }));
      }
    })();
    return () => { active = false; };
  }, [token, projectId, deliveries]);
  return names;
}

export function DeliveryArtifact({ delivery, projectId, name }: { delivery: DeliveryArtifactInput; projectId: string; name?: ArtifactName }) {
  const target: DeliveryTarget = deliveryTarget(delivery, projectId);
  const label = target.kind === "document"
    ? name?.title || `正式文档 ${target.documentId.slice(0, 8)}（标题未核实）`
    : target.label;
  const link = target.href
    ? <a className="delivery-artifact-link" href={target.href} target={target.href.startsWith("#") ? undefined : "_blank"} rel={target.href.startsWith("#") ? undefined : "noopener noreferrer"}>{label} ↗</a>
    : <strong className="delivery-artifact-link">{label}</strong>;
  return <div className="delivery-artifact">
    <div className="delivery-artifact-main">{link}{target.kind !== "fallback" && <span className="delivery-artifact-version">{target.kind === "knowledge" ? "知识固定修订" : target.kind === "evaluation" ? "评价固定定义" : "文档固定修订"} <code title={target.revisionId}>{target.revisionId.slice(0, 8)}</code></span>}</div>
    {(target.kind === "knowledge" || target.kind === "evaluation") && <p className="task-fineprint">入口指向固定修订；交付产物声明版本另见下方核对信息。</p>}
    {target.kind === "document" && name?.title && <p className="task-fineprint">文档现名称；入口固定到本次交付的原修订。</p>}
    {target.kind === "document" && name?.checked && !name.title && <p className="task-fineprint">标题或原件校验未通过；请核对下方原始信息。</p>}
    <details className="delivery-artifact-check"><summary>核对完整位置、修订与哈希</summary>
      <dl><div><dt>原始位置</dt><dd className="break-anywhere"><code>{delivery.artifactRef}</code></dd></div>
      {target.kind !== "fallback" && <div><dt>入口固定修订</dt><dd className="break-anywhere"><code>{target.revisionId}</code></dd></div>}
      <div><dt>交付产物声明版本</dt><dd className="break-anywhere"><code>{delivery.artifactRevision}</code></dd></div>
      <div><dt>SHA-256</dt><dd className="break-anywhere"><code>{delivery.contentHash}</code></dd></div></dl>
    </details>
  </div>;
}

export function DeliveryPanel({ detail, projectId, token, names, onChanged }: { detail: TaskDetail; projectId: string; token?: string; names: Record<string, ArtifactName>; onChanged: () => void }) {
  const deliveries = detail.deliveries ?? [];
  const latestId = deliveries.at(-1)?.id;
  const [runs, setRuns] = useState<RuntimeRunRecord[]>([]);
  const [runError, setRunError] = useState("");
  useEffect(() => {
    if (!token || !deliveries.some(item => item.runId)) return;
    let active = true;
    setRuns([]); setRunError("");
    runtimeClient(token, projectId).runs(detail.task.id)
      .then(rows => { if (active) setRuns(rows.filter(row => row.projectId === projectId && row.taskId === detail.task.id)); })
      .catch(() => { if (active) setRunError("来源 Run 暂未读到；不能推断执行修订。"); });
    return () => { active = false; };
  }, [token, projectId, detail.task.id, detail.task.version, deliveries]);
  return <section className="panel task-records"><div className="panel-head"><h2>交付与使用记录</h2><button type="button" onClick={onChanged}>回读当前状态</button></div>
    {runError && <p className="muted">{runError}</p>}
    {!deliveries.length && <p className="empty">还没有交付；任务状态不代替产物和使用证据。</p>}
    {[...deliveries].reverse().map(delivery => <article className="decision task-delivery-record" key={delivery.id}>
      <h3>{delivery.id === latestId ? "最新交付" : "历史交付"} · 技术{delivery.technicalResult === "passed" ? "通过" : "失败"}</h3>
      <DeliveryArtifact delivery={delivery} projectId={projectId} name={names[delivery.id]} />
      <p>交付登记 Task 修订 <a href={`#/p/${projectId}/tasks/${delivery.taskId}?revision=${encodeURIComponent(delivery.taskRevisionId)}`}><code>{delivery.taskRevisionId}</code> ↗</a></p>
      <p>{delivery.runId ? <>明确归属 Run <code>{delivery.runId}</code>；{runs.find(run => run.id === delivery.runId)
        ? <a href={`#/p/${projectId}/tasks/${delivery.taskId}?revision=${encodeURIComponent(runs.find(run => run.id === delivery.runId)!.taskRevisionId)}`}>实际执行 Task 修订 <code>{runs.find(run => run.id === delivery.runId)!.taskRevisionId}</code> ↗</a>
        : "实际执行修订待回读"}；<a href={`#/p/${projectId}/runtime`}>核对运行记录 →</a></> : "未声明来源 Run；旧交付不会自动归于任何评价尝试。"}</p>
      <p><strong>技术检查证据</strong><br />{delivery.technicalEvidence}</p>
      <p className="muted">Run 归属由登记者声明；运行终态不代表交付合格，也不证明产物字节由模型生成。产物修订、哈希与实际内容仍须分别核对。</p>
      <h3>这次交付的使用观察</h3>
      {(detail.observations ?? []).filter(item => item.deliveryId === delivery.id).length === 0 && <p className="empty">尚无这次交付的使用观察。</p>}
      {(detail.observations ?? []).filter(item => item.deliveryId === delivery.id).map(item => <div className="history" key={item.id}><strong>{item.observer}（{item.observerKind}） · {item.result}</strong><p>{item.evidence}</p><p>记录理由：{item.reason}</p><small>登记者 {item.actorId} · {item.createdAt}</small></div>)}
    </article>)}
    {(detail.closures ?? []).map(closure => <article className="decision" key={closure.id}><h3>任务验收决定</h3><p>{closure.acceptanceEvidence}</p><p>{closure.reason}</p><small>审阅者 {closure.actorId} · {closure.createdAt}</small></article>)}
  </section>;
}
