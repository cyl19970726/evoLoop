// 设置展示信息: the form and the command it sends. The name field starts from what the service holds (the registered
// name, or else the service's own title), never from the page's generic way of naming an unregistered agent
// (shared/agentNamePresentation): saving only a new 团队归属 must not register “职责 · 外部接入的智能体” as a name that
// several agents of one role would then share.
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import { option, type Field } from "../../shared/ActionForm";

export function sessionProfileFields(snapshot: SessionSnapshot): Field[] {
  const profile = snapshot.session.profile;
  return [
    { name: "displayName", label: "展示名称", value: profile?.displayName ?? snapshot.session.title,
      ...(profile?.displayName ? {} : { hint: "还没有登记名称：现在显示的是服务生成的名称，里面带短标识。请改成要登记的名称再保存。" }) },
    { name: "purpose", label: "用途", kind: "textarea", optional: true, value: profile?.purpose ?? "" },
    { name: "membership", label: "团队归属", kind: "select", value: profile?.membership ?? snapshot.session.membership, options: [option("current", "当前团队"), option("historical", "历史"), option("unclassified", "待归类")] },
    { name: "tenure", label: "会话性质", kind: "select", value: profile?.tenure ?? "unknown", options: [option("resident", "常驻"), option("temporary", "临时"), option("unknown", "未知")] },
    { name: "reason", label: "变更依据", kind: "textarea" },
  ];
}

/** The service's generated title offered as a starting point is not a name to register: saving it as typed would store the short identifier as the agent's name. */
export const generatedNameRefusal = "还没有给这个智能体起名：当前的名称是服务生成的，里面带着短标识。请改成要登记的名称。";

export function sessionProfileCommand(snapshot: SessionSnapshot, v: Record<string, string>): Record<string, unknown> {
  const profile = snapshot.session.profile;
  if (!profile?.displayName && (v.displayName ?? "").trim() === snapshot.session.title.trim()) throw new Error(generatedNameRefusal);
  return { type: "session.profile.set", target: profile?.target ?? snapshot.session.target, expectedVersion: profile?.version ?? 0,
    displayName: v.displayName, purpose: v.purpose, membership: v.membership, tenure: v.tenure, reason: v.reason };
}
