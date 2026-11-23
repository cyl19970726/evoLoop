// “跳到” (Task 5eb93990): what a pasted text means and what the lookup returns. One parser for the server and the
// workbench, so the box never sends a request the server would refuse and the two never read the same text two ways.

export const jumpResultLimit = 10;
export const jumpMinimumHexLength = 8;
export type JumpObjectKind = "task" | "document" | "session" | "stage" | "schedule" | "delivery";

export interface JumpMatch {
  kind: JumpObjectKind;
  /** The full id of the object. */
  id: string;
  /** Task title, document title, agent name, stage deliverable or schedule title; a delivery shows the title of its task. */
  title: string;
  /** In-app address inside the project; a delivery and a PR number open their task's 交付与使用 tab. */
  href: string;
  /** For a delivery or a PR number: the task the address belongs to. */
  taskId?: string;
}
export interface JumpResult { query: string; matches: JumpMatch[]; truncated: boolean }

export type JumpInput =
  /** 8–32 hex digits with optional hyphens, up to a full id: a prefix of the object id. */
  | { kind: "id"; prefix: string }
  | { kind: "pr"; number: number }
  /** Not usable: `short` is hex shorter than the minimum, `invalid` is anything else. */
  | { kind: "short"; length: number }
  | { kind: "invalid" };


/** The hex digits of an id prefix, hyphens removed, lower case; null when the text is not hex-and-hyphen. */
function hexDigits(text: string): string | null {
  if (!/^[0-9a-f-]+$/i.test(text)) return null;
  const digits = text.replaceAll("-", "").toLowerCase();
  return digits.length > 0 && digits.length <= 32 ? digits : null;
}

/**
 * `#527` or `527` is a PR number; at least 8 hex digits (hyphens allowed, as in a pasted id) is an id prefix, so an
 * all-digit text of 8 or more digits is an id prefix. Fewer than 8 hex digits that are not a PR number is `short`.
 */
export function parseJumpInput(raw: string): JumpInput {
  const text = raw.trim();
  if (!text) return { kind: "invalid" };
  const pr = /^#(\d{1,7})$/.exec(text) ?? /^(\d{1,7})$/.exec(text);
  if (pr) { const number = Number(pr[1]); return number > 0 ? { kind: "pr", number } : { kind: "invalid" }; }
  const digits = hexDigits(text);
  if (!digits) return { kind: "invalid" };
  if (digits.length < jumpMinimumHexLength) return { kind: "short", length: digits.length };
  return { kind: "id", prefix: digits };
}

/** The range an id prefix covers, as the smallest and largest full ids that start with it. */
export function jumpPrefixRange(prefix: string): { low: string; high: string } {
  const pad = (fill: string) => {
    const hex = (prefix + fill.repeat(32 - prefix.length));
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return { low: pad("0"), high: pad("f") };
}

export const jumpHint = {
  short: "至少要 8 位",
  none: (text: string) => `没有找到以 ${text} 开头的任务、文档、智能体、阶段或日程`,
} as const;

/** Body links (Task a910ee96): the most candidates one page asks about, and what the batch read returns for each. */
export const jumpBatchLimit = 50;
export interface JumpBatchResult {
  /** Keyed by the candidate as sent. At most two matches are kept: one links straight to its object, two or more link to the choice page. */
  results: Record<string, { matches: JumpMatch[]; truncated: boolean }>;
}
