// 职责 (docs/frontend/pages/team.md): the inner rail lists the Role directory; the center shows the selected Role
// (or, with none selected, the base templates, every Role and the proposal form); the right column holds the selected
// Role's trial facts and its runtime and skills. The selection lives in the address (`/roles?role=`).
import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { Button, EmptyState, ListRow, LoadingState, Notice, cn } from "@evoloop/ui";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { currentPath, onNavigate } from "../../shared/navigation";
import { readReturn } from "../../shared/returnLink";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { FactList, PageSection, PanelSection, mutedText } from "../../shared/ui/PageParts";
import { ReturnLink } from "../../shared/ui/ReturnLink";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { href } from "../../shared/ui/shared";
import { RoleDetail, RoleTrialFacts } from "./RoleDetail";
import { RoleRuntime } from "./RoleRuntime";
import { RoleTemplates } from "./RoleTemplates";
import { buildProposal, proposalFields } from "./roleForms";
import { roleClassText, roleGroups, roleStateText, roleTarget, targetNotice, targetState } from "./rolePresentation";
import { maxAutoPages, useRoleList } from "./useRoleList";

const stamp = (value: Date) => value.toLocaleString("zh-CN", { hour12: false });

/** The `?role=` of the 职责 address. Other addresses never change it, so a page mounted late or kept hidden stays put. */
function useRoleSelection(projectId: string) {
  const rolesPath = href(projectId, "roles");
  const [selection, setSelection] = useState(() => ({ value: roleTarget(currentPath(), rolesPath), tick: 0 }));
  useEffect(() => onNavigate(() => {
      if (currentPath().split("?")[0] !== rolesPath) return;
      setSelection(previous => ({ value: roleTarget(currentPath(), rolesPath), tick: previous.tick + 1 }));
  }), [rolesPath]);
  return selection;
}

