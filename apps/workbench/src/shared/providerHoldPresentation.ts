// The words and decisions behind "运行受阻" (provider holds): the one line above every page, its target, and the facts 待我处理 lists. Pure, shared by the shell
// bar (app/shell/ProviderHoldBar.tsx) and the 待我处理 page and count (features/workflow), tested without React (provider-hold-notice.test.ts).
import type { ProviderHoldListing } from "@evoloop/contracts/provider-hold";

const providerName = { codex: "Codex", claude: "Claude" } as const;
const causeText = (category: string) => category === "authentication_failed" ? "鉴权失败" : "额度用完";

/** One held provider, as the banner and 待我处理 both tell it. */
export interface HeldProvider {
  id: string; provider: "codex" | "claude"; version: number; category: string; queuedMessages: number;
  /** The Sessions this hold stops now: a Turn blocked by the failure, or messages waiting behind it. */
  sessionIds: string[];
}
/** What is held right now: the holds, and the distinct affected Sessions across them (a Session under two holds counts once). */
export interface HoldSummary { holds: HeldProvider[]; sessionIds: string[]; queuedMessages: number }

/** Null when nothing is held or the list was not read yet: an unread state is never shown as "nothing is held". */
export function holdSummary(listing: ProviderHoldListing | undefined): HoldSummary | null {
  const holds = (listing?.items ?? []).filter(hold => hold.state === "held").map((hold): HeldProvider => ({
    id: hold.id, provider: hold.provider, version: hold.version, category: hold.category, queuedMessages: hold.queuedMessages,
    sessionIds: hold.impact.filter(item => item.blockedByQuotaFailure || item.queuedMessages > 0).map(item => item.sessionId),
  }));
  if (!holds.length) return null;
  return { holds, sessionIds: [...new Set(holds.flatMap(hold => hold.sessionIds))], queuedMessages: holds.reduce((sum, hold) => sum + hold.queuedMessages, 0) };
}

/**
 * The one line above every page: what stopped, who is stopped, what the person has to do. No command name, hold number or version here
 * (those are the source layer, holdIdentifiers). `firstName` is the name of the first affected Session when the page knows it.
 */
export function holdLine(summary: HoldSummary, firstName?: string | null): string {
  const causes = summary.holds.map(hold => `${providerName[hold.provider]} ${causeText(hold.category)}`).join("、");
  const count = summary.sessionIds.length;
  const who = count === 0 ? "新的运行已暂停" : count === 1 ? `${firstName ? `${firstName} ` : "1 个智能体"}停着` : `${firstName ? `${firstName} 等` : ""} ${count} 个智能体停着`.trim();
  return `模型服务 ${causes}，${who}：需要你充值或重新授权`;
}

/** Where "去处理" goes: the one affected Session itself, else 待我处理, whose runtime-problem section lists exactly the Sessions the line counts. */
export function holdTarget(projectId: string, summary: HoldSummary): string {
  return summary.sessionIds.length === 1 ? `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${summary.sessionIds[0]}`)}` : `/p/${projectId}/inbox`;
}

/** The page being read is an affected agent's own page: only there the line turns into the red prompt. */
export function holdIsHere(summary: HoldSummary, route: { section: string; session?: string | undefined }): boolean {
  return route.section === "sessions" && !!route.session && summary.sessionIds.some(id => route.session === `owned:${id}`);
}

/** The source layer: hold number, version and the release command, for the CLI and for checking. */
export function holdIdentifiers(summary: HoldSummary): Array<{ label: string; value: string; text?: boolean }> {
  return summary.holds.flatMap(hold => [
    { label: `${providerName[hold.provider]} 暂停编号`, value: hold.id },
    { label: `${providerName[hold.provider]} 版本`, value: String(hold.version), text: true },
  ]).concat([{ label: "放行命令", value: "runtime.providerHold.release", text: true }]);
}

/** Each hold told in full, for the expanded bar and the 待我处理 section. */
export function holdFacts(hold: HeldProvider): string {
  return `${providerName[hold.provider]} ${causeText(hold.category)}，已暂停它的新 Turn；${hold.sessionIds.length} 个智能体受影响，${hold.queuedMessages} 条消息排队等待（新消息照常保存）。需账户使用者处理（充值或重新授权），处理后由复核者一次放行。`;
}
