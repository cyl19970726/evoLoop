// 正在做 and 接下来 at the top of the agent's right column (docs/frontend/pages/sessions.md 右栏). Pure functions, so the
// rules can be tested without a browser. What the agent works on now comes from its current Task (a resident-queue claim
// or an assignment on the Task's current revision), else from a Run that has not ended; what comes next comes, in this
// order, from its Session line (DEC-045), the resident execution queue, and open assignments not yet in either. A read
// that is running or failed is never shown as “空闲” or “没有排队”.
import type { ObservedSession, ObservedTask, SessionQueueItem, SessionResult, SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionLineEntry } from "@evoloop/contracts/session-line";
import type { LeaderWorkPhase } from "@evoloop/contracts/work-index";
import type { StatusTone } from "@evoloop/ui";
import { phaseStatus } from "../../shared/taskStatus";
import { queuePosition, queueStateLabel } from "./queuePresentation";
import { runStateLabel, sessionLifecycleLabel } from "./sessionStatusPresentation";

type Assignment = SessionSnapshot["assignments"][number];

/** How an agent stands with one assigned Task, for the 正在做 card and the 接下来 rows. */
export function assignmentLabel({ assignment, task, stale }: Assignment): string {
  if (task.state === "done" || task.state === "cancelled") {
    const outcome = task.state === "done" ? "任务已完成" : "任务已取消";
    const history = assignment.state === "accepted"
      ? assignment.ack?.method === "direct" ? "（曾直接确认接手）"
        : assignment.ack?.method === "lead-observed" ? "（曾由负责人观察接手）" : "（曾记录接手）"
      : assignment.state === "released" ? "（已释放）" : "（未确认接手）";
    return `${outcome} · 历史分派${history}`;
  }
  if (stale) return "任务修订已变化，需重新确认";
  if (assignment.state === "accepted") return `已接手（${assignment.ack?.method === "direct" ? "本人确认" : "负责人观察"}）`;
  return assignment.state === "assigned" ? "待确认" : "已释放";
}

const openTask = (task: Pick<ObservedTask, "state">) => task.state === "todo" || task.state === "in_progress";
const activeRunStates = new Set(["requested", "dispatching", "running", "unknown"]);
const stageTone: Record<string, StatusTone> = {
  running: "progress", run_reserved: "waiting", awaiting_run: "waiting", awaiting_ack: "waiting", awaiting_submission: "waiting",
  awaiting_delivery: "waiting", awaiting_acceptance: "waiting", awaiting_publication: "waiting", rework: "waiting", unassigned: "waiting",
  blocked: "blocked", closed: "done", cancelled: "history", unknown: "unknown",
};
const runTone: Record<string, StatusTone> = {
  requested: "waiting", dispatching: "progress", running: "progress", completed: "done", failed: "blocked", interrupted: "blocked", unknown: "unknown",
};

export interface NowTiming {
  status: "loading" | "failed" | "ready";
  /** The Task's current stage in words (timingStageLabel), when read. */
  stage?: string | undefined;
  /** The raw stage, for the tone. */
  stageKey?: string | undefined;
  /** “已历时 … · 等待 …”, or why it could not be read. */
  line?: string | undefined;
}

export interface NowView {
  /** Two to four characters for the status tag. */
  badge: string;
  tone: StatusTone;
  task: { id: string; title: string | null } | null;
  /** One sentence when there is no Task. */
  summary: string | null;
  /** How the Task was taken on, or why the Task is named without a claim or assignment. */
  lines: string[];
  /** The Task's stage time (“已历时 … · 等待 …”), or why it is not read yet. */
  timing: string | null;
  /** “有 N 个问题等你回答”, when any. */
  questions: string | null;
  /** The latest delivery shown beside 空闲, so “idle” still says what was last handed over. */
  recent: SessionResult | null;
}

