import type { ShellNoticeItem } from "./shell/AppShell";

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
