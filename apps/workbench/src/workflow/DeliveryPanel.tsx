import { useEffect, useRef, useState } from "react";
import type { RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { runtimeClient } from "../runtime/client";
import { taskSectionHref } from "../orchestration/navigation";
import { deliveryRunHref, recentDeliveryRunIds, verifiedDeliveryRun } from "./deliveryRun";
import { date } from "../ui/shared";
import { deliveryTarget, verifiedDocumentTitle, type DeliveryArtifactInput, type DeliveryTarget } from "./deliveryPresentation";
import { EvidenceText } from "./EvidenceText";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "./observationPresentation";

type Delivery = NonNullable<TaskDetail["deliveries"]>[number];
const emptyDeliveries: Delivery[] = [];
type ArtifactName = { title: string | null; checked: boolean };
type Observation = NonNullable<TaskDetail["observations"]>[number];
type RunRead = { status: "reading" } | { status: "ready"; run: RuntimeRunRecord } | { status: "failed"; message: string };

async function readDeclaredRun(token: string, projectId: string, taskId: string, runId: string): Promise<RuntimeRunRecord> {
  const run = await runtimeClient(token, projectId).run(runId);
  const verified = verifiedDeliveryRun(projectId, taskId, runId, run);
  if (!verified) throw new Error("来源 Run 与交付登记的项目或任务不符");
  return verified;
}

export function DeliveryObservation({ observation }: { observation: Observation }) {
  return <div className="history task-observation">
    <strong>{observation.observer} · {observerKindLabel[observation.observerKind]} · {observationResultLabel[observation.result]}</strong>
    <small>观察登记于 {date(observation.createdAt)} · 登记者 {observation.actorId}</small>
    <EvidenceText label="使用证据" value={observation.evidence} />
    <EvidenceText label="记录理由" value={observation.reason} />
  </div>;
}

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

export function DeliveryPanel({ detail, projectId, token, names, onChanged, active }: { detail: TaskDetail; projectId: string; token?: string; names: Record<string, ArtifactName>; onChanged: () => void; active: boolean }) {
  const deliveries = detail.deliveries ?? emptyDeliveries;
  const latestId = deliveries.at(-1)?.id;
  const [runReads, setRunReads] = useState<Record<string, RunRead>>({});
  const readEpoch = useRef(0);
  useEffect(() => {
    const epoch = ++readEpoch.current;
    setRunReads({});
    if (active && token) {
      const ids = recentDeliveryRunIds(deliveries, projectId, detail.task.id);
      for (const id of ids) {
        setRunReads(current => ({ ...current, [id]: { status: "reading" } }));
        void readDeclaredRun(token, projectId, detail.task.id, id)
          .then(run => { if (readEpoch.current === epoch) setRunReads(current => ({ ...current, [id]: { status: "ready", run } })); })
          .catch(cause => { if (readEpoch.current === epoch) setRunReads(current => ({ ...current, [id]: { status: "failed", message: errorText(cause) } })); });
      }
    }
    return () => { if (readEpoch.current === epoch) readEpoch.current++; };
  }, [active, token, projectId, detail.task.id, detail.task.version, deliveries]);
  async function readOlderRun(id: string) {
    if (!active || !token || runReads[id]?.status === "reading") return;
    const epoch = readEpoch.current;
    setRunReads(current => ({ ...current, [id]: { status: "reading" } }));
    try {
      const run = await readDeclaredRun(token, projectId, detail.task.id, id);
      if (readEpoch.current === epoch) setRunReads(current => ({ ...current, [id]: { status: "ready", run } }));
    } catch (cause) {
      if (readEpoch.current === epoch) setRunReads(current => ({ ...current, [id]: { status: "failed", message: errorText(cause) } }));
    }
  }
  function sourceRun(delivery: Delivery) {
    if (!delivery.runId) return "未声明来源 Run；旧交付不会自动归于任何评价尝试。";
    if (delivery.projectId !== projectId || delivery.taskId !== detail.task.id) return "交付来源与当前任务范围不符；运行入口暂不提供。";
    const read = runReads[delivery.runId];
    if (read?.status === "ready") return <><a href={taskSectionHref(projectId, delivery.taskId, { revisionId: read.run.taskRevisionId })}>实际执行 Task 修订 <code>{read.run.taskRevisionId}</code> ↗</a>；<a href={deliveryRunHref(projectId, delivery.taskId, delivery.runId)}>核对这次 Run →</a>；<a href={`#/p/${encodeURIComponent(projectId)}/runtime?session=${encodeURIComponent(`owned:${read.run.sessionId}`)}`}>查看对应 Session →</a></>;
    if (read?.status === "reading") return "正在核对来源 Run；运行入口暂不提供。";
    return <>来源 Run 尚未核实；<button type="button" className="quiet" disabled={!active || !token} onClick={() => void readOlderRun(delivery.runId!)}>核对来源 Run</button>{read?.status === "failed" && <> · {read.message}</>}</>;
  }
  return <section className="panel task-records"><div className="panel-head"><h2>交付与使用记录</h2><button type="button" onClick={onChanged}>回读当前状态</button></div>
    {active && deliveries.length > 5 && <p className="task-fineprint">仅自动核对最近 5 条交付的来源 Run；更早记录可按条核对。</p>}
    {!deliveries.length && <p className="empty">还没有交付；任务状态不代替产物和使用证据。</p>}
    {[...deliveries].reverse().map(delivery => <article className="decision task-delivery-record" key={delivery.id}>
      <h3>{delivery.id === latestId ? "最新交付" : "历史交付"} · 技术检查{delivery.technicalResult === "passed" ? "通过" : "失败"}</h3>
      <p className="muted">交付登记于 {date(delivery.createdAt)} · 登记者 {delivery.actorId}</p>
      <DeliveryArtifact delivery={delivery} projectId={projectId} name={names[delivery.id]} />
      <p>交付登记 Task 修订 <a href={`#/p/${projectId}/tasks/${delivery.taskId}?revision=${encodeURIComponent(delivery.taskRevisionId)}`}><code>{delivery.taskRevisionId}</code> ↗</a></p>
      <p>{delivery.runId && <>登记来源 Run <code>{delivery.runId}</code>；</>}{sourceRun(delivery)}</p>
      <EvidenceText label="技术检查证据" value={delivery.technicalEvidence} />
      <p className="muted">Run 归属由登记者声明；运行终态不代表交付合格，也不证明产物字节由模型生成。产物修订、哈希与实际内容仍须分别核对。</p>
      <h3>这次交付的使用观察</h3>
      {observationsForDelivery(detail.observations ?? [], delivery.id).length === 0 && <p className="empty">尚无这次交付的使用观察。</p>}
      {observationsForDelivery(detail.observations ?? [], delivery.id).map(item => <DeliveryObservation observation={item} key={item.id} />)}
    </article>)}
    {(detail.closures ?? []).map(closure => <article className="decision" key={closure.id}><h3>任务验收决定</h3><p>{closure.acceptanceEvidence}</p><p>{closure.reason}</p><small>审阅者 {closure.actorId} · {closure.createdAt}</small></article>)}
  </section>;
}
