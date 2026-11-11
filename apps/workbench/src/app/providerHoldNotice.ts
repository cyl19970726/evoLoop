import type { ProviderHoldListing } from "@evoloop/contracts/provider-hold";
import type { ShellNoticeItem } from "./shell/AppShell";

const providerName = { codex: "Codex", claude: "Claude" } as const;
const causeText = (category: string) => category === "authentication_failed" ? "鉴权失败" : "额度不足或欠费";

/**
 * One notice per held provider, above every page (总览、会话、待我处理 included): what stopped, who has to act, and how
 * much waits. Not read yet means no notice; an unread state is never shown as "nothing is held".
 */
export function providerHoldNotices(listing: ProviderHoldListing | undefined, sessionsHref: string): ShellNoticeItem[] {
  return (listing?.items ?? []).filter(hold => hold.state === "held").map(hold => {
    const affected = hold.impact.filter(item => item.blockedByQuotaFailure || item.queuedMessages > 0);
    return {
      key: `provider-hold:${hold.provider}`, tone: "error" as const,
      text: `运行受阻：模型服务 ${providerName[hold.provider]} ${causeText(hold.category)}，已暂停它的新 Turn。` +
        `${affected.length} 个会话受影响，${hold.queuedMessages} 条消息排队等待（新消息照常保存）。需账户使用者处理（充值或重新授权）；` +
        `处理后由复核者一次放行（命令 runtime.providerHold.release，版本 ${hold.version}）。`,
      link: { href: sessionsHref, label: "查看受影响的会话" },
    };
  });
}
