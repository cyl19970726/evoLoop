import { BadgeCheck, Braces, CircleDot, Code2, Diamond, Grid2X2, Layers3, Sparkles } from "lucide-react";
import type { SessionIdentity } from "@evoloop/contracts/session-identity";
import { fallbackSessionIdentity } from "@evoloop/contracts/session-identity";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import "./session-identity.css";

const icons = { diamond: Diamond, dot: CircleDot, layers: Layers3, brackets: Braces,
  spark: Sparkles, grid: Grid2X2, check: BadgeCheck, code: Code2 } as const;

/** The mark identifies an exact Session. Status and source evidence are displayed separately. */
export function SessionIdentityMark({ target, identity, name, size = "regular" }: {
  target: SessionTarget; identity: SessionIdentity | null; name: string; size?: "regular" | "small";
}) {
  if (!target) return null;
  const visual = identity ?? fallbackSessionIdentity(target);
  const Icon = icons[visual.mark];
  return <span className={`session-identity-mark session-identity-${visual.color} ${size === "small" ? "small" : ""}`}
    role="img" aria-label={`${name}的 Session 标记`} title={`${name} · Session 身份`}>
    <Icon size={size === "small" ? 16 : 19} strokeWidth={2.2} aria-hidden="true" />
  </span>;
}
