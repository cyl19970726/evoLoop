// 结果未知的操作: the receipts this identity saved for commands whose result is not confirmed yet. Each receipt says which
// object the original operation was about and links there, with the way back to this page (layout.md 上下文页面与返回).
import { ArrowUpRight, BookOpen, MessageSquare, Share2 } from "lucide-react";
import { Button, EmptyState } from "@evoloop/ui";
import { ApiError, api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { href } from "../../shared/ui/shared";
import { LinkList, SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import {
  checkedOrigin, operationsTitle, originKindLabel, originLink, originText, receiptOrigin,
  type OperationItem, type OriginKind, type OriginRead, type ReceiptOrigin,
} from "./operationsPresentation";

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
const mismatch = (kind: OriginKind) => new Error(`${originKindLabel[kind]}响应与回执不符`);

/** The object's name, read in this project. A 404 means it is not here; an empty revision list too. */
async function readName(projectId: string, kind: OriginKind, id: string): Promise<string> {
  const client = api();
  if (kind === "task") {
    const { task } = await client.task(projectId, id);
    if (task.projectId !== projectId || task.id !== id) throw mismatch(kind);
    return task.title;
  }
  if (kind === "document") {
    const { document } = await client.document(projectId, id);
    if (document.projectId !== projectId || document.id !== id) throw mismatch(kind);
    return document.title;
  }
  if (kind === "discussion") {
    const discussion = await client.discussion(projectId, id);
    if (discussion.projectId !== projectId || discussion.id !== id) throw mismatch(kind);
    return discussion.question.trim() || (discussion.kind === "task_collaboration" ? "任务协作" : "分工讨论");
  }
  const revisions: Array<{ projectId: string; version: number; outcome?: string; deliverable?: string }> = kind === "goal"
    ? await client.goalRevisions(projectId, id) : await client.stageRevisions(projectId, id);
  if (!Array.isArray(revisions) || !revisions.length) throw new ApiError(404, "not found");
  if (revisions.some(item => item.projectId !== projectId)) throw mismatch(kind);
  const latest = revisions.reduce((a, b) => b.version > a.version ? b : a);
  return (kind === "goal" ? latest.outcome : latest.deliverable)?.trim() || originKindLabel[kind];
}

/** The candidates in order: the first that exists in this project is the object; none means it is not here. */
async function readOrigin(projectId: string, origin: Extract<ReceiptOrigin, { kind: "object" }>): Promise<{ kind: OriginKind; name: string } | null> {
  for (const kind of origin.candidates) {
    try { return { kind, name: await readName(projectId, kind, origin.id) }; }
    catch (error) { if (!notFound(error)) throw error; }
  }
  return null;
}

function useOriginRead(projectId: string, origin: ReceiptOrigin | null): OriginRead {
  const object = origin?.kind === "object" ? origin : null;
  const query = useProjectQuery(projectId, ["operations", "origin", object?.id, object?.candidates.join(",")],
    () => readOrigin(projectId, object!), { enabled: !!object });
  if (query.data !== undefined) return query.data ? { state: "found", ...query.data } : { state: "missing" };
  if (query.isError) return { state: "failed", reason: errorText(query.error) };
  return { state: "reading" };
}

/**
 * One receipt: its check card, then where its operation was, a link there (and back), and the raw identifiers in the
 * source layer (the operation ID only there). The card gets what was found, so the notice after a confirmed check names
 * the object and links back to it once the receipt is gone.
 */
function ReceiptItem({ projectId, item }: { projectId: string; item: OperationItem }) {
  const { receipt } = item;
  const origin = receiptOrigin(receipt);
  const read = useOriginRead(projectId, origin);
  const link = originLink(projectId, receipt, origin, read);
  return <div className="flex flex-col gap-2">
    {item.check(checkedOrigin(projectId, receipt, origin, read))}
    <div className="flex flex-col gap-1.5 px-1" data-receipt-origin={receipt.operationId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="min-w-0 text-small text-foreground [overflow-wrap:anywhere]">{originText(origin, read)}</p>
        {link && <Button asChild size="compact" variant="ghost"><a href={link.href}>{link.label}<ArrowUpRight aria-hidden="true" /></a></Button>}
      </div>
      <FullIdentifiers summary="完整标识" rows={[
        { label: "原操作", value: receipt.operationId },
        { label: origin.kind === "object" ? "原对象" : "项目", value: receipt.taskId },
        { label: "原操作类型", value: receipt.commandType },
      ]} />
    </div>
  </div>;
}

/** `items`: the receipts saved for this project with their check cards, as app/App.tsx keeps them. */
export function OperationsPage({ projectId, items }: { projectId: string; items: readonly OperationItem[] }) {
  return <SettingsPage title={operationsTitle} description="查看当前身份保存的操作回执，按原操作核对结果，再回到原操作所在的对象。" className="operations-page">
    {items.length ? <div className="flex flex-col gap-5">{items.map(item => <ReceiptItem key={item.receipt.operationId} projectId={projectId} item={item} />)}</div>
      : <EmptyState title="没有结果未知的操作" reason="这里只列当前身份在这个浏览器会话里保存的回执，不代表项目里没有结果未知的事；其他业务记录仍在各自的页面。"
        action={<Button asChild><a href={href(projectId, "work")}>返回当前工作</a></Button>} />}
    <SettingsSection title="其他操作回执">
      <LinkList label="其他操作回执" items={[
        { href: href(projectId, "sessions"), title: "发给智能体的消息", detail: "送达、待人工转交和回复写在各智能体的对话里：打开智能体列表，选中发过消息的那一个核对。", icon: <MessageSquare /> },
        { href: href(projectId, "collaboration"), title: "协作回执", detail: "任务同步到飞书的写入回执在 团队 › 协作回执，按原标识读回。", icon: <Share2 /> },
        { href: href(projectId, "knowledge"), title: "知识发布与撤回", detail: "专用回执在知识空间，按原操作查回。", icon: <BookOpen /> },
      ]} />
    </SettingsSection>
    <details className="rounded-xl bg-raised px-4 py-3 text-small shadow-sm">
      <summary className="cursor-pointer font-medium text-foreground">遇到结果未知时怎样处理</summary>
      <p className="mt-2 text-text-secondary">保留原操作 ID，先查回结果，再决定下一步；确认前不创建新操作重复提交。核清后从“打开原对象”回到原处看当前内容。</p>
    </details>
  </SettingsPage>;
}
