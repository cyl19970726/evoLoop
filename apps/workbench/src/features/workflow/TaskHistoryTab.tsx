// 历史 (tasks.md 正文与右栏): the task's revisions in order with each state change and its reason, the basis
// decisions, and the acceptance contract. A fixed historical revision opens read only, with the text, acceptance and
// basis of that time and one way back: “返回当前任务” (no shortcut to today's delivery).
import React from "react";
import type { TaskDetail, TaskRevision } from "@evoloop/contracts";
import { Badge, Button, ErrorState, LoadingState, StatusTag } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import { fixedContent, useProjectQuery } from "../../shared/query";
import { taskSectionHref } from "../../shared/taskNavigation";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { date } from "../../shared/ui/shared";
import { BasisList } from "./TaskBasisTab";
import { taskStateLabel } from "./taskCommands";
import { DocumentLink } from "./DocumentLink";
import { EvidenceText } from "./EvidenceText";
import { Fact, Fine, ReadNote, TabSection } from "./TaskForms";
import { useRevisionOrigin } from "./useRevisionOrigin";
import type { RevisionOrigin } from "./revisionPresentation";

/** A revision's author and reason in words (the schedule's name is read when a schedule generated it). */
function RevisionWho({ projectId, revision, children }: { projectId: string; revision: { actorId?: string | null; reason?: string | null }; children(origin: RevisionOrigin): React.ReactNode }) {
  return <>{children(useRevisionOrigin(projectId, revision))}</>;
}

const judgementLabel = { approve: "同意", needsEvidence: "需要补充证据", defer: "暂缓", reject: "不采纳" } as const;

function useRevisions(projectId: string, taskId: string, version: number) {
  return useProjectQuery(projectId, ["task", taskId, "revisions", version], async () => {
    const rows = await api().taskRevisions(projectId, taskId);
    if (!Array.isArray(rows) || rows.some(row => row.revision.taskId !== taskId || row.revision.projectId !== projectId)) throw new Error("修订响应与当前任务不符");
    return rows;
  });
}

export function TaskHistoryTab({ projectId, detail, selectedRevision }: { projectId: string; detail: TaskDetail; selectedRevision?: string | undefined }) {
  const task = detail.task;
  const revisions = useRevisions(projectId, task.id, task.version);
  const rows = revisions.data ? [...revisions.data].sort((a, b) => a.revision.version - b.revision.version) : null;
  const changes = rows?.filter((row, index) => index > 0 && row.revision.state !== rows[index - 1]?.revision.state) ?? [];
  const lastChange = changes.at(-1)?.revision;
  const proposal = detail.proposal;
  return <div className="flex flex-col gap-8">
    {selectedRevision && <FixedRevision projectId={projectId} taskId={task.id} revisionId={selectedRevision} />}
    <TabSection title="状态与决定">
      <ReadNote read={revisions} what="修订历史" />
      {rows && (lastChange ? <div className="flex flex-col gap-1">
        <p className="text-label text-foreground">最近一次状态变化：<StatusTag tone="history" label={taskStateLabel[lastChange.state]} /></p>
        <RevisionWho projectId={projectId} revision={lastChange}>{origin => <>
          <EvidenceText label="理由" value={origin.reason} />
          <Fine>{origin.author} · {date(lastChange.createdAt)} · 第 {lastChange.version} 版 · <a className="text-primary hover:underline"
            href={taskSectionHref(projectId, task.id, { revisionId: lastChange.id })}>打开当时的正文与依据</a></Fine>
        </>}</RevisionWho>
      </div> : <p className="text-label text-text-secondary">目前只有初始任务，还没有状态变化。</p>)}
    </TabSection>
    <TabSection title="修订时间线" meta={rows ? `${rows.length} 个修订` : undefined}>
      {rows && <ol className="flex flex-col" aria-label="任务修订">{[...rows].reverse().map(({ revision, basis }) => <RevisionRow key={revision.id}
        projectId={projectId} revision={revision} basisCount={basis?.members.length ?? 0} current={revision.id === detail.revision.id} viewing={revision.id === selectedRevision} />)}</ol>}
    </TabSection>
    <TabSection title="依据复核决定" meta={detail.decisions.length ? `${detail.decisions.length} 项` : undefined}>
      {!detail.decisions.length ? <p className="text-label text-text-secondary">还没有依据复核决定。</p>
        : <ul className="flex flex-col gap-3">{detail.decisions.map(decision => <li key={decision.id} className="flex flex-col gap-1">
          <p className="text-label font-medium text-foreground">{decision.decision === "adopt" ? "采用新版" : "保留原依据"}</p>
          <EvidenceText label="理由" value={decision.reason} />
          <Fine>{decision.actorId} · {date(decision.createdAt)} · <a className="text-primary hover:underline"
            href={taskSectionHref(projectId, task.id, { revisionId: decision.previousTaskRevisionId })}>查看决定前的任务与依据</a></Fine>
        </li>)}</ul>}
    </TabSection>
    {proposal && <TabSection title="验收约定">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-compact:grid-cols-1">
        <Fact label="验收方式">{proposal.acceptanceMode === "independent_agent" ? "独立的智能体使用当前交付" : proposal.acceptanceMode === "human_required" ? "指定的人本人使用当前交付" : "历史约定"}</Fact>
        <Fact label="指定验收身份">{proposal.consumer || "未指定；由符合验收方式的身份签收"}</Fact>
        <Fact label="完成要求">{proposal.useRequired ? "要有本次交付的实际使用记录" : "按历史约定核对"}</Fact>
        <Fact label="停止条件">{proposal.stopCondition || "未写"}</Fact>
      </div>
      {proposal.evidence && <EvidenceText label="提出依据" value={proposal.evidence} />}
    </TabSection>}
    {(detail.judgements ?? []).length > 0 && <TabSection title="旧提议的判断">
      <ul className="flex flex-col gap-3">{(detail.judgements ?? []).map(judgement => <li key={judgement.id} className="flex flex-col gap-1">
        <p className="text-label font-medium text-foreground">{judgementLabel[judgement.decision] ?? "判断"}</p>
        <EvidenceText label="理由" value={judgement.reason} />
        <EvidenceText label="证据" value={judgement.evidence} />
        <Fine>{judgement.actorId} · {date(judgement.createdAt)}</Fine>
      </li>)}</ul>
    </TabSection>}
  </div>;
}

