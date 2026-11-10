// 设置展示信息: the form and the command it sends. The name field starts from what the service holds (the registered
// name, or else the service's own title), never from the page's generic way of naming an unregistered agent
// (shared/agentNamePresentation): saving only a new 团队归属 must not register “职责 · 外部接入的智能体” as a name that
// several agents of one role would then share.
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import { option, type Field } from "../../shared/ActionForm";

export function sessionProfileFields(snapshot: SessionSnapshot): Field[] {
  const profile = snapshot.session.profile;
  return [
    { name: "displayName", label: "展示名称", value: profile?.displayName ?? snapshot.session.title },
    { name: "purpose", label: "用途", kind: "textarea", optional: true, value: profile?.purpose ?? "" },
    { name: "membership", label: "团队归属", kind: "select", value: profile?.membership ?? snapshot.session.membership, options: [option("current", "当前团队"), option("historical", "历史"), option("unclassified", "待归类")] },
    { name: "tenure", label: "会话性质", kind: "select", value: profile?.tenure ?? "unknown", options: [option("resident", "常驻"), option("temporary", "临时"), option("unknown", "未知")] },
    { name: "reason", label: "变更依据", kind: "textarea" },
  ];
}

export function sessionProfileCommand(snapshot: SessionSnapshot, v: Record<string, string>): Record<string, unknown> {
  const profile = snapshot.session.profile;
  return { type: "session.profile.set", target: profile?.target ?? snapshot.session.target, expectedVersion: profile?.version ?? 0,
    displayName: v.displayName, purpose: v.purpose, membership: v.membership, tenure: v.tenure, reason: v.reason };
}
