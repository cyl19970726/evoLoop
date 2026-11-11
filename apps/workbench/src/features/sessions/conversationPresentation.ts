// The words of the agent page's conversation flow. The native source describes tools, plans and notices in English
// for the agent (“Read file src/a.ts”, “Plan”, “Context compacted”); the page says the same thing in Chinese and
// only claims what the entries prove. Pure functions, tested in session-conversation-presentation.test.ts.
import type { SessionResult } from "@evoloop/contracts/session-observation";
import type { WorkspaceAuthor, WorkspaceEntry, WorkspaceRecord, WorkspaceState, WorkspaceTool, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import { actorText } from "../../shared/actorPresentation";

/**
 * Who wrote an entry, as the page says it. The service labels a person by their actor ID and an agent by its own
 * title: a person is said as every page says who recorded something (actorText: an account name, 未登记名称的身份,
 * 自动执行方), an agent by the name the page gives it (`agentName`, agentDisplayName), never by a generated title.
 */
export function entryAuthorText(author: WorkspaceAuthor, agentName: string, me?: string): string {
  if (author.kind === "actor") return actorText(author.id ?? author.label, me);
  if (author.kind === "session") return agentName;
  return author.label.trim() || "发送者未确认";
}

export const entryStateLabel: Record<WorkspaceState, string> = {
  pending: "待处理", running: "进行中", completed: "已完成", failed: "失败", interrupted: "已中断", declined: "已拒绝", unknown: "状态未确认",
};
const failedStates: readonly WorkspaceState[] = ["failed", "interrupted", "declined"];
export const isFailedEntry = (entry: { state: WorkspaceState }) => failedStates.includes(entry.state);

const toolNames: Record<string, string> = {
  Command: "执行命令", "Read file": "读取文件", "List files": "列出文件", Search: "搜索", "Web search": "网页搜索",
  "File change": "修改文件", "Agent collaboration": "智能体协作", "Tool result": "工具结果", Tool: "工具",
};
/** A tool's name in Chinese; names the native source does not translate (an MCP server/tool) stay as they are. */
export function toolLabel(name: string): string {
  return toolNames[name] ?? name;
}

/** One step's line: what the tool did, in Chinese, with paths and MCP names kept as they are. */
export function toolStepText(entry: Pick<WorkspaceTool, "name" | "summary" | "nativeKind">): string {
  const summary = entry.summary.trim();
  const rewrite: Array<[RegExp, (rest: string) => string]> = [
    [/^Read file\s*(.*)$/, rest => rest ? `读取 ${rest}` : "读取文件"],
    [/^List files(?: in)?\s*(.*)$/, rest => rest ? `列出 ${rest}` : "列出文件"],
    [/^Search(?: in)?\s*(.*)$/, rest => rest ? `搜索 ${rest}` : "搜索"],
    [/^Changed\s+(.*)$/, rest => `修改 ${rest}`],
  ];
  if (!summary || summary === entry.name) return toolLabel(entry.name);
  // A command made of several actions is listed as “Read file a, Search in b”.
  const parts = summary.split(/,\s(?=Read file|List files|Search|Command)/);
  const words = parts.map(part => {
    for (const [pattern, say] of rewrite) { const match = pattern.exec(part.trim()); if (match) return say(match[1] ?? ""); }
    return toolNames[part.trim()] ?? part.trim();
  });
  // A tool of no known kind (a project or MCP tool) keeps its own name in front of what it reports.
  return toolKind(entry) === "other" && !toolNames[entry.name] ? `${entry.name}：${words.join("，")}` : words.join("，");
}

type ToolKind = "command" | "read" | "list" | "search" | "change" | "web" | "other";
function toolKind(entry: Pick<WorkspaceTool, "name" | "nativeKind">): ToolKind {
  if (entry.name === "Read file") return "read";
  if (entry.name === "List files") return "list";
  if (entry.name === "Search") return "search";
  if (entry.nativeKind === "fileChange" || entry.name === "File change") return "change";
  if (entry.nativeKind === "webSearch" || entry.name === "Web search") return "web";
  if (entry.nativeKind === "commandExecution" || entry.name === "Command") return "command";
  return "other";
}
const kindPhrase: Record<ToolKind, (count: number) => string> = {
  command: count => `执行了 ${count} 个指令`, read: count => `读了 ${count} 个文件`, list: count => `列出 ${count} 次目录`,
  search: count => `搜索 ${count} 次`, change: count => `改了 ${count} 处文件`, web: count => `网页搜索 ${count} 次`,
  other: count => `调用 ${count} 次其他工具`,
};

/** The one muted line a folded tool group shows, for example 执行了 5 个指令、读了 3 个文件. */
export function toolGroupSummary(entries: readonly Pick<WorkspaceTool, "name" | "nativeKind">[]): string {
  const counts = new Map<ToolKind, number>();
  for (const entry of entries) counts.set(toolKind(entry), (counts.get(toolKind(entry)) ?? 0) + 1);
  const order: ToolKind[] = ["command", "read", "list", "search", "change", "web", "other"];
  return order.filter(kind => counts.has(kind)).map(kind => kindPhrase[kind](counts.get(kind)!)).join("、") || "没有工具活动";
}

/** After the summary: still running (only when the connection is live) and failures. */
export function toolGroupStatus(entries: readonly Pick<WorkspaceTool, "state" | "freshness">[]): string {
  const running = entries.some(entry => entry.state === "running" && entry.freshness === "live");
  const unconfirmed = entries.some(entry => entry.state === "running" && entry.freshness !== "live");
  const failures = entries.filter(isFailedEntry).length;
  return [running && "，正在进行", unconfirmed && "，上次进行中的一项当前待核对", failures > 0 && `，${failures} 项失败或中断`].filter(Boolean).join("");
}

/** A step's state on the right of its row; a running step from an older read is not presented as running. */
export function toolStepState(entry: Pick<WorkspaceTool, "state" | "freshness" | "durationMs">): string {
  const state = entry.state === "running" && entry.freshness !== "live" ? "上次进行中，当前待核对" : entryStateLabel[entry.state];
  return entry.durationMs !== null ? `${state} · ${Math.round(entry.durationMs) / 1000} 秒` : state;
}

/** Folded, a group keeps in sight what must not be folded: every failure, the step running now, the step being read. */
export function pinnedToolIds(entries: readonly Pick<WorkspaceTool, "id" | "state" | "freshness">[], selectedId: string | null = null): Set<string> {
  const pinned = new Set(entries.filter(isFailedEntry).map(entry => entry.id));
  const running = [...entries].reverse().find(entry => entry.state === "running" && entry.freshness === "live");
  if (running) pinned.add(running.id);
  if (selectedId && entries.some(entry => entry.id === selectedId)) pinned.add(selectedId);
  return pinned;
}

const noticeLabels: Record<string, string> = {
  Plan: "执行计划", Image: "图片", "Image generation": "生成图片", "Subagent activity": "子智能体活动", Wait: "等待",
  "Context compacted": "上下文已压缩", "Review started": "开始审查", "Review ended": "审查结束", "Unsupported native item": "暂不支持显示的原生条目",
};
/** A record's heading (a plan, a notice from the native source) in Chinese. */
export function recordLabel(label: string): string {
  return noticeLabels[label] ?? label;
}

const detailReasons: Record<string, string> = {
  "Native source did not provide original tool evidence.": "来源没有提供原始工具详情。",
  "Original detail is unsupported for this native tool kind.": "这类工具暂不支持读取原始详情。",
};
export function toolDetailReason(reason: string | null): string {
  return reason ? detailReasons[reason] ?? "来源没有提供原始工具详情。" : "来源没有提供原始工具详情。";
}

export type TodoStatus = "done" | "active" | "todo";
/** The structured plan the native source writes as “1. [inProgress] 步骤”: its steps, or null when the body is not one. */
export function planSteps(body: string): Array<{ text: string; status: TodoStatus }> | null {
  const steps: Array<{ text: string; status: TodoStatus }> = [];
  for (const line of body.split("\n")) {
    const match = /^\d+\.\s\[(pending|inProgress|completed|unknown)\]\s(.+)$/.exec(line.trim());
    if (match) steps.push({ text: match[2]!, status: match[1] === "completed" ? "done" : match[1] === "inProgress" ? "active" : "todo" });
  }
  return steps.length ? steps : null;
}
/** The explanation above a plan's steps, if any. */
export function planExplanation(body: string): string {
  return body.split("\n").filter(line => !/^\d+\.\s\[(pending|inProgress|completed|unknown)\]\s/.test(line.trim())).join("\n").trim();
}

/** The latest plan entry of the given Turn, for the checklist above the composer. */
export function latestPlan(entries: readonly WorkspaceEntry[], turnId: string | null): WorkspaceRecord | null {
  const plans = entries.filter((entry): entry is WorkspaceRecord => entry.kind === "plan" && (!turnId || entry.turnId === turnId));
  return plans.at(-1) ?? null;
}

/** 1 分 04 秒, 45 秒, 2 小时 3 分; unknown or negative time says nothing. */
export function elapsedText(startedAt: string | null, now: number): string | null {
  if (!startedAt) return null;
  const seconds = Math.floor((now - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** The live status line: what the running turn does now, from its running tool or its latest public text. */
export function liveStatusText(currentTool: Pick<WorkspaceTool, "name" | "summary" | "nativeKind"> | null, replying: boolean): string {
  if (!currentTool) return replying ? "正在回复" : "正在处理";
  const kind = toolKind(currentTool);
  if (kind === "other") return `正在使用 ${toolLabel(currentTool.name)}`;
  if (kind === "command" && currentTool.name !== "Command") return `正在执行 ${currentTool.name}`;
  return `正在${toolStepText(currentTool)}`;
}

export interface TurnSummaryLine { produced: string; delivered?: string; next?: string }

/**
 * The line that closes a finished turn: what its tools did, a delivery the records tie to its task within the turn,
 * and who moves next when the records say so (a failure, an interruption, an unanswered question). Nothing is
 * claimed for a turn still running or of unknown outcome. Keyed by the id of the turn's last entry.
 */
export function turnSummaries(entries: readonly WorkspaceEntry[], turns: readonly WorkspaceTurn[], results: readonly SessionResult[],
  waitingTurnIds: ReadonlySet<string> = new Set()): Map<string, TurnSummaryLine> {
  const lines = new Map<string, TurnSummaryLine>();
  for (const turn of turns) {
    if (!["completed", "failed", "interrupted"].includes(turn.state)) continue;
    const own = entries.filter(entry => entry.turnId === turn.id);
    const last = own.at(-1);
    if (!last) continue;
    const tools = own.filter((entry): entry is WorkspaceTool => entry.kind === "tool");
    const failures = tools.filter(isFailedEntry).length;
    const produced = tools.length ? `${toolGroupSummary(tools)}${failures ? `，${failures} 项失败或中断` : ""}` : "没有工具活动";
    const taskId = turn.origin?.taskId ?? null;
    // A delivery belongs to this turn only when it was submitted between the turn's start and its end; without both
    // times nothing is claimed (every turn of a task would otherwise "deliver" its latest result).
    const delivery = taskId && turn.startedAt && turn.completedAt
      ? results.filter(result => result.taskId === taskId && result.submittedAt >= turn.startedAt! && result.submittedAt <= turn.completedAt!)
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1)
      : undefined;
    const next = waitingTurnIds.has(turn.id) ? "下一步等你回答"
      : turn.state === "failed" ? "这一轮失败，等你核对"
        : turn.state === "interrupted" ? "这一轮已中断，等你决定是否继续"
          : delivery ? "下一步等验收者核对交付与使用" : undefined;
    lines.set(last.id, { produced, ...(delivery ? { delivered: `交付了「${delivery.taskTitle}」` } : {}), ...(next ? { next } : {}) });
  }
  return lines;
}

/** Token count for display; null stays unknown, never zero. */
const tokenCount = (value: number | null | undefined): string | null => typeof value === "number" ? value.toLocaleString("zh-CN") : null;
/** One Turn's reasoning tokens as the native source reported them. */
export function turnReasoningTokensText(usage: WorkspaceTurn["usage"]): string {
  if (!usage) return "推理 token：原生未报告";
  const reasoning = tokenCount(usage.reasoningOutputTokens), output = tokenCount(usage.outputTokens);
  const source = usage.source === "claude-result" ? "Claude 结果用量" : "Codex 用量事件";
  return `推理 token ${reasoning ?? "原生未报告"}${output ? ` / 输出 ${output}` : ""}（${source}）`;
}
/** A short, stable label for the Turn a reasoning group belongs to. */
export function turnLabel(turnId: string | null, startedAt: string | null | undefined): string {
  if (!turnId) return "回合未标明";
  const time = startedAt ? new Date(startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null;
  return `回合 ${turnId.slice(0, 8)}${time ? ` · ${time} 开始` : ""}`;
}
export const reasoningSourceLabel: Record<"summary" | "raw" | "thinking" | "none", string> = {
  summary: "推理摘要", raw: "原生推理文字", thinking: "思考内容", none: "不可显示",
};