function RevisionRow({ projectId, revision, basisCount, current, viewing }: { projectId: string; revision: TaskRevision; basisCount: number; current: boolean; viewing: boolean }): React.ReactElement {
  const preview = revision.content.length > 160 ? `${revision.content.slice(0, 160)}…` : revision.content;
  return <li className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0" data-revision={revision.id}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-small font-medium text-foreground">第 {revision.version} 版</span>
      <StatusTag tone="history" label={taskStateLabel[revision.state]} />
      {current && <Badge>当前</Badge>}
      {viewing && <Badge>正在查看</Badge>}
    </div>
    <RevisionWho projectId={projectId} revision={revision}>{origin => <>
      <Fine>{date(revision.createdAt)} · {origin.author} · 固定依据 {basisCount} 份</Fine>
      <p className="text-label text-text-secondary [overflow-wrap:anywhere]">理由：{origin.reason}</p>
      <FullIdentifiers summary="原始记录" rows={origin.identifiers} />
    </>}</RevisionWho>
    <details><summary className="w-fit cursor-pointer text-caption text-primary hover:underline">当时的正文与验收摘要</summary>
      <p className="mt-1 whitespace-pre-wrap text-label text-text-secondary [overflow-wrap:anywhere]">{preview}</p>
      <p className="mt-1 whitespace-pre-wrap text-label text-text-secondary [overflow-wrap:anywhere]">验收：{revision.acceptance}</p></details>
    {!current && <a className="w-fit text-label text-primary hover:underline" href={taskSectionHref(projectId, revision.taskId, { revisionId: revision.id })}>只读查看这一版</a>}
  </li>;
}

/** One historical revision, read only, as it was fixed. */
function FixedRevision({ projectId, taskId, revisionId }: { projectId: string; taskId: string; revisionId: string }) {
  const read = useProjectQuery(projectId, [fixedContent, "task-revision", taskId, revisionId], async () => {
    const value = await api().taskRevision(projectId, taskId, revisionId);
    if (value.revision.id !== revisionId || value.revision.taskId !== taskId) throw new Error("修订响应与所选的固定修订不符");
    return value;
  });
  const back = <Button asChild size="compact" variant="primary"><a href={taskSectionHref(projectId, taskId)}>返回当前任务</a></Button>;
  return <TabSection title="固定历史任务修订" action={back} className="rounded-lg bg-muted p-5" id="task-fixed-revision">
    {!read.data ? read.error ? <ErrorState title="固定修订不可读取" happened={errorText(read.error)}
      next="不能把当前任务当成当时的依据；可以重新读取。" action={<Button size="compact" onClick={() => void read.refetch()}>重新读取</Button>} />
      : <LoadingState lines={6} label="正在读取指定修订与当时的完整依据" />
      : <>
        <RevisionWho projectId={projectId} revision={read.data.revision}>{origin => <>
          <p className="text-label text-text-secondary">只读。第 {read.data!.revision.version} 版 · {taskStateLabel[read.data!.revision.state]} · {date(read.data!.revision.createdAt)} · {origin.author}</p>
          <h3 className="text-heading font-semibold text-foreground">{read.data!.revision.title}</h3>
          <EvidenceText label="当次理由" value={origin.reason} />
        </>}</RevisionWho>
        <div className="flex flex-col gap-1">
          <p className="text-caption font-medium text-muted-foreground">当时的正文 · <DocumentLink projectId={projectId} documentId={read.data.revision.contentDocumentId}
            revisionId={read.data.revision.contentRevisionId} title="当时的正文" relation="当时的主正文 · 固定修订">阅读当时的原件</DocumentLink></p>
          <MarkdownBody source={read.data.revision.content} identity={`history-${read.data.revision.id}`} projectId={projectId} topHeading={4} />
        </div>
        <EvidenceText label="当时的验收" value={read.data.revision.acceptance} />
        <div className="flex flex-col gap-1">
          <p className="text-caption font-medium text-muted-foreground">当时的固定依据</p>
          <BasisList projectId={projectId} basis={read.data.basis} content={{ documentId: read.data.revision.contentDocumentId, revisionId: read.data.revision.contentRevisionId }} />
        </div>
        <FullIdentifiers rows={[{ label: "任务修订", value: read.data.revision.id }, { label: "依据集合", value: read.data.revision.basisSetId }]} />
      </>}
  </TabSection>;
}
