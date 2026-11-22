// How a long text is shown in the chat: a reply the source cut short is folded back to the last whole block (never inside a
// code fence or a table), and a long message a person sent is folded after a few lines. Pure, tested without React (long-text.test.ts).

const fenceLine = /^ {0,3}(`{3,}|~{3,})/;
const tableLine = /^\s*\|.*\|?\s*$/;

/** Lines that open or close a fenced block, so a cut can tell whether it falls inside one. */
function insideFenceAt(lines: string[], end: number): boolean {
  let open: string | null = null;
  for (let index = 0; index < end; index++) {
    const mark = fenceLine.exec(lines[index]!)?.[1];
    if (!mark) continue;
    if (open === null) open = mark;
    else if (mark[0] === open[0] && mark.length >= open.length) open = null;
  }
  return open !== null;
}

/**
 * A reply the source cut short (the end is not the agent's end). Keep whole blocks only: cut back to the blank line before the
 * last block, and further back when that falls inside a code fence. The last block is dropped even when it looks whole, because
 * the cut may have been inside it (a table row, a half sentence). A text of one block is kept as it is.
 */
export function foldAtBlock(body: string): { shown: string; folded: boolean } {
  const lines = body.split("\n");
  // the last blank line that is not inside a fence, with some text before it
  let cut = -1;
  for (let index = lines.length - 1; index > 0; index--) {
    if (lines[index]!.trim() !== "" || insideFenceAt(lines, index)) continue;
    if (lines.slice(0, index).some(line => line.trim() !== "")) { cut = index; break; }
  }
  if (cut < 0) return { shown: body, folded: false };
  // a table that would end the shown text is kept only when its separator row is there; a bare header row is dropped with it
  let shown = lines.slice(0, cut);
  while (shown.length && shown[shown.length - 1]!.trim() === "") shown.pop();
  const tail = [];
  for (let index = shown.length - 1; index >= 0 && tableLine.test(shown[index]!) && shown[index]!.trim() !== ""; index--) tail.unshift(shown[index]!);
  if (tail.length === 1) shown = shown.slice(0, shown.length - 1);
  while (shown.length && shown[shown.length - 1]!.trim() === "") shown.pop();
  return shown.length ? { shown: shown.join("\n"), folded: true } : { shown: body, folded: false };
}

export interface FoldedMessage { head: string; hiddenLines: number; folded: boolean }
export const messageFoldLines = 12;
export const messageFoldChars = 900;

/** A message a person sent: the first lines, or the first characters when one line is very long; never ends inside a fence. */
export function foldMessage(text: string, maxLines = messageFoldLines, maxChars = messageFoldChars): FoldedMessage {
  const lines = text.split("\n");
  let used = 0, end = 0;
  while (end < lines.length && end < maxLines && used + lines[end]!.length <= maxChars) { used += lines[end]!.length + 1; end++; }
  if (end >= lines.length) return { head: text, hiddenLines: 0, folded: false };
  if (end === 0) return { head: `${lines[0]!.slice(0, maxChars)}`, hiddenLines: lines.length - 1, folded: true };
  if (insideFenceAt(lines, end)) {
    // pull the cut back to before the fence that is still open, so a half code block is not shown
    let open = end;
    while (open > 0 && insideFenceAt(lines, open)) open--;
    if (open > 0) end = open;
  }
  const head = lines.slice(0, end).join("\n");
  return { head: insideFenceAt(lines, end) ? `${head}\n\`\`\`` : head, hiddenLines: lines.length - end, folded: true };
}

export type MessageSegment = { kind: "text" | "code"; value: string };
/** Split a message into plain text and fenced code, for drawing the fence as code and the rest as wrapped text. */
export function messageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const out: MessageSegment[] = [];
  let current: string[] = [], open: string | null = null;
  const flush = (kind: "text" | "code") => { if (current.length) out.push({ kind, value: current.join("\n") }); current = []; };
  for (const line of lines) {
    const mark = fenceLine.exec(line)?.[1];
    if (open === null && mark) { flush("text"); open = mark; continue; }
    if (open !== null && mark && mark[0] === open[0] && mark.length >= open.length) { flush("code"); open = null; continue; }
    current.push(line);
  }
  flush(open === null ? "text" : "code");
  return out;
}