/** What the agent is doing now. Every branch says something: a Task, a message, 空闲, or why it cannot be told. */
export function nowWork({ session, work, assignments, relationLabel, timing, messageRunning, idleResult, questionCount, titleOf }: {
  session: Pick<ObservedSession, "kind" | "runtimeState" | "busy" | "latestBusinessRun">;
  work: ObservedTask | null;
  assignments: Assignment[];
  /** currentWorkRelationLabel for `work`. */
  relationLabel: string | null;
  timing: NowTiming | null;
  messageRunning: boolean;
  idleResult: SessionResult | null;
  questionCount: number;
  titleOf: (taskId: string) => string | null;
}): NowView {
  const questions = questionCount > 0 ? `有 ${questionCount} 个问题等你回答` : null;
  const plain = { timing: null, questions };
  const run = session.latestBusinessRun ?? null;
  const notReady = session.kind === "owned" && session.runtimeState !== "ready";
  if (work) {
    const taskRun = run?.taskId === work.id ? run : null;
    const accepted = assignments.find(item => item.task.id === work.id && !item.stale && item.assignment.state !== "released");
    const relation = (work.relation === "accepted" || work.relation === "assigned") && accepted ? assignmentLabel(accepted) : relationLabel;
    const badge = notReady ? sessionLifecycleLabel(session) : timing?.status === "ready" && timing.stage ? timing.stage
      : taskRun ? runStateLabel(taskRun.state) : work.relation === "assigned" ? "待确认接手" : work.relation === "claimed" ? "已领取" : "已接手";
    const tone = notReady ? "unknown" : timing?.status === "ready" && timing.stageKey ? stageTone[timing.stageKey] ?? "unknown"
      : taskRun ? runTone[taskRun.state] ?? "unknown" : "waiting";
    return { badge, tone, task: { id: work.id, title: work.title }, summary: null, lines: relation ? [relation] : [], questions, recent: null,
      timing: !timing ? null : timing.status === "loading" ? "正在读取阶段时间…" : timing.line ?? null };
  }
  if (notReady) return { badge: sessionLifecycleLabel(session), tone: session.runtimeState === "closed" ? "history" : "unknown", task: null,
    summary: session.runtimeState === "closed" ? "这个智能体已关闭，不再接新任务。" : "智能体还没有就绪，当前工作待核对。", lines: [], ...plain, recent: null };
  // The native report of a message turn is exact; a Run record still marked running does not override it.
  if (session.busy === true && messageRunning)
    return { badge: "回复消息", tone: "progress", task: null, summary: "正在回复消息，这一轮不属于任何任务。", lines: [], ...plain, recent: null };
  // A Run that has not ended names its Task even when no claim or assignment does (a reserved Run, for instance).
  if (session.kind === "owned" && run && activeRunStates.has(run.state))
    return { badge: runStateLabel(run.state), tone: runTone[run.state] ?? "unknown", task: { id: run.taskId, title: titleOf(run.taskId) },
      summary: null, lines: ["有这项任务的运行记录；没有找到这个智能体的分派或领取，待核对。"], ...plain, recent: null };
  if (session.busy === true)
    return { badge: "在途工作", tone: "waiting", task: null, summary: "有在途的运行或消息，还没有对应到任务；可在分工与运行里核对。", lines: [], ...plain, recent: null };
  if (session.kind === "external") return { badge: "外部接入", tone: "unknown", task: null,
    summary: "外部智能体的当前工作没有同步到这里；分派给它的任务列在下面。", lines: [], ...plain, recent: null };
  if (session.busy === false) return { badge: "空闲", tone: "idle", task: null, summary: "没有正在做的任务或消息。", lines: [], ...plain, recent: idleResult };
  return { badge: "待核对", tone: "unknown", task: null, summary: "这个智能体是否在工作，暂时无法判断。", lines: [], ...plain, recent: null };
}

export type LineRead =
  | { status: "loading" }
  | { status: "failed"; message: string }
  /** The service has no Session lines (an older coordinator) or the agent is external: nothing to read. */
  | { status: "none"; reason: string }
  | { status: "ready"; entries: SessionLineEntry[] };

