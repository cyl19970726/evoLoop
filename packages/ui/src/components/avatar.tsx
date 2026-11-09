import * as React from "react";
import { cn } from "../lib/cn";

/*
 * Agent avatars are illustrations, so their colours live here rather than in tokens.css.
 * The background colour follows the role (all instances of one role share it); hair and accessories follow the
 * individual agent. No palette uses green (DEC-029).
 */

type HairStyle = "short" | "bun" | "curly" | "long" | "bob" | "side";

export interface AvatarLook {
  background: string;
  shirt: string;
  skin: string;
  shade: string;
  hair: HairStyle;
  hairColor: string;
  glasses?: boolean | undefined;
  hat?: string | undefined;
  tie?: boolean | undefined;
}

const rolePalettes = [
  { background: "#dce3fa", shirt: "#4c66d1" },
  { background: "#f4e2d1", shirt: "#33415c" },
  { background: "#ebe0f6", shirt: "#8b5a9c" },
  { background: "#fbe4dc", shirt: "#d2704f" },
  { background: "#fcefc9", shirt: "#c9962f" },
  { background: "#e6e1d8", shirt: "#3b3834" },
  { background: "#e0e8f2", shirt: "#56708f" },
] as const;
const skins = [["#f5d3b8", "#e8bc9c"], ["#ebc09b", "#d9a781"], ["#d9a27c", "#c48b66"], ["#f0c9a8", "#ddb08c"]] as const;
const hairStyles: HairStyle[] = ["short", "bun", "curly", "long", "bob", "side"];
const hairColors = ["#2e241e", "#1f1a17", "#4a3021", "#3b2a20", "#8e877c", "#5a3a28"] as const;

/** Fixed looks for the system agents, so 统筹 and 复盘 are recognisable in every project. */
export const systemLooks = {
  leader: { background: "#e6e1d8", shirt: "#3b3834", skin: "#f0c9a8", shade: "#ddb08c", hair: "side", hairColor: "#2b2724", tie: true },
  review: { background: "#e0e8f2", shirt: "#56708f", skin: "#f5d3b8", shade: "#e8bc9c", hair: "bob", hairColor: "#8e877c", glasses: true },
} satisfies Record<string, AvatarLook>;

function pick<T>(list: readonly T[], n: number): T {
  return list[n % list.length] as T;
}

function hash(value: string) {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derives a stable look: the role picks the background, the agent picks everything else. */
export function avatarLook(agentSeed: string, roleSeed: string = agentSeed): AvatarLook {
  const palette = pick(rolePalettes, hash(roleSeed));
  const h = hash(agentSeed);
  const [skin, shade] = pick(skins, h);
  const extra = (h >>> 12) % 7;
  return {
    ...palette,
    skin,
    shade,
    hair: pick(hairStyles, h >>> 4),
    hairColor: pick(hairColors, h >>> 8),
    glasses: extra === 0 || extra === 3,
    tie: extra === 6,
    ...(extra === 5 ? { hat: "#c2643c" } : {}),
  };
}

/** Lists every role background, for tests and the sample page. */
export const avatarRoleBackgrounds: readonly string[] = rolePalettes.map(palette => palette.background);

function Hair({ style, color }: { style: HairStyle; color: string }) {
  const fringe = "M11.6 17.4c.6-4.9 4-7.7 8.4-7.7 4.6 0 7.8 2.8 8.4 7.7-2.4-2.3-5.2-3.7-8.6-3.7-3.2 0-6 1.2-8.2 3.7z";
  switch (style) {
    case "short": return <path d="M11.2 18.4c-.5-5.8 3.4-9.6 8.8-9.6s9.3 3.8 8.8 9.6c-1.4-2.7-3.7-4.3-6.5-4.7-1.3 1.5-3.7 2.5-6.3 2.5-1.9 0-3.6.6-4.8 2.2z" fill={color} />;
    case "bun": return <><circle cx="20" cy="8.4" r="3.5" fill={color} /><path d="M11.4 18.2c-.2-5.3 3.6-9 8.6-9s8.8 3.7 8.6 9c-2-2.7-5-4.1-8.6-4.1s-6.6 1.4-8.6 4.1z" fill={color} /></>;
    case "curly": return <>{[[13.4, 13.2, 3.3], [16.9, 10.7, 3.5], [21, 10.1, 3.5], [24.8, 11.6, 3.3], [27.3, 15.1, 2.7], [12.2, 16.5, 2.5]].map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={color} />)}</>;
    case "long":
    case "bob": return <path d={fringe} fill={color} />;
    case "side": return <path d="M11.4 18.6c-.6-5.9 3.2-9.8 8.6-9.8 5.6 0 9.3 3.9 8.6 9.8-.8-3.3-2.6-5.5-5-6.3-2.7 1.7-7.3 2.5-12.2 6.3z" fill={color} />;
  }
}

