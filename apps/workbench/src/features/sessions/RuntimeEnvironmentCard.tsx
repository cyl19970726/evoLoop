// 运行环境 in the agent's right column (docs/frontend/pages/sessions.md 右栏): “它在用什么跑”. One main line (runtime ·
// model · reasoning effort, each marked actual or target), a tag only when a target is not yet what runs, the permission
// and skills as small chips, the adjust button at the top right, and every revision fact folded into 配置记录.
// Explanations appear only when they apply. Values come from the same reads as before; only the layout changed.
import type { ReactNode } from "react";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { Badge, StatusTag } from "@evoloop/ui";
import type { MutationContext } from "../../shared/ActionForm";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { FactList } from "../../shared/ui/PageParts";
import { href } from "../../shared/ui/shared";
import { environmentRows, runtimeEnvironment, type EnvironmentValue } from "./environmentPresentation";
import { permissionLabel, type RecoveryRead } from "./recoveryPresentation";
import { useModelControl, type ModelControl } from "./SessionModelControl";

const card = "flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted px-3 py-2.5";
const chip = "inline-flex max-w-full items-center rounded-full bg-raised px-2 py-0.5 text-caption [overflow-wrap:anywhere]";

interface Props {
  context: MutationContext;
  session: ObservedSession;
  recovery: RecoveryRead;
  configuredModel: string | number | null;
  actualModel: string | number | null;
  modelLabelOf: (model: string) => string;
  busy: boolean;
  onApplied(): void;
}

export function RuntimeEnvironmentCard(props: Props) {
  return props.session.kind === "owned" && props.session.target.kind === "owned"
    ? <OwnedRuntimeEnvironment {...props} sessionId={props.session.target.sessionId} />
    : <RuntimeEnvironmentView {...props} control={null} />;
}

function OwnedRuntimeEnvironment(props: Props & { sessionId: string }) {
  const control = useModelControl({ context: props.context, sessionId: props.sessionId, busy: props.busy, onApplied: props.onApplied,
    recovery: props.recovery.status === "ready" ? props.recovery.view : null });
  return <RuntimeEnvironmentView {...props} control={control} />;
}

const value = (item: EnvironmentValue | null, mark: boolean) => item && <span className="inline-flex min-w-0 items-center gap-1">
  <span className="min-w-0 [overflow-wrap:anywhere]">{item.text}</span>
  {mark && <Badge className="h-4 px-1.5">{item.source === "actual" ? "实际" : item.source === "confirmed" ? "已确认" : "目标"}</Badge>}
</span>;

function RuntimeEnvironmentView({ context, session, recovery, configuredModel, actualModel, modelLabelOf, control }: Props & { control: ModelControl | null }) {
  const env = runtimeEnvironment({ kind: session.kind, provider: session.runtime?.provider, recovery, configuredModel, actualModel, modelLabelOf });
  const role = session.roles[0];
  const profile = recovery.status === "ready" ? recovery.view.executionProfile : null;
  // Marks per value only when they differ; when both are targets one short note says so for the whole line.
  const allTarget = env.model?.source === "target" && env.effort?.source !== "confirmed";
  const parts: ReactNode[] = [env.runtime, value(env.model, !allTarget), value(env.effort, !allTarget)].filter(Boolean);
  const record: Array<[string, ReactNode]> = session.kind === "external"
    ? [...environmentRows({ kind: "external", recovery, configuredModel, modelLabelOf })]
    : [...(control?.recordRows ?? []),
      ["执行权限", profile ? permissionLabel(profile.revision.sandbox, profile.revision.approvalPolicy) : recovery.status === "loading" ? "正在读取" : "未读到"]];
  record.push(["实际运行模型（最近一轮原生报告）", actualModel ? modelLabelOf(String(actualModel)) : "未记录（还没有任何一轮报告过实际模型，不用配置值代替）"]);
  return <section aria-label="运行环境" className={`session-runtime-environment ${session.kind === "owned" ? "session-model-control " : ""}${card}`}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <h2 className="text-label font-semibold text-foreground">运行环境</h2>
      {control?.button}
    </div>
    {/* While a new target waits, the line is labelled 现在 so “已确认” is not read as the new target in the tag below. */}
    <p className="session-runtime-now flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-small font-medium text-foreground">
      {env.change && <span className="text-caption font-normal text-muted-foreground">现在：</span>}
      {parts.map((part, index) => <span key={index} className="inline-flex min-w-0 items-center gap-1.5">{index > 0 && <span aria-hidden="true" className="text-muted-foreground">·</span>}{part}</span>)}
    </p>
    {env.note ? <p className="text-caption text-text-secondary">{env.note}</p>
      : allTarget && env.model && <p className="text-caption text-text-secondary">目标，尚无实际报告</p>}
    {env.change && <StatusTag className="session-runtime-next mt-0.5 self-start" tone={env.change.tone} label={env.change.label} />}
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {env.permission && <span className={`${chip} text-text-secondary`}>{env.permission}</span>}
      {session.kind === "owned" && role && <a className={`${chip} text-primary outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]`}
        href={`${href(context.projectId, "roles")}?role=${encodeURIComponent(role.id)}`} title={`查看职责“${role.title}”的技能`}>技能随职责“{role.title}”</a>}
    </div>
    {control?.alerts}
    {control?.editor}
    {/* Why the adjust button is off: one line at the card's foot, with where to fix it. */}
    {control?.blocked && <p className="session-adjust-blocked text-caption text-text-secondary [overflow-wrap:anywhere]">不能调整：{control.blocked.text}
      {control.blocked.link && <> · <a className="text-primary hover:underline" href={href(context.projectId, control.blocked.link.place)}>{control.blocked.link.label}</a></>}</p>}
    {/* An external agent has nothing to adjust and a short record: it is shown open, so 外部接入不提供 is in sight. */}
    <details className="session-config-record min-w-0 text-caption" open={session.kind === "external" || undefined}>
      <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">配置记录</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <FactList inline rows={record} />
        {session.kind === "owned" && <p className="text-caption text-text-secondary">思考强度没有逐轮的实际记录；配置读回不代表模型提供方已按该强度执行。</p>}
        {control && <FullIdentifiers rows={control.identifiers} />}
      </div>
    </details>
  </section>;
}
