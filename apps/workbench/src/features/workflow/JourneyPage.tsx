// 目标与阶段 (docs/frontend/pages/journey.md): goals with their stages in the inner rail; the chosen stage in the center
// (its goal, learning question, next step, the tasks under it, acceptance and review, history); read scope and full
// identifiers in the right column. `?action=propose` opens 新建任务 in the center for the chosen stage. Reads are
// project queries (journeyRead.ts); writes go through useCommand (JourneyForms.tsx, CreateTaskPage.tsx).
import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Goal, GoalRevision, Stage, StageReview, StageRevision } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, ListRow, LoadingState, Notice, RefreshingIndicator, Select, StatusTag, cn } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { leaderPhaseLabel } from "../../shared/leaderWorkLoad";
import { currentPath, onNavigate, replaceQuietly } from "../../shared/navigation";
import { isRoleOwnerId } from "../../shared/ownerRole";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { rowStatus } from "../../shared/taskStatus";
import { workItemNextStep } from "../../shared/workPresentation";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { ResponsibleName, RoleName } from "../../shared/ui/RecordName";
import { date, href } from "../../shared/ui/shared";
import { CreateTaskView } from "./CreateTaskPage";
import { DraftsContext, GoalCreateForm, GoalReviseForm, StageAcceptForm, StageCorrectForm, StageProposeForm, StageReviewForm, goalFieldLabels, type Drafts } from "./JourneyForms";
import { defaultSelection, goalTree, groupByStage, nextChoiceLabel, orderReviews, orderStageTasks, phaseCounts, reviewStanding, stageNextStep, stageStatus } from "./journeyPresentation";
import { journeyKey, useGoals, useStageWork, useStages } from "./journeyRead";

const muted = "text-caption text-muted-foreground";
const card = "flex flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5";
type Selection = { stageId: string } | { goalId: string };

function selectionFrom(path: string): Selection | null {
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const stageId = query.get("stage"), goalId = query.get("goal");
  return stageId ? { stageId } : goalId ? { goalId } : null;
}
const isPropose = (path: string) => new URLSearchParams(path.split("?")[1] ?? "").get("action") === "propose";

/** How a read stands: first read, failed with nothing to show, kept from before while checking or after a failure. */
type ReadState = "loading" | "failed" | "checking" | "stale" | "fresh";
function readState(query: { isPending: boolean; isError: boolean; data?: unknown; isFetching: boolean }): ReadState {
  if (query.data === undefined) return query.isError ? "failed" : "loading";
  if (query.isError) return "stale";
  return query.isFetching ? "checking" : "fresh";
}