export function RolesView({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const list = useRoleList(projectId);
  const { value: target, tick } = useRoleSelection(projectId);
  const returnTo = readReturn(currentPath(), projectId, context.principal.actorId);
  const [proposing, setProposing] = useState(false);
  const roles = list.items;
  const selected = target ? roles.find(role => role.id === target && role.projectId === projectId) : undefined;
  const state = targetState(target, !!selected, { loading: list.loading || list.checking, error: list.error, more: list.more, pages: list.pages,
    maxPages: maxAutoPages, loadingMore: list.loadingMore, moreError: list.moreError });
  const notice = targetNotice(state);
  const groups = roleGroups(roles);
  const roleTitle = (id: string) => roles.find(role => role.id === id)?.proposal.title;
  // A linked Role on a later page: read the next page until it is found or the automatic limit is reached.
  useEffect(() => { if (state.kind === "searching" && !list.loading && !list.checking && !list.loadingMore && list.more) list.loadMore(); },
    [state.kind, list.loading, list.checking, list.loadingMore, list.more, list.pages]);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      const node = detailRef.current?.querySelector<HTMLElement>(`[id="role-${selected.id}"]`);
      if (node?.getClientRects().length) { node.scrollIntoView({ block: "start" }); node.focus({ preventScroll: true }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, tick]);
  const roleLink = (role: RoleRecord) => `${href(projectId, "roles")}?role=${encodeURIComponent(role.id)}`;
  const showProposal = proposing || !list.loading && !list.error && roles.length === 0;
  return <div data-ui="" className="team-roles mx-auto flex w-full max-w-[980px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7" ref={detailRef}>
    {returnTo && <div className="flex flex-wrap items-center gap-2"><ReturnLink projectId={projectId} href={returnTo.href} place={returnTo.place} label={returnTo.label} /></div>}
    <ContextRailContent>
      <nav aria-label="职责目录" className="flex flex-col gap-0.5 pt-1">
        <a href={href(projectId, "roles")} aria-current={!target ? "page" : undefined}
          className={cn("rounded-lg px-3 py-1.5 text-small outline-none focus-visible:shadow-[var(--focus-ring)]", !target ? "bg-raised font-medium text-foreground shadow-sm" : "text-text-secondary hover:bg-selected")}>全部职责与基础职责</a>
        {list.loading && <span className="px-3 py-2 text-caption text-muted-foreground">正在读取职责…</span>}
        {list.error && <span className="px-3 py-2 text-caption text-destructive">职责{roles.length ? "未读完整，下列是上次读回" : "暂不可读"}；原因见中间页首。</span>}
        {groups.map(group => <div key={group.key} className="flex flex-col gap-0.5">
          <span className="px-3 pb-1 pt-3 text-caption text-muted-foreground">{group.label} · {group.items.length}</span>
          {group.items.map(item => <a key={item.id} href={roleLink(item)} aria-current={target === item.id ? "page" : undefined}
            className={cn("flex flex-col rounded-lg px-3 py-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]", target === item.id ? "bg-raised shadow-sm" : "hover:bg-selected")}>
            <span className="truncate text-small text-foreground">{item.proposal.title}</span>
            <span className="truncate text-caption text-muted-foreground">{roleStateText[item.state]}</span>
          </a>)}
        </div>)}
        {list.more && <span className="px-3 py-2 text-caption text-muted-foreground">已列出 {roles.length} 项；更多职责在“全部职责”页底继续加载。</span>}
      </nav>
    </ContextRailContent>
    {notice && target !== null && <Notice tone={notice.tone} title={notice.title} data-role-target="">{notice.text}
      {target && <details className="mt-1 text-caption text-muted-foreground"><summary className="cursor-pointer">完整标识</summary><code className="break-all font-mono">{target}</code></details>}</Notice>}
    {list.error && <Notice tone="error" title="职责未读完整">{list.error}{roles.length ? "。下面是上次读回的职责，当前待核对。" : "。请重新读取。"}</Notice>}
    {list.moreError && <Notice tone="error" title="下一页职责未读回">{list.moreError}。已显示的职责保留；可再次加载下一页。</Notice>}
    {selected
      ? <SectionBoundary label="职责详情"><RoleDetail key={selected.id} context={context} role={selected} refresh={refresh} checking={list.checking} roleTitle={roleTitle} /></SectionBoundary>
      : <>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>职责</h1>
            <p className="mt-1 text-small text-text-secondary">持续职责、试行与承载它的智能体。新聊天可以沿用已有职责；只有反复出现的独立责任缺口，才进入有边界、有成本上限的试行。</p>
            <p className={cn(mutedText, "mt-1")} role="status">{list.observedAt ? `${list.checking ? "正在核对；下列仍是" : "职责读于"} ${stamp(list.observedAt)}${list.checking ? " 读回的内容" : ""}，已读 ${roles.length} 项${list.more ? "，还有更多" : ""}${list.loadingMore ? "，正在读取下一页" : ""}。` : list.loading ? "正在读取本项目职责…" : "本项目职责尚未读回。"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setProposing(value => !value)} aria-pressed={showProposal}><Plus aria-hidden="true" />提出职责试行</Button>
            <Button variant="ghost" onClick={context.onChanged} disabled={list.checking}><RefreshCw aria-hidden="true" className={list.checking ? "animate-spin" : undefined} />回读当前状态</Button>
          </div>
        </header>
        {showProposal && <PageSection title="提出有证据的职责试行" description="提案会保存观察与备选方案；审阅接受后才进入试行。首项任务需通过普通任务流程承接。">
          <ActionForm context={{ ...context, draftScope: "role:propose" }} embedded title="提出职责试行" fields={proposalFields}
            build={v => ({ type: "role.propose", roleId: crypto.randomUUID(), proposal: buildProposal(v) })} onApplied={() => setProposing(false)} />
        </PageSection>}
        <SectionBoundary label="基础职责"><RoleTemplates projectId={projectId} /></SectionBoundary>
        <PageSection title="全部职责">
          {list.loading && <LoadingState lines={3} label="正在读取职责" />}
          {!list.loading && !list.error && roles.length === 0 && <EmptyState title="还没有职责提案" reason="本项目不会自动创建常设职责。提出有证据的试行后，审阅接受才开始试行。" />}
          {groups.map(group => <div key={group.key} className="flex flex-col gap-1">
            <h3 className={cn(mutedText, "px-3")}>{group.label} · {group.items.length}</h3>
            <ul aria-label={group.label} className="flex flex-col">{group.items.map(role => <li key={role.id}>
              <ListRow href={roleLink(role)} title={role.proposal.title} meta={`${roleClassText(role.proposal)} · ${roleStateText[role.state]} · 回看 ${new Date(role.reviewAtUtc).toLocaleDateString("zh-CN")}`} />
            </li>)}</ul>
          </div>)}
          {list.more && !list.loading && <Button variant="ghost" className="w-fit" disabled={list.loadingMore} onClick={list.loadMore}>{list.loadingMore ? "继续读取中…" : list.moreError ? "重新加载下一页" : "加载更多职责"}</Button>}
        </PageSection>
      </>}
    <ContextPanelContent>
      <div className="flex flex-col gap-4">
        {selected ? <>
          <PanelSection title="试行与回看"><RoleTrialFacts projectId={context.projectId} role={selected} roleTitle={roleTitle} /></PanelSection>
          <SectionBoundary label="运行时与 skill"><RoleRuntime key={selected.id} context={context} roleId={selected.id} /></SectionBoundary>
        </> : <PanelSection title="职责概况">
          {list.observedAt ? <FactList rows={[
            ...groups.map(group => [group.label, `${group.items.length} 项`] as [string, string]),
            ["读取范围", `${list.more ? `已读 ${roles.length} 项，还有更多未读` : `已读完 ${roles.length} 项`}${list.loadingMore ? "；正在读取下一页" : ""}`],
          ]} /> : <p className={mutedText}>{list.loading ? "正在读取职责…" : "职责尚未读回，无法判断数量。"}</p>}
          <p className={mutedText}>选中一项职责后，这里显示它的试行指标、回看时间、运行时与 skill。</p>
        </PanelSection>}
      </div>
    </ContextPanelContent>
  </div>;
}
