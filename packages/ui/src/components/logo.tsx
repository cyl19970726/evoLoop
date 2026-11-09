import * as React from "react";

const loop = "M16 16c-2-3-4-4.5-6-4.5a4.5 4.5 0 0 0 0 9c2 0 4-1.5 6-4.5s4-4.5 6-4.5a4.5 4.5 0 0 1 0 9c-2 0-4-1.5-6-4.5";

export interface LogoProps {
  /** Pixel size; at 24 and below the loop is drawn thicker so it stays legible. */
  size?: number | undefined;
  /** Accessible name; omit when the logo sits inside a link that already has one. */
  label?: string | undefined;
  className?: string | undefined;
}

/** The "square loop" mark, drawn with the accent tokens so it follows light and dark themes.
 * It avoids `cn` so the login page can show it without loading the rest of the design system. */
export function Logo({ size = 36, label, className }: LogoProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={className ? `block shrink-0 ${className}` : "block shrink-0"}>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
      <path d={loop} fill="none" stroke="var(--on-accent)" strokeWidth={size <= 24 ? 2.8 : 2.3} strokeLinecap="round" />
    </svg>
  );
}
