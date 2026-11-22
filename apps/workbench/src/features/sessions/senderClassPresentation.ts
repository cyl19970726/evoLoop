// How the page names the class of a message's sender: the words follow what the receiving Session is told in the opening line of the message (apps/coordinator
// session-messages/sender.ts), so the page and the Session never say different things (Task bedd0ef3). A class this build does not know is shown as received.
const labels: Record<string, string> = {
  user: "使用者本人",
  leader: "统筹",
  requirements: "需求 Session",
  session: "其他受管 Session",
  system: "系统通知（不是人）",
  hub: "经 Hub 的身份（未记录类别，不是使用者）",
  service: "Hub 服务身份（不是使用者）",
  unknown: "未记录类别的身份（不是使用者）",
};

/** The class of a message's sender in words, or null when the service did not say (an older service). */
export function senderClassLabel(senderClass: string | null | undefined): string | null {
  if (!senderClass) return null;
  return Object.hasOwn(labels, senderClass) ? labels[senderClass]! : `未识别的类别（${senderClass}）`;
}