export interface NextItem {
  key: string;
  taskId: string;
  title: string | null;
  source: "line" | "queue" | "assignment";
  /** 1-based place in its own line or queue; null for an assignment, whose order nothing fixes. */
  order: number | null;
  /** Where it waits and in what state, e.g. “队伍第 2 位 · 排队中”. */
  caption: string;
  /** A state that needs attention (paused, needs confirming) gets a tag; plain waiting does not. */
  flag: { tone: StatusTone; label: string; detail?: string | undefined;
    /** The server's code and wording the detail replaced, shown only when opened. */
    source?: { code: string | null; original: string } | undefined } | null;
}

export interface NextView {
  items: NextItem[];
  /** Assignments the agent no longer acts on: delivered and waiting for acceptance, or the Task is done or cancelled. */
  ended: Array<{ item: Assignment; label: string }>;
  /** What to say when `items` is empty; null when there are items. Never “没有” while a read is missing. */
  empty: string | null;
  /** A read that is running or failed, said beside whatever was read. */
  note: string | null;
}

const lineStepLabel: Record<string, string> = { assign: "正在分派", confirm: "等它确认执行", start: "正在启动运行" };

// Why the line pump paused an entry. It stores `CODE: reason`, the reason in English (apps/coordinator/src/session-line/pump.ts);
// a refused step keeps the refusing command's code. People read a sentence; the code and the original stay one click away.
const lineSuspendCodes: Record<string, string> = {
  RECIPIENT_UNAVAILABLE: "找不到这个智能体签名用的业务身份，任务没法分派给它；要先给它登记执行身份",
  RETRY_LIMIT: "这一步多次被拒绝，已停止重试，等统筹处理",
  MESSAGE_MISSING: "执行确认的请求没有记录下来，等统筹处理",
  MESSAGE_UNDELIVERED: "执行确认的请求没有送达这个智能体",
  CONFIRMATION_TIMEOUT: "这个智能体没有按时确认执行",
  CONFIRMATION_STALE: "确认之后任务又改了，需要重新确认",
};
const chinese = /[㐀-鿿]/;
const latinWord = /[A-Za-z]{2,}/;
/** Said for a pause reason the page cannot put in its own words. */
export const untranslatedSuspendReason = "暂停原因是服务端的说明，未翻译（可展开“暂停代码与原文”查看）";

/** A pause reason in words; `code` and `original` are what it replaced (null when the reason was already plain Chinese). */
export function lineSuspendReason(raw: string | null | undefined): { text: string; code: string | null; original: string | null } {
  const value = (raw ?? "").trim();
  if (!value) return { text: "原因未记录", code: null, original: null };
  const coded = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/.exec(value);
  const code = coded?.[1] ?? null, rest = (coded?.[2] ?? value).trim();
  if (code && lineSuspendCodes[code]) return { text: lineSuspendCodes[code], code, original: value };
  if (chinese.test(rest) && !latinWord.test(rest)) return { text: rest, code, original: code ? value : null };
  return { text: untranslatedSuspendReason, code, original: value };
}

/** One Session line entry in words: its place and state, with a tag only for a paused or starting entry. */
export function lineEntryCaption(entry: Pick<SessionLineEntry, "state" | "step" | "suspendReason">, order: number): Pick<NextItem, "caption" | "flag"> {
  if (entry.state === "suspended") {
    const reason = lineSuspendReason(entry.suspendReason);
    return { caption: `队伍第 ${order} 位`, flag: { tone: "waiting", label: "已暂停", detail: reason.text,
      ...(reason.original ? { source: { code: reason.code, original: reason.original } } : {}) } };
  }
  if (entry.state === "starting") return { caption: `队伍第 ${order} 位`, flag: { tone: "progress", label: "正在开始", detail: lineStepLabel[entry.step ?? ""] ?? undefined } };
  if (entry.state === "queued") return { caption: `队伍第 ${order} 位 · 排队中`, flag: null };
  return { caption: `队伍第 ${order} 位 · 状态待核对（${entry.state}）`, flag: { tone: "unknown", label: "待核对" } };
}

