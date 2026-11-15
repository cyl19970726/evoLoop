// Where an event's real object can be read in the workbench, and what to say when it cannot be reached (DEC-045 F1, rework of observation a150a6e6).
// A link is given only where the workbench has a page for the object; where it has none, the detail says so in words instead of a generic link that
// lands somewhere else. Pure: routes in, labels and sentences out.
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { href } from "../../../shared/routes";
import { sessionHref } from "../SessionNavigation";
import { styleOf } from "./flowModel";

export interface OpenTarget { label: string; href: string }
export interface OpenInfo {
  targets: OpenTarget[];
  /** What the links do not say, in a sentence each (shown under the links). */
  notes: string[];
  /** The pull request an event is about. The scheduling event stream does not carry one, and the detail says so for the events where one would be expected. */
  pr: string | null;
}

export const PR_UNAVAILABLE = "读不到：调度事件流不含 PR";
export const DELIVERY_LOCATION = "交付记录在该任务的“交付与使用”页签";
export const MESSAGE_LOCATION = "这条消息在该 Session 对话中查看，没有单条消息页面";

const isDelivery = (event: SchedEvent) => event.subject.kind === "delivery" || event.kind === "task.delivered";
const isMessage = (event: SchedEvent) => event.subject.kind === "message" || event.kind.startsWith("message.");
/** Events where a pull request would be expected: a delivery and everything that accepts, reviews or closes one. */
const expectsPr = (event: SchedEvent) => isDelivery(event) || styleOf(event.kind).group === "accept" || event.kind === "task.done";

/** The 交付与使用 tab of a Task, at one Delivery (the tab scrolls to and marks the delivery whose id is in `delivery`). */
export const deliveryHref = (projectId: string, taskId: string, deliveryId?: string): string =>
  `${href(projectId, "task", taskId)}?${new URLSearchParams({ tab: "delivery", ...(deliveryId ? { delivery: deliveryId } : {}) })}`;

export function openInfoOf(projectId: string, event: SchedEvent): OpenInfo {
  const targets: OpenTarget[] = [], notes: string[] = [];
  const session = event.sessionId ? sessionHref(projectId, `owned:${event.sessionId}`) : null;
  if (isDelivery(event)) {
    if (event.taskId) {
      targets.push({ label: "打开交付", href: deliveryHref(projectId, event.taskId, event.subject.kind === "delivery" ? event.subject.id : undefined) });
      notes.push(`${DELIVERY_LOCATION}，打开后定位到这次交付。`);
    } else notes.push(`${DELIVERY_LOCATION}；这条事件没有带任务，无法直达。`);
  } else if (event.taskId) targets.push({ label: "打开任务", href: href(projectId, "task", event.taskId) });
  if (isMessage(event)) {
    if (session) targets.push({ label: "打开该 Session 的对话", href: session });
    notes.push(session ? `${MESSAGE_LOCATION}。` : `${MESSAGE_LOCATION}；这条事件没有带 Session，读不到是哪个对话。`);
  } else if (session) targets.push({ label: "打开 Session", href: session });
  return { targets, notes, pr: expectsPr(event) ? PR_UNAVAILABLE : null };
}

