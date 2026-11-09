// The mark one agent keeps across clients (its saved colour and icon), drawn with @evoloop/ui's AgentMark. Status and
// source evidence are shown separately; the avatar beside it follows the role.
import { BadgeCheck, Braces, CircleDot, Code2, Diamond, Grid2X2, Layers3, Sparkles } from "lucide-react";
import { AgentMark } from "@evoloop/ui";
import type { SessionIdentity } from "@evoloop/contracts/session-identity";
import { fallbackSessionIdentity, identityColors } from "@evoloop/contracts/session-identity";
import type { SessionTarget } from "@evoloop/contracts/session-work";

/** Display names in the order of identityColors; teal and olive are drawn in non-green hues (AgentMark). */
export const identityColorLabels = ["紫", "铜", "蓝", "青蓝", "玫红", "赭黄", "珊瑚", "梅紫"];

const icons = { diamond: Diamond, dot: CircleDot, layers: Layers3, brackets: Braces,
  spark: Sparkles, grid: Grid2X2, check: BadgeCheck, code: Code2 } as const;
const markNames = { diamond: "菱形", dot: "圆点", layers: "叠层", brackets: "括号", spark: "星形",
  grid: "方格", check: "勾章", code: "代码" } as const;

export function SessionIdentityMark({ target, identity, name, size = "regular" }: {
  target: SessionTarget; identity: SessionIdentity | null; name: string; size?: "regular" | "small";
}) {
  if (!target) return null;
  const visual = identity ?? fallbackSessionIdentity(target);
  const Icon = icons[visual.mark];
  const colour = identityColorLabels[identityColors.indexOf(visual.color)] ?? "未识别";
  return <AgentMark color={visual.color} size={size === "small" ? 22 : 28} label={`${name}的标识：${colour}色、${markNames[visual.mark]}`}
    className={`session-identity-mark session-identity-${visual.color}`}
    icon={<Icon size={size === "small" ? 13 : 16} strokeWidth={2.2} aria-hidden="true" />} />;
}
