import type { ProviderHoldListing } from "@evoloop/contracts/provider-hold";
import type { ShellNoticeItem } from "./shell/AppShell";

const shortId = (id: string) => id.slice(0, 8);
/** Names of the affected Sessions as far as the page knows them; the identifier is the fallback, never nothing. */
const sessionList = (ids: string[], name?: (id: string) => string | null | undefined) => {
  const shown = ids.slice(0, 5).map(id => name?.(id) || `会话 ${shortId(id)}`).join("、");
  return ids.length > 5 ? `${shown} 等 ${ids.length} 个` : shown;
};

const providerName = { codex: "Codex", claude: "Claude" } as const;
const causeText = (category: string) => category === "authentication_failed" ? "鉴权失败" : "额度不足或欠费";

/**
 * One notice per held provider, above every page (总览、会话、待我处理 included): what stopped, who has to act, and how
 * much waits. Not read yet means no notice; an unread state is never shown as "nothing is held".
 */
export function providerHoldNotices(listing: ProviderHoldListing | undefined, sessionsHref: string,
  name?: (sessionId: string) => string | null | undefined): ShellNoticeItem[] {
  return (listing?.items ?? []).filter(hold => hold.state === "held").map(hold => {
    const affected = hold.impact.filter(item => item.blockedByQuotaFailure || item.queuedMessages > 0);
    return {
      key: `provider-hold:${hold.provider}`, tone: "error" as const,
      text: `运行受阻：模型服务 ${providerName[hold.provider]} ${causeText(hold.category)}，已暂停它的新 Turn。` +
        `${affected.length} 个会话受影响（${sessionList(affected.map(item => item.sessionId), name)}），${hold.queuedMessages} 条消息排队等待（新消息照常保存）。需账户使用者处理（充值或重新授权）；` +
        `处理后由复核者一次放行（命令 runtime.providerHold.release，暂停编号 ${hold.id}，版本 ${hold.version}）。`,
      link: { href: sessionsHref, label: "查看受影响的会话" },
    };
  });
}

/**
 * The hold list could not be read. That is never "nothing is paused": the notice says the state is unknown and why, with
 * the service's own failure told apart from a lost connection or a refusal.
 */
export function providerHoldReadFailure(error: unknown, sessionsHref: string): ShellNoticeItem {
  const status = error instanceof Error && typeof (error as { status?: unknown }).status === "number" ? (error as unknown as { status: number }).status : null;
  const why = status === 0 ? "连接中断或超时"
    : status !== null && status >= 500 ? `服务出错（HTTP ${status}）`
      : status === 401 || status === 403 ? `读取被拒绝（HTTP ${status}），请核对项目读取权限`
        : status !== null ? `读取没有完成（HTTP ${status}）` : "读取没有完成";
  return { key: "provider-holds-unread", tone: "waiting" as const,
    text: `暂时读不到“运行受阻”状态：${why}。这不表示没有暂停；请到会话页核对各会话是否被暂停。`,
    link: { href: sessionsHref, label: "到会话页核对" } };
}
