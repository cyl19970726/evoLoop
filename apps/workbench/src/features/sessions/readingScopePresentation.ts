// What “消息怎样处理与读取范围” says about the limits of a conversation read. The service writes these limitations for
// agents and logs, mostly in English (`Native history is unsupported for this Session`), sometimes in Chinese that still
// names implementation objects (“原生 Item”“原生 Turn”). The reader sees Chinese without implementation words
// (docs/frontend/principles.md 界面用语): a known limitation is said in words; one written wholly in Chinese is kept; any
// other, including Chinese mixed with English words, gets a general sentence. Every original that was replaced stays
// available as 原文 (the same way shared/errorPresentation.ts keeps a failure's original answer as 诊断信息).

const chinese = /[㐀-鿿]/;
/** An English word inside the text: such a text is not kept as written, even when it also has Chinese. */
const latinWord = /[A-Za-z]{2,}/;

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
  // Chinese the service writes with implementation words (session-timeline/index.ts, input binding proofs).
  [/^已接受的即时补充尚未核实唯一原生\s*Item/i, "已接受的即时补充还没核实到唯一对应的原始记录，补充本身的记录照常保留"],
  [/^同一原生\s*Turn\s*有多个精确匹配的输入\s*Item/i, "同一轮里有多条内容完全相同的输入，无法核实是谁发出的"],
  [/^未能在有界的完整已终结\s*Turn\s*中核实唯一输入\s*Item/i, "在已读取的已结束轮次里没有核实到唯一对应的输入，业务消息仍可单独读取"],
];
/** Said for a limitation the page cannot say in its own words; the original stays in 原文. */
export const unknownLimitation = "来源还说明了一项读取限制（原文未翻译，可展开“原文”查看）";

const trimmed = (value: string) => value.trim().replace(/[。．.；;，,\s]+$/u, "");

/** One limitation in Chinese, without a closing period; `original` is the service wording it replaced, if any. */
export function describeLimitation(raw: string): { text: string; original: string | null } {
  const value = trimmed(raw);
  if (!value) return { text: "", original: null };
  const match = known.find(([pattern]) => pattern.test(value));
  if (match) return { text: match[1], original: value };
  if (chinese.test(value) && !latinWord.test(value)) return { text: value, original: null };
  return { text: unknownLimitation, original: value };
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