export function JourneyPage({ context, active, propose }: { context: MutationContext; active: boolean; propose: boolean }) {
  const { projectId } = context;
  const drafts = React.useRef<Drafts>(new Map()).current;
  const client = useQueryClient();
  const panel = useContextPanel();
  const journeyHref = href(projectId, "journey");
  const [selection, setSelection] = React.useState<Selection | null>(() => selectionFrom(currentPath()));
  // Links in the rail (and Back) change the address; this page instance follows only addresses of its own kind.
  React.useEffect(() => onNavigate(() => {
    const path = currentPath();
    if (path.split("?")[0] !== journeyHref || isPropose(path) !== propose) return;
    setSelection(selectionFrom(path));
  }), [journeyHref, propose]);
  const goalsRead = useGoals(projectId);
  const stagesRead = useStages(projectId);
  const workRead = useStageWork(projectId);
  const goals = goalsRead.data?.items ?? [];
  const stages = stagesRead.data ?? [];
  const work = workRead.data;
  const states = { goals: readState(goalsRead), stages: readState(stagesRead), work: readState(workRead) };
  const recordsShown = states.goals !== "loading" && states.goals !== "failed" && states.stages !== "loading" && states.stages !== "failed";
  const recordsFresh = states.goals === "fresh" && states.stages === "fresh";
  const paused = recordsFresh ? null : "目标与阶段正在核对或没有读回最新状态，提交暂停；读回后再提交，草稿会保留。";
  const find = (choice: Selection | null) => {
    const stage = choice && "stageId" in choice ? stages.find(item => item.id === choice.stageId) : undefined;
    const goal = stage ? goals.find(item => item.id === stage.goalId) : choice && "goalId" in choice ? goals.find(item => item.id === choice.goalId) : undefined;
    return { stage, goal };
  };
  const chosen = find(selection);
  // A chosen stage or goal that is not among the records read: say so, and show the default instead.
  const missingChoice = recordsShown && !!selection && !chosen.stage && !chosen.goal;
  const { stage, goal } = selection && !missingChoice ? chosen : find(defaultSelection(goals, stages));
  const groups = work ? groupByStage(work.items, stages) : null;
  const choose = (next: Selection) => {
    setSelection(next);
    if (active) replaceQuietly(`${journeyHref}?${propose ? "action=propose&" : ""}${"stageId" in next ? `stage=${next.stageId}` : `goal=${next.goalId}`}`);
  };
  const reread = () => void client.invalidateQueries({ queryKey: queryKeys.project(projectId, journeyKey) });
  const fetching = goalsRead.isFetching || stagesRead.isFetching || workRead.isFetching;
  const proposeStage = stage?.state === "active" ? stage.id : stages.find(item => item.state === "active")?.id;
  const proposeHref = `${journeyHref}?action=propose${proposeStage ? `&stage=${proposeStage}` : ""}`;
  const stageHref = (id: string) => `${journeyHref}?stage=${id}`;
  const goalHref = (id: string) => `${journeyHref}?goal=${id}`;
  const tree = goalTree(goals, stages);
  const stageMeta = (item: Stage) => groups ? `${groups.byStage.get(item.id)?.length ?? 0} 项任务${work?.complete ? "" : "（已读部分）"}` : states.work === "failed" ? "任务暂不可读取" : "正在读取任务";
  const rail = <ContextRailContent><div data-ui="">
    <nav aria-label="目标与阶段" className="flex flex-col gap-0.5 pb-2 pt-2">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2"><span className={cn(muted, "flex-1")}>目标与阶段{recordsShown ? ` · ${goals.length} 个目标` : ""}</span>
        {(states.goals === "checking" || states.stages === "checking") && <RefreshingIndicator />}</div>
      {!recordsShown && (states.goals === "failed" || states.stages === "failed" ? <p className={cn(muted, "px-3")}>目标与阶段没有读回。</p> : <LoadingState lines={3} label="正在读取目标与阶段" />)}
      {tree.items.map(({ goal: item, stages: owned }) => <div key={item.id} className="flex flex-col gap-0.5">
        <ListRow href={goalHref(item.id)} selected={!stage && goal?.id === item.id} title={<span title={item.outcome}>{item.outcome}</span>} meta={`目标 · ${owned.length} 个阶段`} />
        {owned.length > 0 && <ul aria-label={`${item.outcome}的阶段`} className="flex flex-col gap-0.5 pl-3">{owned.map(entry => <li key={entry.id}>
          <ListRow href={stageHref(entry.id)} selected={stage?.id === entry.id} title={<span title={entry.deliverable}>{entry.deliverable}</span>}
            meta={stageMeta(entry)} trailing={<StatusTag tone={stageStatus[entry.state].tone} label={stageStatus[entry.state].label} />} />
        </li>)}</ul>}
      </div>)}
      {tree.orphans.length > 0 && <div className="mt-2 flex flex-col gap-0.5"><span className={cn(muted, "px-3")}>所属目标未读到的阶段</span>
        {tree.orphans.map(entry => <ListRow key={entry.id} href={stageHref(entry.id)} selected={stage?.id === entry.id} title={entry.deliverable} meta={stageMeta(entry)} />)}</div>}
      {goalsRead.data && !goalsRead.data.complete && <p className={cn(muted, "px-3")}>目标只列出了已读的部分。</p>}
    </nav>
  </div></ContextRailContent>;
  const header = <header className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">目标与阶段</h1>
      <p className="mt-1 text-small text-text-secondary">目标、阶段和阶段下的任务都来自本项目的记录；不按工程里程碑推算完成比例。</p>
      <p className={cn(muted, "mt-1")} role="status" data-read-scope="">{scopeLine(goalsRead.data, stages.length, work, recordsShown, fetching)}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {panel && !propose && <Button size="compact" className="desktop:hidden" onClick={() => panel.setOpen(true)}>阶段信息</Button>}
      <Button size="compact" variant="ghost" onClick={reread} disabled={fetching}><RefreshCw aria-hidden="true" className={fetching ? "animate-spin motion-reduce:animate-none" : undefined} />{fetching ? "正在核对…" : "重新读取"}</Button>
      {!propose && <Button asChild size="compact" variant="primary"><a href={proposeHref}><Plus aria-hidden="true" />新建任务</a></Button>}
    </div>
  </header>;
  const readNotices = <>
    {(states.goals === "failed" || states.stages === "failed") && <ErrorState title="目标与阶段读取失败"
      happened={errorText(goalsRead.error ?? stagesRead.error)} next="可以重新读取；读取失败不代表项目没有目标或阶段。" action={<Button size="compact" onClick={reread}>重新读取</Button>} />}
    {(states.goals === "stale" || states.stages === "stale") && <Notice tone="error" title="重新读取失败，下面是上次读回的内容，当前待核对"
      action={<Button size="compact" onClick={reread}>再试一次</Button>}>{errorText(goalsRead.error ?? stagesRead.error)}。不能据此判断当前进度；草稿保留，提交暂停。</Notice>}
    {(states.goals === "checking" || states.stages === "checking") && <p role="status" className={muted}>正在核对目标与阶段；旧内容和草稿保留，读回前不能据此判断当前进度。</p>}
    {missingChoice && <Notice tone="waiting">地址里所选的目标或阶段不在已读的记录里，下面改为显示默认的阶段。</Notice>}
  </>;
  const narrowChooser = stages.length + goals.length > 1 && <label className="flex flex-col gap-1 desktop:hidden"><span className={muted}>切换目标或阶段</span>
    <Select className="w-full" value={stage ? `stage:${stage.id}` : goal ? `goal:${goal.id}` : ""} onChange={event => {
      const [kind, id = ""] = event.target.value.split(":");
      choose(kind === "stage" ? { stageId: id } : { goalId: id });
    }}>
      {tree.items.map(({ goal: item, stages: owned }) => <optgroup key={item.id} label={item.outcome}>
        <option value={`goal:${item.id}`}>目标：{item.outcome}</option>
        {owned.map(entry => <option key={entry.id} value={`stage:${entry.id}`}>{stageStatus[entry.state].label} · {entry.deliverable}</option>)}
      </optgroup>)}
      {tree.orphans.map(entry => <option key={entry.id} value={`stage:${entry.id}`}>{stageStatus[entry.state].label} · {entry.deliverable}</option>)}
    </Select></label>;
  const center = propose
    ? <CreateTaskView context={context} active={active} pathname={journeyHref} embedded back={{ href: stage ? stageHref(stage.id) : journeyHref, label: "返回目标与阶段" }} />
    : <>
      {header}
      {readNotices}
      {recordsShown && narrowChooser}
      {recordsShown && !goals.length && !stages.length && <EmptyState title={goalsRead.data?.complete ? "还没有目标" : "已读范围内没有目标"}
        reason="先写下想达成的结果、谁会使用成果和授权范围，再提出阶段。这里不会自动创建示例数据。" />}
      {goal && <GoalCard context={context} goal={goal} paused={paused} stageCount={stages.filter(item => item.goalId === goal.id).length} />}
      {stage && <StageView context={context} stage={stage} tasks={groups ? groups.byStage.get(stage.id) ?? [] : null} workState={states.work} workError={workRead.error}
        workComplete={!!work?.complete} onReread={reread} paused={paused} recordsFresh={recordsFresh} proposeHref={proposeHref} />}
      {!stage && goal && <GoalStages goal={goal} stages={stages.filter(item => item.goalId === goal.id)} stageHref={stageHref} stageMeta={stageMeta} />}
      {recordsShown && <details className={cn(card, "text-small")} open={!goals.length}>
        <summary className="cursor-pointer font-semibold text-foreground">建立一个目标</summary>
        <div className="mt-3"><GoalCreateForm context={context} paused={paused} /></div>
      </details>}
    </>;
  return <DraftsContext.Provider value={drafts}>
    {rail}
    <div data-ui="" className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7" data-journey="">
      {center}
    </div>
    {!propose && <ContextPanelContent><JourneyFacts projectId={projectId} goal={goal} stage={stage} states={states} goalsComplete={!!goalsRead.data?.complete}
      goalsCount={goals.length} stagesCount={stages.length} work={work} outside={groups?.outside ?? null} tasks={stage && groups ? groups.byStage.get(stage.id) ?? [] : null}
      observedAt={Math.max(goalsRead.dataUpdatedAt, stagesRead.dataUpdatedAt)} /></ContextPanelContent>}
  </DraftsContext.Provider>;
}