/** What comes next, in a stated order: the Session line, then the execution queue, then assignments not in either. */
export function nextWork({ kind, currentTaskId, line, queue, assignments, partial, titleOf, phaseOf = () => null }: {
  kind: "owned" | "external";
  currentTaskId: string | null;
  line: LineRead;
  queue: SessionQueueItem[];
  assignments: Assignment[];
  /** The snapshot itself says it read only part of its sources. */
  partial: boolean;
  titleOf: (taskId: string) => string | null;
  /** The Task's phase in the Leader index (待验收, 待返工 …), when read; an assignment alone does not say whose move it is. */
  phaseOf?: (taskId: string) => LeaderWorkPhase | null;
}): NextView {
  const items: NextItem[] = [];
  const seen = new Set<string>(currentTaskId ? [currentTaskId] : []);
  if (line.status === "ready") {
    let order = 0;
    for (const entry of line.entries) {
      if (entry.state === "started" || entry.state === "withdrawn") continue;
      order += 1;
      if (seen.has(entry.taskId)) continue;
      seen.add(entry.taskId);
      items.push({ key: `line:${entry.id}`, taskId: entry.taskId, title: titleOf(entry.taskId), source: "line", order, ...lineEntryCaption(entry, order) });
    }
  }
  for (const item of [...queue].sort((a, b) => a.position - b.position)) {
    if (item.state === "released" || seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    const order = queuePosition(item.position);
    items.push({ key: `queue:${item.entryId}`, taskId: item.taskId, title: item.taskTitle || titleOf(item.taskId), source: "queue", order,
      caption: item.state === "held" ? `执行队列第 ${order} 位` : `执行队列第 ${order} 位 · ${queueStateLabel(item.state)}`,
      flag: item.state === "held" ? { tone: "waiting", label: "已暂停", detail: item.holdReason ?? undefined } : null });
  }
  const ended: NextView["ended"] = [];
  for (const item of assignments) {
    if (!openTask(item.task) || item.assignment.state === "released") { ended.push({ item, label: assignmentLabel(item) }); continue; }
    if (seen.has(item.task.id)) continue;
    seen.add(item.task.id);
    const phase = phaseOf(item.task.id);
    // Delivered and waiting for someone else's acceptance: the agent has nothing more to do on it.
    if (phase === "awaiting_acceptance" || phase === "closed" || phase === "cancelled") {
      ended.push({ item, label: phase === "awaiting_acceptance" ? "已交付，等验收" : phaseStatus[phase].label });
      continue;
    }
    items.push({ key: `assignment:${item.task.id}:${item.assignment.version}`, taskId: item.task.id, title: item.task.title, source: "assignment", order: null,
      // Only a line that was read can say the Task is not in it; while it is reading or failed, “已分派” is all that is known.
      caption: `${line.status === "ready" ? "已分派，未排进队伍" : "已分派"} · ${item.task.state === "in_progress" ? "任务进行中" : "任务待开始"}`,
      flag: item.stale ? { tone: "waiting", label: "需重新确认", detail: "任务修订已变化" }
        : phase && phase !== "running" ? { tone: phaseStatus[phase].tone, label: phaseStatus[phase].label }
          : item.assignment.state === "assigned" ? { tone: "waiting", label: "待确认接手" } : null });
  }
  const note = line.status === "loading" ? "正在读取智能体队伍…"
    : line.status === "failed" ? `智能体队伍暂不可读取：${line.message}。下面只有执行队列和分派，接下来做哪项不能完全确认。` : null;
  const empty = items.length ? null
    : line.status === "loading" ? "正在读取智能体队伍，读完前不能说没有排队的任务。"
      : line.status === "failed" ? "接下来做哪项暂时无法判断。"
        : kind === "external" ? "没有分派给它的任务；外部接入的智能体没有队伍。"
          : partial ? "已读范围内没有排队的任务；来源只读到部分记录。" : "没有排队的任务。";
  return { items, ended, empty, note };
}