// ---- nodes (rework for observation d8ffc398): every node the page shows opens a real object, or says why it cannot ----
import type { WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import { STATIONS, stationCounts, type NodeId } from "./flowModel";

export interface NodeInfo {
  /** What the node is, in a few words. */
  title: string;
  /** Facts the board gives for it. */
  lines: string[];
  /** Real pages it opens. */
  targets: OpenTarget[];
  /** "读不到：……" sentences, each with its reason: what the page cannot open and why. Never empty when `targets` is. */
  notes: string[];
}

export const NODE_UNAVAILABLE = "读不到：";
export const STATION_PREFIX = "station:";
export const stationNode = (station: string): NodeId => `${STATION_PREFIX}${station}` as NodeId;

/**
 * The object a node stands for. A Session node opens its Session and the Tasks on it; the Leader opens its Session when the page knows which it is; 日程 and the tasks
 * list are real pages. The rest stand for a kind of source or a count, not for one object the workbench can open: each says so, and why, in a "读不到：……" sentence.
 */
export function nodeInfoOf(projectId: string, node: NodeId, board: WorkBoardSnapshot, leaderSessionId: string | null, windowHours?: number): NodeInfo {
  const targets: OpenTarget[] = [], notes: string[] = [], lines: string[] = [];
  const tasks = href(projectId, "work");
  if (node.startsWith("session:")) {
    const id = node.slice("session:".length), s = board.sessions.find(x => x.sessionId === id);
    if (!s) return { title: "Session", lines, targets, notes: [`${NODE_UNAVAILABLE}调度板快照里没有这个 Session（它可能已关闭或不在这个项目里），打不开它的对话。`] };
    targets.push({ label: "打开 Session", href: sessionHref(projectId, `owned:${id}`) });
    lines.push(`${s.roleTitle ?? s.roleId}；状态 ${s.state}；排队消息 ${s.queuedMessages} 条`);
    if (s.current?.taskId) targets.push({ label: `打开正在做的任务${s.current.taskTitle ? `《${s.current.taskTitle}》` : ""}`, href: href(projectId, "task", s.current.taskId) });
    else if (s.current) notes.push(`${NODE_UNAVAILABLE}正在做的是一条${s.current.kind === "message" ? "消息" : "即时输入"}的一轮，没有对应的任务，打不开任务页；它的内容在这个 Session 的对话里。`);
    else notes.push("现在没有正在做的事，没有可打开的当前任务。");
    for (const q of s.queue.slice(0, 3)) targets.push({ label: `打开队伍里的任务${q.taskTitle ? `《${q.taskTitle}》` : ""}`, href: href(projectId, "task", q.taskId) });
    if (s.queue.length > 3) notes.push(`队伍里另有 ${s.queue.length - 3} 项，在这个 Session 的页面里看。`);
    return { title: s.roleTitle ?? "Session", lines, targets, notes };
  }
  switch (node) {
    case "leader":
      if (leaderSessionId) targets.push({ label: "打开 Leader 的 Session", href: sessionHref(projectId, `owned:${leaderSessionId}`) });
      else notes.push(`${NODE_UNAVAILABLE}页面没有拿到 Leader 的 Session 编号（这个项目没有登记 Leader，或目录没有读到），打不开 Leader 的对话。`);
      lines.push(`${board.graph.counts.queuedMessages ?? "读不到"} 条消息排队`);
      return { title: "Leader", lines, targets, notes };
    case "packets":
      lines.push(`开放的通知包 ${board.graph.counts.openPackets ?? "读不到"}`);
      notes.push(`${NODE_UNAVAILABLE}调度板快照只给开放通知包的数量，不含各个包的清单，所以没有可打开的包页面；每条通知所属的任务，在对应事件的详情里打开。`);
      return { title: "通知包托盘", lines, targets, notes };
    case "people.scheduler":
      targets.push({ label: "打开日程", href: href(projectId, "schedules") });
      notes.push("日程页列出到点要分发的任务；这个节点是“日程到点”这一类来源，不对应单个日程。");
      return { title: "定时代班", lines, targets, notes };
    case "people.requirements":
      targets.push({ label: "打开智能体目录", href: href(projectId, "sessions") });
      notes.push(`${NODE_UNAVAILABLE}事件流只给身份字符串，没有给出需求 Session 的编号，页面无法判断该打开哪个 Session；到智能体目录里找它。`);
      return { title: "需求 Session", lines, targets, notes };
    case "people.user":
      notes.push(`${NODE_UNAVAILABLE}使用者是人，事件流只给身份字符串，不对应一个可打开的页面；使用者发出的消息在对应 Session 的对话里。`);
      return { title: "使用者", lines, targets, notes };
    case "people.notices":
      notes.push(`${NODE_UNAVAILABLE}结果通知是系统在交付和观察时产生的一类事件，不是一个对象；每条通知所属的任务，在对应事件的详情里打开。`);
      return { title: "结果通知", lines, targets, notes };
    case "people.external":
      notes.push(`${NODE_UNAVAILABLE}这是外部会话或工作台没有识别的身份，事件流只给身份字符串，没有可打开的页面。`);
      return { title: "其他身份", lines, targets, notes };
    default: {
      if (node.startsWith(STATION_PREFIX)) {
        const station = node.slice(STATION_PREFIX.length) as (typeof STATIONS)[number];
        const count = stationCounts(board, null).find(item => item.station === station)?.count ?? null;
        if (station === "已合并" || station === "已发布") {
          notes.push(`${NODE_UNAVAILABLE}调度事件流今天不含合并与发布，读不到这一步的数量，也没有可打开的页面；等真实事件出现才会显示。`);
          return { title: station, lines, targets, notes };
        }
        if (station === "已验收") {
          lines.push(`所读窗口内关闭的任务数，不是总数（近 ${windowHours ?? "?"} 小时）；数量由事件流里的关闭事件数出，快照不含`);
          notes.push(`${NODE_UNAVAILABLE}快照不含已关闭任务的清单，这里的数是窗口内的关闭事件数；要看已关闭的任务，到任务列表里选“已关闭”。`);
        } else lines.push(`${count === null ? "读不到" : count} 个，取自调度板快照`);
        targets.push({ label: "打开任务列表", href: tasks });
        return { title: station, lines, targets, notes };
      }
      return { title: String(node), lines, targets, notes: [`${NODE_UNAVAILABLE}不认识的节点，没有可打开的对象。`] };
    }
  }
}