function BackHair({ style, color }: { style: HairStyle; color: string }) {
  if (style === "long") return <path d="M10.6 19.5c0-6.5 4-10.9 9.4-10.9s9.4 4.4 9.4 10.9v8.6c-1.6.9-3.4.9-4.6 0v-7.1H15.2v7.1c-1.2.9-3 .9-4.6 0z" fill={color} />;
  if (style === "bob") return <path d="M10.8 20c0-6.3 4-10.7 9.2-10.7s9.2 4.4 9.2 10.7v3.4c-1.2.8-2.6.8-3.4 0v-3.2H14.2v3.2c-.8.8-2.2.8-3.4 0z" fill={color} />;
  return null;
}

export interface AgentAvatarProps {
  /** Stable id of the agent (Session); decides hair and accessories. */
  seed: string;
  /** Stable id of its role; decides the background colour. Defaults to the seed. */
  roleSeed?: string | undefined;
  /** Overrides the derived look, for example systemLooks.leader. */
  look?: AvatarLook | undefined;
  /** Pixel size: 16–24 in flows and tables, 30 in rails, 32–40 in headers. */
  size?: number | undefined;
  /** Accessible name, usually the agent's name. Omit when the name is printed next to the avatar. */
  label?: string | undefined;
  className?: string | undefined;
}

/** A cartoon avatar for an agent. */
export function AgentAvatar({ seed, roleSeed, look, size = 30, label, className }: AgentAvatarProps) {
  const clipId = React.useId();
  const a = look ?? avatarLook(seed, roleSeed);
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("block shrink-0", className)}>
      <defs><clipPath id={clipId}><circle cx="20" cy="20" r="20" /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="20" cy="20" r="20" fill={a.background} />
        <BackHair style={a.hair} color={a.hairColor} />
        <path d="M6.5 41c1.2-7.4 6.8-11.4 13.5-11.4s12.3 4 13.5 11.4z" fill={a.shirt} />
        <rect x="17.4" y="24.8" width="5.2" height="5.4" rx="1.8" fill={a.shade} />
        <circle cx="11.6" cy="19.8" r="1.6" fill={a.skin} />
        <circle cx="28.4" cy="19.8" r="1.6" fill={a.skin} />
        <circle cx="20" cy="19" r="8.6" fill={a.skin} />
        <Hair style={a.hair} color={a.hairColor} />
        {a.tie && <path d="M17.4 30.2l2.6 2.4 2.6-2.4M20 32.4l-1.2 5.6L20 39.6l1.2-1.6z" fill="#c2643c" stroke="#f4efe7" strokeWidth="0.6" />}
        {a.hat && <ellipse cx="19" cy="10.6" rx="9.6" ry="3.4" fill={a.hat} transform="rotate(-8 19 10.6)" />}
        <circle cx="16.9" cy="19.7" r="1.05" fill="#2b2420" />
        <circle cx="23.1" cy="19.7" r="1.05" fill="#2b2420" />
        <circle cx="14.7" cy="22.3" r="1.4" fill="#f09a80" opacity="0.35" />
        <circle cx="25.3" cy="22.3" r="1.4" fill="#f09a80" opacity="0.35" />
        <path d="M17.3 23.2c1.6 1.4 3.8 1.4 5.4 0" fill="none" stroke="#2b2420" strokeWidth="1.1" strokeLinecap="round" />
        {a.glasses && <g fill="none" stroke="#2b2420" strokeWidth="0.9"><circle cx="16.9" cy="19.7" r="2.7" /><circle cx="23.1" cy="19.7" r="2.7" /><path d="M19.6 19.6h0.8" /></g>}
      </g>
    </svg>
  );
}

export interface PersonAvatarProps {
  name: string;
  size?: number | undefined;
  className?: string | undefined;
}

/** A person's account: the first character on the brand colour. */
export function PersonAvatar({ name, size = 30, className }: PersonAvatarProps) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-on-brand", className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {initial}
    </span>
  );
}
