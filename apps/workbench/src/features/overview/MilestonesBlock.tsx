// The overview's top row (docs/frontend/overview-top-design.md): the deployed version on the left, the project's 阶段 block on the right (features/stages).
// The version comes from GET /api/version.
import { api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { versionView } from "./milestonesPresentation";
import { StagesBlock } from "../stages";

const card = "flex min-w-0 flex-col gap-1.5 rounded-xl bg-raised px-4 py-2.5 border border-border compact:px-5";
const muted = "text-caption text-muted-foreground";
const heading = "text-label font-semibold text-foreground";

export function MilestonesBlock({ projectId, active }: { projectId: string; active: boolean }) {
  const version = useProjectQuery(projectId, ["overview", "version"], signal => api().version(signal, projectId), { enabled: active, retry: false });
  const v = versionView(version.data ?? null);
  return <div className="@container" data-overview-top="">
    <div className="grid gap-3 @2xl:grid-cols-[14rem_minmax(0,1fr)]">
      <section className={card} aria-label="线上当前版本" data-overview-version="">
        <h2 className={heading}>线上当前版本</h2>
        {version.isPending && <p className={muted} role="status">正在读取版本…</p>}
        {!version.isPending && <dl className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-small [&>dt]:after:content-['：'] [&>dd]:mr-2">
          <dt className={muted}>源码提交</dt><dd className="m-0">{v.readable ? <code className="rounded-sm bg-field px-1.5 font-mono text-caption">{v.commit}</code> : <span className="text-text-secondary">{v.commit}</span>}</dd>
          <dt className={muted}>构建时间</dt><dd className="m-0 text-foreground">{v.builtAt}</dd>
          <dt className={muted}>启动时间</dt><dd className="m-0 text-foreground">{v.startedAt}</dd>
        </dl>}
        {version.isError && <p className={muted} role="status">版本接口这次没有读到（{errorText(version.error)}）；不显示旧版本。</p>}
        <p className="m-0 flex flex-wrap gap-x-2 text-caption">{v.links.map(link => <a key={link.href} className="text-primary hover:underline" href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}</p>
      </section>
      <StagesBlock projectId={projectId} active={active} />
    </div>
  </div>;
}