function scopeLine(goals: { items: Goal[]; complete: boolean } | undefined, stages: number, work: { items: unknown[]; complete: boolean } | undefined, shown: boolean, fetching: boolean): string {
  if (!shown) return fetching ? "正在读取目标、阶段与阶段下的任务…" : "目标与阶段尚未读回。";
  const tasks = work ? `任务 ${work.items.length} 项${work.complete ? "（含已关闭）" : "（只读了一部分）"}` : "任务尚未读回";
  return `目标 ${goals?.items.length ?? 0} 项${goals?.complete ? "" : "（只读了一部分）"} · 阶段 ${stages} 项 · ${tasks}${fetching ? " · 正在核对" : ""}`;
}

/** A native disclosure: forms inside stay mounted while folded, so an unsent draft still counts when leaving. */
function Disclosure({ summary, children, defaultOpen = false }: { summary: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return <details open={defaultOpen} className="group text-small">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-label font-medium text-text-secondary outline-none hover:text-foreground focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{summary}
    </summary>
    <div className="mt-3 pl-5">{children}</div>
  </details>;
}

function OwnerText({ projectId, owner }: { projectId: string; owner: string }) {
  return isRoleOwnerId(owner) ? <RoleName projectId={projectId} roleId={owner} /> : <>{owner}</>;
}

function GoalCard({ context, goal, paused, stageCount }: { context: MutationContext; goal: Goal; paused: string | null; stageCount: number }) {
  const projectId = context.projectId;
  return <section aria-label="目标" className={card} data-goal={goal.id}>
    <p className={muted}>目标 · 第 {goal.version} 版 · {stageCount} 个阶段</p>
    <h2 className="text-heading font-semibold text-foreground [overflow-wrap:anywhere]">{goal.outcome}</h2>
    <p className="text-small text-text-secondary">谁会使用：{goal.consumer} · 承接：<OwnerText projectId={projectId} owner={goal.owner} /></p>
    <Disclosure summary="约束、授权与范围">
      <div className="flex flex-col gap-2">{(["constraints", "authority", "scope"] as const).map(key => <div key={key} className="flex flex-col gap-0.5">
        <p className={muted}>{goalFieldLabels[key]}</p><p className="whitespace-pre-wrap text-small text-foreground [overflow-wrap:anywhere]">{goal[key]}</p></div>)}</div>
    </Disclosure>
    <Disclosure summary="修订目标"><GoalReviseForm key={goal.id} context={context} goal={goal} paused={paused} /></Disclosure>
    <Disclosure summary="为这个目标提出阶段"><StageProposeForm key={goal.id} context={context} goal={goal} paused={paused} /></Disclosure>
    <RevisionHistory projectId={projectId} summary="目标修订历史" queryKey={["goal", goal.id, "revisions", goal.version]}
      read={async () => (await api().goalRevisions(projectId, goal.id)).map((revision: GoalRevision) => ({
        key: String(revision.version), title: `第 ${revision.version} 版`, body: [revision.outcome, `谁会使用：${revision.consumer}`, `约束：${revision.constraints}`, `授权：${revision.authority}`, `范围：${revision.scope}`],
        reason: revision.reason, createdAt: revision.createdAt, actorId: revision.actorId,
      }))} />
    <FullIdentifiers rows={[{ label: "目标", value: goal.id }, { label: "记录者", value: goal.actorId }, { label: "承接责任者原文", value: goal.owner, text: true }]} />
  </section>;
}

function GoalStages({ goal, stages, stageHref, stageMeta }: { goal: Goal; stages: Stage[]; stageHref(id: string): string; stageMeta(stage: Stage): string }) {
  return <section aria-label="这个目标的阶段" className={card}>
    <h2 className="text-label font-semibold text-foreground">这个目标的阶段 · {stages.length}</h2>
    {stages.length ? <ul className="flex flex-col gap-0.5">{stages.map(stage => <li key={stage.id}>
      <ListRow href={stageHref(stage.id)} title={stage.deliverable} meta={stageMeta(stage)} trailing={<StatusTag tone={stageStatus[stage.state].tone} label={stageStatus[stage.state].label} />} />
    </li>)}</ul> : <p className="text-small text-text-secondary">还没有阶段。下一步：在上面“为这个目标提出阶段”里写下阶段交付和学习问题。</p>}
    <p className={muted}>“{goal.outcome}”下的阶段按记录列出；选一个阶段查看所属任务和回看。</p>
  </section>;
}

function StageView({ context, stage, tasks, workState, workError, workComplete, onReread, paused, recordsFresh, proposeHref }: {
  context: MutationContext; stage: Stage; tasks: LeaderWorkTask[] | null; workState: ReadState; workError: unknown; workComplete: boolean;
  onReread(): void; paused: string | null; recordsFresh: boolean; proposeHref: string;
}) {
  const projectId = context.projectId;
  const shownTasks = workState === "loading" || workState === "failed" ? null : tasks ?? [];
  const reviewsRead = useProjectQuery(projectId, [journeyKey, "stage", stage.id, "reviews", stage.version], async () => {
    const reviews = await api().stageReviews(projectId, stage.id);
    if (reviews.some(review => review.stageId !== stage.id)) throw new Error("阶段回看与所选阶段不符");
    return reviews;
  });
  const reviews = orderReviews(reviewsRead.data ?? []);
  const latest = reviews.at(-1);
  const reviewsState = readState(reviewsRead);
  const reviewsFresh = reviewsState === "fresh" && recordsFresh;
  const status = stageStatus[stage.state];
  return <>
    <section aria-label="阶段" className="flex flex-col gap-2" data-stage={stage.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-heading font-semibold text-foreground [overflow-wrap:anywhere]">{stage.deliverable}</h2>
        <StatusTag tone={status.tone} label={status.label} />
      </div>
      <p className="text-small text-text-secondary"><span className="text-muted-foreground">学习问题　</span>{stage.learningQuestion}</p>
      <p className="text-small text-foreground" data-stage-next=""><span className="font-semibold">下一步：</span>{stageNextStep(stage, shownTasks, workComplete)}</p>
    </section>
    <section aria-label="阶段下的任务" className={card}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-label font-semibold text-foreground">阶段下的任务{shownTasks ? ` · ${shownTasks.length}` : ""}</h3>
        {workState === "checking" && <RefreshingIndicator />}
      </div>
      {workState === "loading" && <LoadingState lines={3} label="正在读取阶段下的任务" />}
      {workState === "failed" && <ErrorState title="阶段下的任务暂不可读取" happened={errorText(workError)} next="这不表示阶段没有任务；可以重新读取，或到任务列表查看。"
        action={<Button size="compact" onClick={onReread}>重新读取</Button>} />}
      {workState === "stale" && <Notice tone="error">任务没有重新读回：{errorText(workError)}。下面是上次读回的任务，当前待核对。</Notice>}
      {shownTasks && !shownTasks.length && <p className="text-small text-text-secondary">{workComplete
        ? stage.state === "active" ? "这个阶段还没有所属任务。" : "这个阶段没有所属任务。"
        : "已读的任务里没有属于这个阶段的；任务没有读全，不能断定没有。"}
        {stage.state === "active" && <> <a href={proposeHref} className="font-medium text-primary hover:underline">新建所属任务</a></>}</p>}
      {shownTasks && shownTasks.length > 0 && <ul className="flex flex-col">{orderStageTasks(shownTasks).map(item => <StageTaskRow key={item.taskId} projectId={projectId} item={item} />)}</ul>}
    </section>
    {stage.state !== "reviewed" || latest || reviewsState !== "fresh" ? <section aria-label="接受与回看" className={card}>
      <h3 className="text-label font-semibold text-foreground">{stage.state === "proposed" ? "接受阶段" : stage.state === "active" ? "阶段回看" : "纠正回看"}</h3>
      {stage.state === "proposed" && <><p className={muted}>接受后阶段进入推进，才能建立所属任务。</p>
        <Disclosure summary="接受这个阶段"><StageAcceptForm key={stage.id} context={context} stage={stage} paused={paused} /></Disclosure></>}
      {stage.state === "active" && <><p className={muted}>阶段的交付和使用结果出来后，记录采用了什么、推翻了什么、还差什么，以及下一选择。</p>
        <Disclosure summary="记录阶段回看"><StageReviewForm key={stage.id} context={context} stage={stage} paused={paused} /></Disclosure></>}
      {stage.state === "reviewed" && <>
        <p className={muted}>阶段已回看。新证据改变判断时，追加一条纠正；旧判断保留在下面的记录里。</p>
        {reviewsState === "loading" && <p role="status" className={muted}>正在读取最新回看；读回前不能提交纠正。</p>}
        {reviewsState === "fresh" && !latest && <Notice tone="error">没有读到可纠正的回看记录，请先核对回看历史。</Notice>}
        {latest && <Disclosure summary="追加回看纠正"><StageCorrectForm key={`${stage.id}:${latest.id}`} context={context} stage={stage} latest={latest}
          paused={paused ?? (reviewsFresh ? null : "最新回看正在核对或没有读回，纠正暂停；读回后再提交。")} /></Disclosure>}
      </>}
    </section> : null}
    <section aria-label="阶段回看记录" className={card}>
      <div className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-label font-semibold text-foreground">回看记录{reviewsRead.data ? ` · ${reviews.length}` : ""}</h3>
        {reviewsState === "checking" && <RefreshingIndicator />}</div>
      {reviewsState === "loading" && <LoadingState lines={2} label="正在读取回看记录" />}
      {reviewsState === "failed" && <ErrorState title="回看记录暂不可读取" happened={errorText(reviewsRead.error)} next="这不表示没有回看；可以重新读取。"
        action={<Button size="compact" onClick={() => void reviewsRead.refetch()}>重新读取</Button>} />}
      {reviewsState === "stale" && <Notice tone="error">回看记录没有重新读回：{errorText(reviewsRead.error)}。下面保留上次读回的记录，当前待核对。</Notice>}
      {reviewsRead.data && !reviews.length && <p className="text-small text-text-secondary">还没有回看记录。</p>}
      {reviews.length > 0 && <ol className="flex flex-col">{[...reviews].reverse().map(review => <ReviewItem key={review.id} review={review}
        standing={reviewStanding(review, latest?.id, reviewsFresh)} />)}</ol>}
    </section>
    <RevisionHistory projectId={projectId} summary="阶段修订历史" queryKey={["stage", stage.id, "revisions", stage.version]}
      read={async () => (await api().stageRevisions(projectId, stage.id)).map((revision: StageRevision) => ({
        key: revision.id, title: `第 ${revision.version} 版 · ${stageStatus[revision.state].label}`, body: [`交付：${revision.deliverable}`, `学习问题：${revision.learningQuestion}`],
        reason: revision.reason, createdAt: revision.createdAt, actorId: revision.actorId,
      }))} />
  </>;
}

function StageTaskRow({ projectId, item }: { projectId: string; item: LeaderWorkTask }) {
  const status = rowStatus(item.taskState, item.phase);
  const open = item.taskState === "todo" || item.taskState === "in_progress";
  return <li className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0" data-stage-task={item.taskId}>
    <div className="flex flex-wrap items-center gap-2">
      <a href={href(projectId, "task", item.taskId)} className="min-w-0 text-small font-medium text-foreground [overflow-wrap:anywhere] hover:underline">{item.title}</a>
      <StatusTag tone={status.tone} label={status.label} />
    </div>
    <p className="text-label text-text-secondary">{workItemNextStep(item)}</p>
    {open && <p className={muted}>下一责任：<ResponsibleName projectId={projectId} item={item} /></p>}
    <FullIdentifiers rows={[{ label: "任务", value: item.taskId }, { label: "下一责任", value: item.responsible.id }, { label: "下一动作原文", value: item.nextAction, text: true }]} />
  </li>;
}

function ReviewItem({ review, standing }: { review: StageReview; standing: string }) {
  const rows: [string, string][] = [["采用", review.adopted], ["推翻或不成立", review.rejected], ["差距与未知", review.gap], ["证据", review.evidence], ["理由", review.reason]];
  return <li className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0 first:pt-0" data-review={review.id}>
    <p className="text-small text-foreground"><span className="font-semibold">{nextChoiceLabel[review.nextChoice]}</span><span className="text-muted-foreground"> · {standing}</span></p>
    {rows.filter(([, text]) => text.trim()).map(([label, text]) => <p key={label} className="text-small text-text-secondary [overflow-wrap:anywhere]"><span className="text-muted-foreground">{label}　</span>{text}</p>)}
    <p className={muted}>记录于 {date(review.createdAt)}{review.supersedesReviewId ? " · 纠正了一条较早的回看" : ""}</p>
    <FullIdentifiers rows={[{ label: "回看", value: review.id }, { label: "纠正的回看", value: review.supersedesReviewId }, { label: "记录者", value: review.actorId }]} />
  </li>;
}

interface HistoryItem { key: string; title: string; body: string[]; reason: string; createdAt: string; actorId: string }

/** Revisions are read when the history is opened. */
function RevisionHistory({ projectId, summary, queryKey, read }: { projectId: string; summary: string; queryKey: unknown[]; read(): Promise<HistoryItem[]> }) {
  const [open, setOpen] = React.useState(false);
  const query = useProjectQuery(projectId, [journeyKey, ...queryKey], read, { enabled: open });
  return <details className="group text-small" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-label font-medium text-text-secondary outline-none hover:text-foreground focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{summary}
    </summary>
    <div className="mt-3 flex flex-col pl-5">
      {query.isPending && open && <p role="status" className={muted}>正在读取修订历史…</p>}
      {query.error && <p className={muted}>修订历史暂不可读取：{errorText(query.error)}。{query.data ? "下面是上次读回的记录。" : ""}</p>}
      {query.data && !query.data.length && <p className={muted}>还没有修订记录。</p>}
      {query.data && <ol className="flex flex-col">{[...query.data].reverse().map(item => <li key={item.key} className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0 first:pt-0">
        <p className="font-medium text-foreground">{item.title}</p>
        {item.body.map(line => <p key={line} className="text-text-secondary [overflow-wrap:anywhere]">{line}</p>)}
        <p className={muted}>理由：{item.reason} · {date(item.createdAt)}</p>
        <FullIdentifiers rows={[{ label: "记录者", value: item.actorId }]} />
      </li>)}</ol>}
    </div>
  </details>;
}

function PanelBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>{children}
  </section>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="group" aria-label={label} className="flex flex-col gap-0.5"><p className={muted}>{label}</p><div className="text-label text-foreground [overflow-wrap:anywhere]">{children}</div></div>;
}

function JourneyFacts({ projectId, goal, stage, states, goalsComplete, goalsCount, stagesCount, work, outside, tasks, observedAt }: {
  projectId: string; goal: Goal | undefined; stage: Stage | undefined; states: Record<"goals" | "stages" | "work", ReadState>; goalsComplete: boolean;
  goalsCount: number; stagesCount: number; work: { items: LeaderWorkTask[]; complete: boolean } | undefined; outside: LeaderWorkTask[] | null;
  tasks: LeaderWorkTask[] | null; observedAt: number;
}) {
  const kept = (state: ReadState) => state === "stale" ? "上次读回，当前待核对" : state === "checking" ? "正在核对" : state === "failed" ? "没有读回，无法判断" : state === "loading" ? "正在读取" : "";
  const recordsState = states.goals === "fresh" && states.stages === "fresh" ? "" : kept(states.goals) || kept(states.stages);
  return <div data-ui="" role="region" aria-label="目标与阶段的信息" className="flex flex-col gap-4">
    <PanelBlock title="读取范围">
      <Fact label="目标与阶段">{states.goals === "loading" || states.goals === "failed" ? kept(states.goals) : `目标 ${goalsCount} 项${goalsComplete ? "" : "（只读了一部分）"} · 阶段 ${stagesCount} 项`}{recordsState && states.goals !== "loading" && states.goals !== "failed" ? ` · ${recordsState}` : ""}</Fact>
      <Fact label="任务">{work ? `${work.items.length} 项${work.complete ? "，已读全（含已关闭）" : "，只读了一部分"}` : kept(states.work)}{work && kept(states.work) ? ` · ${kept(states.work)}` : ""}</Fact>
      {observedAt > 0 && <Fact label="读于">{date(new Date(observedAt).toISOString())}</Fact>}
    </PanelBlock>
    {stage && <PanelBlock title="所选阶段">
      <Fact label="状态"><StatusTag tone={stageStatus[stage.state].tone} label={stageStatus[stage.state].label} /> · 第 {stage.version} 版</Fact>
      <Fact label="任务进展">{tasks ? tasks.length ? phaseCounts(tasks, phase => leaderPhaseLabel[phase]) : work?.complete ? "没有所属任务" : "已读部分没有所属任务" : kept(states.work) || "无法判断"}</Fact>
      <Fact label="提出于">{date(stage.createdAt)}</Fact>
    </PanelBlock>}
    {goal && <PanelBlock title="目标">
      <Fact label="谁会使用">{goal.consumer}</Fact>
      <Fact label="承接">{isRoleOwnerId(goal.owner) ? <RoleName projectId={projectId} roleId={goal.owner} /> : goal.owner}</Fact>
      <Fact label="版本">第 {goal.version} 版 · 建立于 {date(goal.createdAt)}</Fact>
    </PanelBlock>}
    <PanelBlock title="不属于阶段的任务">
      <p className="text-label text-foreground">{outside ? `${outside.length} 项${work?.complete ? "" : "（已读部分）"}` : kept(states.work) || "无法判断"}</p>
      <p className={muted}>没有所属阶段、或所属阶段不在已读记录里的任务，不计入上面的关系。<a href={href(projectId, "work")} className="text-primary hover:underline">到任务列表查看</a></p>
    </PanelBlock>
    <FullIdentifiers rows={[{ label: "目标", value: goal?.id }, { label: "阶段", value: stage?.id }, { label: "阶段提出者", value: stage?.actorId }]} />
  </div>;
}
