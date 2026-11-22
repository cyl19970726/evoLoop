// The words the Session line sends to the executing Session: the execution-confirmation request and the Run instruction (Task 586504eb).
// Two rules the text follows:
//  1. A rework entry says so: which delivery and which observation sent the Task back, with the observation's evidence and reason (cut to fit, with the command to read the rest).
//  2. The text never names a Task revision. The Run is bound to a revision the dispatch creates after the text is written, so a number written here would be the one before it;
//     the confirmation and the Run handoff both say where to read the revision that counts.
import type { ConsumerObservation } from "@evoloop/contracts/workflow";

/** The runtime.run.reserve input limit (a command text field). The Run instruction stays below it with room to spare. */
export const RUN_INPUT_LIMIT = 4000;
const RUN_INPUT_BUDGET = RUN_INPUT_LIMIT - 100;
/** The confirmation request is a session message; it is kept to the same budget so both texts carry the same rework block. */
const MESSAGE_BUDGET = RUN_INPUT_LIMIT - 100;

export interface ReworkSource {
  deliveryId: string;
  observation: Pick<ConsumerObservation, "id" | "observer" | "result" | "evidence" | "reason" | "createdAt"> | null;
  observationId: string;
}

const resultWord: Record<string, string> = { failed: "failed（没做到）", notUsed: "notUsed（没被使用）", used: "used" };

const cut = (text: string, limit: number): { text: string; cut: boolean } =>
  text.length <= limit ? { text, cut: false } : { text: `${text.slice(0, Math.max(0, limit - 1))}…`, cut: true };

/** The rework paragraph, at most `budget` characters: the header always, then evidence and reason sharing what is left (the reason gets its share first, it is the shorter one). */
export function reworkBlock(projectId: string, taskId: string, source: ReworkSource, budget: number): string {
  const o = source.observation;
  const read = `读全文：evoloop task ${taskId} --project ${projectId}，在返回的 observations 里找编号 ${source.observationId}。`;
  const head = [
    "【返工】这不是新任务：交付没通过消费者的核对，被退回了，请按退回原因改，然后重新交付。",
    `针对交付 ${source.deliveryId}；观察 ${source.observationId}${o ? `（观察者 ${o.observer}，结果 ${resultWord[o.result] ?? o.result}，${o.createdAt}）` : ""}。`,
  ];
  if (!o) return [...head, `这条观察现在读不到原文。${read}`].join("\n");
  const fixed = [...head, "evoloop 退回的 evidence：", "", "退回的 reason：", "", read].join("\n").length + 40;
  const room = Math.max(200, budget - fixed);
  const reasonShare = Math.min(o.reason.length, Math.floor(room / 3));
  const reason = cut(o.reason, reasonShare);
  const evidence = cut(o.evidence, room - reason.text.length);
  return [...head, `退回的 evidence：${evidence.text}`, `退回的 reason：${reason.text}`,
    evidence.cut || reason.cut ? `（原文较长，已截断。${read}）` : read].join("\n");
}

/** The Run instruction. No Task revision is named: the Run's own handoff carries the bound revision (`taskRevisionId`), and that is the one to execute on. */
export function runInstruction(title: string, projectId: string, taskId: string, rework: ReworkSource | null): string {
  const base = `Session 队伍排到了：按本 Run 绑定的固定 Task 修订执行「${title}」（修订号以本 Run 交接信息里的 taskRevisionId 为准，也可用 evoloop task ${taskId} --project ${projectId} 读当前修订）。你已确认的计划见分派确认记录；先读固定 Task 与依据，再按验收交付。`;
  if (!rework) return base;
  return `${base}\n${reworkBlock(projectId, taskId, rework, RUN_INPUT_BUDGET - base.length - 1)}`;
}

/**
 * The execution-confirmation request. It asks to confirm the Task as it is when read: the revision to put in `expectedRevisionId` is the current one
 * (`revision.id` of `evoloop task`), so no number is written here that the Run could later disagree with.
 */
export function confirmationRequest(title: string, projectId: string, taskId: string, taskVersion: number, assignmentVersion: number, rework: ReworkSource | null): string {
  const lines = [`Session 队伍轮到任务「${title}」（${taskId}），请先做执行确认，系统在你确认后才开 Run。`,
    `1. 读 Task 当前修订（evoloop task ${taskId} --project ${projectId}；返回里的 revision.id 就是下面要写的 expectedRevisionId）。开 Run 时系统可能再生成一个内容不变的新修订，Run 绑定的修订以 Run 交接信息里的 taskRevisionId 为准。`,
    `2. 能执行：提交 task.assignment.acknowledge，verdict=confirm，plan=简短计划，expectedRevisionId=第 1 步读到的 revision.id，expectedVersion=${assignmentVersion}，expectedTaskVersion=${taskVersion}，evidence=已读依据。`,
    "3. 缺少执行所需的信息：同一命令用 verdict=return，missing=缺什么（列表）。该 Task 会退出队伍、回到作者那里修改。",
    "只做确认，不要开始改文件；确认后系统自动开 Run。不带 verdict 的普通签收会被拒绝。"];
  if (!rework) return lines.join("\n");
  const body = lines.join("\n");
  return `${body}\n${reworkBlock(projectId, taskId, rework, MESSAGE_BUDGET - body.length - 1)}`;
}
