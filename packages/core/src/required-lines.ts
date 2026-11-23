// 两条必写行改由代码拦截 (Task 3797cbdd): only that the line is there, written, and not 待定; never whether its content is good.
//  1. A delivery whose original is a report Document must carry “下次同类工作先要知道的事” (results.md): 无 counts as written.
//  2. A new Task or a saved schedule template must carry “关闭后下一步” (DEC-052, writing.md): 无 counts as written.
// Used where a person or an agent writes: the HTTP command entry (`/api/commands`) and the signed ordinary submission. A Task made by an
// existing schedule template when it falls due, and the Tasks the system itself creates, never pass through here.
import { DomainError, type Reader } from "@evoloop/contracts/ports";

export const NEXT_TIME_LABEL = "下次同类工作先要知道的事";
export const AFTER_CLOSE_LABEL = "关闭后下一步";
export const REPORT_LINE_CODE = "REPORT_NEXT_TIME_LINE_REQUIRED";
export const AFTER_CLOSE_LINE_CODE = "TASK_AFTER_CLOSE_LINE_REQUIRED";

export type LineState = "ok" | "missing" | "empty" | "pending";
const pendingText = /^(?:待定|tbd)[\s。.!！]*$/i;
const mark = String.raw`(?:\*\*|__)?`;

/** The state of the line named `label` in a Markdown `body`: a line (or heading, list item) that starts with the label, with the text on that line or on the lines under it. Fenced code is not read. */
export function lineState(body: string, label: string): LineState {
  const lines: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) lines.push(line);
  }
  const head = new RegExp(`^\\s*(?:#{1,6}\\s+|[-*+]\\s+|\\d+[.)]\\s+|>\\s*)?${mark}\\s*${label}\\s*${mark}\\s*[:：]?\\s*${mark}\\s*(.*)$`);
  let seen: LineState = "missing";
  for (let index = 0; index < lines.length; index++) {
    const found = head.exec(lines[index]!);
    if (!found) continue;
    let text = found[1]!.replace(/(?:\*\*|__)\s*$/, "").trim();
    if (!text) {
      // The text under the label, up to the next heading.
      for (let next = index + 1; next < lines.length; next++) {
        const line = lines[next]!.trim();
        if (/^#{1,6}\s/.test(line)) break;
        if (line) { text = line; break; }
      }
    }
    if (!text) { if (seen === "missing") seen = "empty"; continue; }
    if (pendingText.test(text)) { if (seen === "missing" || seen === "empty") seen = "pending"; continue; }
    return "ok";
  }
  return seen;
}

const why = (state: LineState) => state === "missing" ? "没有这一行" : state === "empty" ? "这一行是空的" : "这一行写的是“待定”";

/** A new Task or a schedule template body: refuses a missing, empty or 待定 “关闭后下一步”. */
export function assertAfterCloseLine(body: string, what: "Task 正文" | "日程模板的任务正文"): void {
  const state = lineState(body, AFTER_CLOSE_LABEL);
  if (state === "ok") return;
  throw new DomainError(AFTER_CLOSE_LINE_CODE,
    `${what}要写“${AFTER_CLOSE_LABEL}”一行（DEC-052，写法见 writing.md）：${why(state)}。写这个任务关闭后由谁、做什么；确实没有就写“无”，不能空着或写“待定”。`);
}

/**
 * A delivery whose `contentHash` is a saved report Document revision of this project (the report is the delivery's original, whatever
 * the artifact address is, a PR included) must have “下次同类工作先要知道的事” in it. A delivery whose hash is no report Document of this
 * project, a report kept only as an HTML original (no body to read) and a Reader that cannot look a hash up are not checked: this guard
 * only says what it read.
 */
export async function assertReportNextTimeLine(reader: Reader, contentHash: string): Promise<void> {
  const report = await reader.findReportRevisionByContentHash?.(contentHash.toLowerCase());
  if (!report || report.body === null) return;
  const state = lineState(report.body, NEXT_TIME_LABEL);
  if (state === "ok") return;
  throw new DomainError(REPORT_LINE_CODE,
    `交付报告（Document ${report.documentId} 修订 ${report.revisionId}）要写“${NEXT_TIME_LABEL}”一行（results.md）：${why(state)}。补上后保存新修订，再用新修订的 contentHash 交付；确实没有就写“无”，不能空着或写“待定”。`);
}

/** The commands this guard looks at, checked before they run. Anything else passes. */
export async function assertRequiredLines(reader: () => Promise<Reader> | Reader, command: { type: string; [key: string]: unknown }): Promise<void> {
  if (command.type === "task.create" && typeof command.content === "string") assertAfterCloseLine(command.content, "Task 正文");
  else if (command.type === "schedule.create" || (command.type === "schedule.revise" && command.state === "active")) {
    const template = command.template as { content?: unknown } | undefined;
    assertAfterCloseLine(typeof template?.content === "string" ? template.content : "", "日程模板的任务正文");
  } else if (command.type === "delivery.record" && typeof command.contentHash === "string")
    await assertReportNextTimeLine(await reader(), command.contentHash);
}
