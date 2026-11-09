// The project list after login: every project this identity may read, saved receipts to check first,
// and a create form for an authorised project scope that has no project yet.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, LogOut, RefreshCw } from "lucide-react";
import { Button, EmptyState, Logo, Notice } from "@evoloop/ui";
import type { Operation, Principal, Project } from "@evoloop/contracts";
import { api, errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { serviceErrorCodes } from "../../shared/errorCodes";
import { registerErrorCodes } from "../../shared/errorPresentation";
import { queryKeys } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { queryClient } from "../queryClient";
import { hasProjectReceipt, type OperationReceipt } from "../recovery";
import { projectInitial } from "../shell/spaces";
import { DevelopmentBanner } from "./AuthGate";
import { OperationCheck } from "./OperationCheck";

// The service codes in words load with the project list, not with the sign-in page (shared/errorCodes.ts).
registerErrorCodes(serviceErrorCodes);

export function ProjectChooser({ token, principal, receipts, operationNotice, operationDetail = null, onRefreshSession, onConfirmed, context, logout }: {
  token: string; principal: Principal; receipts: OperationReceipt[]; operationNotice: string; operationDetail?: string | null; onRefreshSession: () => Promise<void>;
  onConfirmed: (receipt: OperationReceipt, result: Operation["result"]) => void; context: MutationContext; logout: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const listKey = queryKeys.identity(principal.actorId, "projects", ...principal.projectIds);
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => Promise.all(principal.projectIds.map(async id => {
      try { return { project: await api(token).project(id), id }; }
      catch { return { project: null as Project | null, id }; }
    })),
  });
  const projects = (list.data ?? []).flatMap(r => r.project && principal.projectIds.includes(r.project.id) ? [r.project] : []);
  const missing = (list.data ?? []).filter(r => !r.project).map(r => r.id);
  const reading = list.isFetching;
  const reread = () => { void queryClient.invalidateQueries({ queryKey: listKey }); };
  async function refreshProjects() {
    if (refreshing) return;
    setRefreshing(true); setRefreshError("");
    try { await onRefreshSession(); reread(); }
    catch (cause) { setRefreshError(errorText(cause)); }
    finally { setRefreshing(false); }
  }
  return <div data-ui="" className="project-chooser flex min-h-dvh flex-col bg-background">
    <DevelopmentBanner />
    <header className="flex h-14 items-center justify-between gap-3 px-4 compact:px-8">
      <a href="/" className="flex items-center gap-2 font-semibold text-foreground"><Logo size={28} />evoLoop</a>
      <div className="flex items-center gap-2">
        <span className="hidden text-small text-text-secondary compact:inline">{principal.actorId}</span>
        <Button variant="ghost" size="compact" onClick={logout}><LogOut aria-hidden="true" />退出</Button>
      </div>
    </header>
    <main className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 pb-16 pt-4 compact:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-foreground">你的项目</h1>
          <p className="mt-1 text-small text-text-secondary">进入一个项目，查看工作、智能体和等你处理的事。</p>
        </div>
        <Button size="compact" onClick={() => void refreshProjects()} disabled={refreshing}>
          <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />{refreshing ? "刷新中…" : "刷新项目"}
        </Button>
      </div>
      {refreshError && <Notice tone="error">刷新失败：{refreshError}</Notice>}
      {operationNotice && <Notice>{operationNotice}{operationDetail && <details className="mt-1 text-caption"><summary className="cursor-pointer">诊断信息</summary><code className="break-all font-mono">{operationDetail}</code></details>}</Notice>}
      {receipts.map(receipt => <OperationCheck key={receipt.operationId} receipt={receipt} token={token} onConfirmed={result => { onConfirmed(receipt, result); reread(); }} />)}
      {reading && list.data && <p role="status" className="text-caption text-muted-foreground">正在核对授权项目；下面是上次读取的列表。</p>}
      {reading && !list.data && <p role="status" className="text-small text-muted-foreground">正在读取你有权限的项目…</p>}
      {projects.length > 0 && <ul aria-label="项目" className="flex flex-col gap-2">{projects.map(project => {
        const pending = receipts.filter(r => r.projectId === project.id).length;
        return <li key={project.id}>
          <a className="project-item flex items-center gap-3 rounded-xl bg-raised px-4 py-3 text-foreground shadow-sm outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]" href={href(project.id, "work")}>
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-accent font-semibold text-accent-foreground">{projectInitial(project.title)}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="truncate font-semibold">{project.title}</strong>
              <span className="text-caption text-muted-foreground">建立于 {date(project.createdAt)}{pending ? ` · ${pending} 项操作待核对` : ""}</span>
            </span>
            <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          </a>
        </li>;
      })}</ul>}
      {!projects.length && !reading && !missing.length && <EmptyState title="还没有可读取的项目" reason="当前身份没有任何项目的授权。请让项目管理员把你加入项目，再点“刷新项目”。" />}
      {missing.length > 0 && <Notice tone="waiting">有 {missing.length} 个授权项目尚未创建或暂不可读取。服务异常时请先重试，已存在的项目不会被覆盖。</Notice>}
      {missing.map(id => <section key={id} aria-label="创建项目" className="rounded-xl bg-raised p-4 shadow-sm">
        <p className="text-small text-text-secondary">你有一个项目授权，但这里还没有读到对应的项目：可能尚未建立，也可能暂时读不到。</p>
        <FullIdentifiers className="mb-2 mt-1" summary="完整标识（用于 CLI）" rows={[{ label: "项目", value: id }]} />
        <div data-legacy="" className="workbench-layout">
          <ActionForm context={{ ...context, projectId: id, blocked: hasProjectReceipt(receipts, id), onChanged: () => { reread(); context.onChanged(); } }} title="创建项目" fields={[{ name: "title", label: "项目名称" }]} build={v => ({ type: "project.create", ...v })} />
        </div>
      </section>)}
    </main>
  </div>;
}
