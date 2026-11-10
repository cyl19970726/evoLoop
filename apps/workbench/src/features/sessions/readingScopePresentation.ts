// What “消息怎样处理与读取范围” says about the limits of a conversation read. The service writes these limitations for
// agents and logs, mostly in English (`Native history is unsupported for this Session`). The reader sees Chinese
// (docs/frontend/principles.md 界面用语): a known limitation is said in words, one already written in Chinese is kept,
// and any other gets a general sentence. Every original that was replaced stays available as 原文 (the same way
// shared/errorPresentation.ts keeps a failure's original answer as 诊断信息).

const chinese = /[㐀-鿿]/;

/** Known service wordings (apps/coordinator/src/session-timeline, packages/adapter-codex-app-server), first match wins. */
const known: ReadonlyArray<readonly [RegExp, string]> = [
  [/^native history is unsupported for this session$/i, "这个智能体的来源不提供原有历史，这里只显示经 evoLoop 保存的消息"],
  [/^native history unavailable(?: or unsupported)?$/i, "原有历史这次没有读到，已显示的内容可能不完整"],
  [/^manual handoff records do not prove native delivery or reading$/i, "人工转交的记录只说明消息已保存，不能证明原聊天已收到或已读"],
  [/^live native updates unavailable$/i, "这个智能体没有实时活动来源，新的活动要重新读取才会出现"],
  [/^native connection is unavailable$/i, "与运行环境的连接暂不可用，实时活动可能缺失"],
  [/^native connection disconnected$/i, "与运行环境的连接中断过，之前的实时活动已标为上次观察"],
  [/^(?:owner connection changed|connection generation changed)$/i, "运行环境的连接已更换，之前的实时活动已标为上次观察"],
  [/^no scoped native update has been observed for this thread$/i, "还没有收到这个对话的实时活动"],
  [/^live updates are bounded to this service process$/i, "实时活动只保留在当前服务进程内，服务重启后以历史记录为准"],
  [/^turn metadata unavailable for requested items$/i, "部分活动缺少所属轮次的信息"],
  [/^turn metadata outside bounded (?:scan|page)\b/i, "部分活动的所属轮次超出本次读取范围"],
  [/^realtime timeline entries have no turn association$/i, "部分实时内容没有所属轮次，暂未显示"],
];
/** Said for a limitation in a language the page does not know; the original stays in 原文. */
export const unknownLimitation = "来源还说明了一项读取限制（原文为英文，可展开查看）";

const trimmed = (value: string) => value.trim().replace(/[。．.；;，,\s]+$/u, "");

/** One limitation in Chinese, without a closing period; `original` is the service wording it replaced, if any. */
export function describeLimitation(raw: string): { text: string; original: string | null } {
  const value = trimmed(raw);
  if (!value) return { text: "", original: null };
  if (chinese.test(value)) return { text: value, original: null };
  const match = known.find(([pattern]) => pattern.test(value));
  return { text: match ? match[1] : unknownLimitation, original: value };
}

/** Lines for a list of limitations: each Chinese sentence once, and every replaced original once for 原文. */
export function describeLimitations(raw: readonly string[]): { lines: string[]; originals: string[] } {
  const lines: string[] = [], originals: string[] = [];
  for (const item of raw) {
    const { text, original } = describeLimitation(item);
    if (text && !lines.includes(text)) lines.push(text);
    if (original && !originals.includes(original)) originals.push(original);
  }
  return { lines, originals };
}
