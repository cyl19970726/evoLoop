// 调整颜色与图标: the saved identity mark of one agent. It is separate from its state, role and model.
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { identityColors, identityMarks, fallbackSessionIdentity } from "@evoloop/contracts/session-identity";
import { mutedText } from "../../shared/ui/PageParts";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import { SessionIdentityMark, identityColorLabels } from "./SessionIdentityMark";
const markLabels = ["菱形", "圆点", "叠层", "括号", "星形", "方格", "勾章", "代码"];

export function SessionIdentityControl({ context, session, onApplied }: {
  context: MutationContext; session: ObservedSession; onApplied(): void;
}) {
  const visual = session.identity ?? fallbackSessionIdentity(session.target);
  return <section aria-label="智能体标识设置" className="flex min-w-0 flex-col gap-2">
    <p className="flex min-w-0 items-center gap-2 text-caption text-text-secondary"><SessionIdentityMark target={session.target} identity={session.identity} name={agentDisplayName(session)} size="small" /><span className="min-w-0">{agentDisplayName(session)} · 身份标记独立于运行状态、职责和模型。</span></p>
    {session.identity ? <ActionForm context={{ ...context, draftScope: `session-identity:${session.key}`,
      draftBaseline: String(session.identity.version) }} review title="调整颜色与图标" fields={[
      { name: "color", label: "身份颜色", kind: "select", value: visual.color,
        options: identityColors.map((color, index) => ({ value: color, label: identityColorLabels[index]! })) },
      { name: "mark", label: "图形标记", kind: "select", value: visual.mark,
        options: identityMarks.map((mark, index) => ({ value: mark, label: markLabels[index]! })) },
      { name: "reason", label: "变更依据", kind: "textarea" },
    ]} build={value => ({ type: "session.identity.set", target: session.identity!.target,
      expectedVersion: session.identity!.version, color: value.color, mark: value.mark, reason: value.reason })}
      onApplied={onApplied} /> : <p className={mutedText} role="status">这个智能体还没有保存的身份标记；请先完成数据库迁移并重新读取。</p>}
  </section>;
}
