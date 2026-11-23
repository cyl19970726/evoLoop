// 正文里的编号成链接 (Task a910ee96): which words of a text may name an object, and what a page learned about them.
// A candidate is a full id, an 8-hex word, `#12` or `PR #12`. Only what the project resolves to exactly one object becomes a link
// to it; several objects link to the choice page (`/go/{text}`); none, or a failed lookup, leaves the text as it was.
// One read answers every candidate that text on a page holds (up to 50, the rest stay text); candidates already answered are not
// asked again. Tests of the pure parts: test/ref-links.test.ts.
import { useEffect, useSyncExternalStore } from "react";
import { jumpBatchLimit, type JumpMatch, type JumpObjectKind } from "@evoloop/contracts/object-jump";
import { api } from "./api";

const candidatePattern = /(?<![0-9A-Za-z_\/#&.=:?@%-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}|(?:PR\s?)?#[0-9]{1,7})(?![0-9A-Za-z_-])/gi;

export interface RefHit { /** The text as written. */ text: string; /** What the lookup is asked: lower case id, or `#12`. */ key: string; index: number }
/** The candidates in a plain text, in order. */
export function refHits(text: string): RefHit[] {
  const hits: RefHit[] = [];
  for (const match of text.matchAll(candidatePattern)) {
    const written = match[0];
    const key = written.includes("#") ? `#${written.slice(written.indexOf("#") + 1)}` : written.toLowerCase();
    hits.push({ text: written, key, index: match.index! });
  }
  return hits;
}

export type RefAnswer = { kind: "one"; match: JumpMatch } | { kind: "many" } | { kind: "none" };
const kindLabel: Record<JumpObjectKind, string> = { task: "任务", document: "文档", session: "智能体", stage: "阶段", schedule: "日程", delivery: "交付" };
/** Where a resolved candidate lands, and what hovering it says. `null`: stays text. */
export function refTarget(projectId: string, key: string, answer: RefAnswer | undefined): { href: string; description: string } | null {
  if (!answer || answer.kind === "none") return null;
  if (answer.kind === "many") return { href: `/p/${projectId}/go/${encodeURIComponent(key)}`, description: `不止一个对象以 ${key} 开头，点开选择` };
  const { match } = answer;
  const delivery = key.startsWith("#") || match.kind === "delivery";
  return { href: match.href, description: `${delivery ? "交付" : kindLabel[match.kind]}：${match.title}` };
}

// ── what the page has learned ──
const answers = new Map<string, RefAnswer>();
const failed = new Set<string>();
const inflight = new Set<string>();
const queued = new Map<string, Set<string>>();
let version = 0;
let pageKey = "";
let pageAsked = 0;
const listeners = new Set<() => void>();
const slot = (projectId: string, key: string) => `${projectId}\n${key}`;
const emit = () => { version++; for (const listener of listeners) listener(); };

function currentPage(): string { return typeof location === "undefined" ? "" : location.pathname; }

async function flush(projectId: string) {
  const keys = [...(queued.get(projectId) ?? [])];
  queued.delete(projectId);
  if (!keys.length) return;
  for (const key of keys) inflight.add(slot(projectId, key));
  try {
    const read = await api().jumpRefs(projectId, keys);
    for (const key of keys) {
      const found = read.results[key];
      answers.set(slot(projectId, key), !found || found.matches.length === 0 ? { kind: "none" }
        : found.matches.length === 1 && !found.truncated ? { kind: "one", match: found.matches[0]! } : { kind: "many" });
    }
  } catch { for (const key of keys) failed.add(slot(projectId, key)); }
  for (const key of keys) inflight.delete(slot(projectId, key));
  emit();
}

/** Ask about candidates a text holds: those not answered yet, within this page's 50, are read together a moment later. */
export function askRefs(projectId: string, keys: readonly string[]): void {
  if (currentPage() !== pageKey) { pageKey = currentPage(); pageAsked = 0; failed.clear(); }
  const fresh: string[] = [];
  for (const key of keys) {
    const id = slot(projectId, key);
    if (answers.has(id) || failed.has(id) || inflight.has(id) || queued.get(projectId)?.has(key)) continue;
    if (pageAsked + fresh.length >= jumpBatchLimit) break;
    fresh.push(key);
  }
  if (!fresh.length) return;
  pageAsked += fresh.length;
  const set = queued.get(projectId) ?? new Set<string>();
  const first = set.size === 0;
  for (const key of fresh) set.add(key);
  queued.set(projectId, set);
  if (first) setTimeout(() => void flush(projectId), 60);
}

export function answerOf(projectId: string, key: string): RefAnswer | undefined { return answers.get(slot(projectId, key)); }
export function resetRefLinks() { answers.clear(); failed.clear(); inflight.clear(); queued.clear(); pageKey = ""; pageAsked = 0; emit(); }

/** The answers a text's candidates have so far; re-renders when more arrive. Text with no candidate asks nothing. */
export function useRefAnswers(projectId: string | undefined, keys: readonly string[], enabled = true): (key: string) => RefAnswer | undefined {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  const joined = keys.join("\n");
  useEffect(() => { if (projectId && enabled && joined) askRefs(projectId, joined.split("\n")); }, [projectId, enabled, joined]);
  return key => projectId && enabled ? answers.get(slot(projectId, key)) : undefined;
}

/** Candidates of a plain text (no Markdown): those inside a ``` fence or between single backticks are code and are skipped. */
export function plainRefHits(text: string): RefHit[] {
  const code: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) code.push([match.index!, match.index! + match[0].length]);
  return refHits(text).filter(hit => !code.some(([from, to]) => hit.index >= from && hit.index < to));
}
