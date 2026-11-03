import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { identityColors, identityMarks, fallbackSessionIdentity } from "@evoloop/contracts/session-identity";
import { SessionIdentityMark } from "./SessionIdentityMark";

const colorLabels = ["紫", "铜", "蓝", "青", "玫红", "橄榄", "珊瑚", "梅紫"];
const markLabels = ["菱形", "圆点", "叠层", "括号", "星形", "方格", "勾章", "代码"];

export function SessionIdentityControl({ context, session, onApplied }: {
  context: MutationContext; session: ObservedSession; onApplied(): void;
}) {
  const visual = session.identity ?? fallbackSessionIdentity(session.target);
  return <section aria-label="Session 身份设置">
    <p><SessionIdentityMark target={session.target} identity={session.identity} name={session.title} /> {session.title} · 身份标记独立于运行状态、职责和模型。</p>
    {session.identity ? <ActionForm context={{ ...context, draftScope: `session-identity:${session.key}`,
      draftBaseline: String(session.identity.version) }} review title="调整 Session 颜色与图标" fields={[
      { name: "color", label: "身份颜色", kind: "select", value: visual.color,
        options: identityColors.map((color, index) => ({ value: color, label: colorLabels[index]! })) },
      { name: "mark", label: "图形标记", kind: "select", value: visual.mark,
        options: identityMarks.map((mark, index) => ({ value: mark, label: markLabels[index]! })) },
      { name: "reason", label: "变更依据", kind: "textarea" },
    ]} build={value => ({ type: "session.identity.set", target: session.target,
      expectedVersion: session.identity!.version, color: value.color, mark: value.mark, reason: value.reason })}
      onApplied={onApplied} /> : <p role="status">此 Session 尚无已保存的身份标记；请先完成数据库迁移并重新读取。</p>}
  </section>;
}
