import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { SessionLineEntry } from "@evoloop/contracts/session-line";
import type { WorkflowService } from "@evoloop/core";

const terminalRun = new Set(["completed", "failed", "interrupted"]);
/** Waiting is not a failure: a refusal with one of these codes only means the Session or Task is not free yet. */
const transient = new Set(["SESSION_BUSY", "SESSION_MESSAGE_BUSY", "VERSION_CONFLICT", "RECOVERY_BLOCKED"]);
const failedMessage = new Set(["failed", "cancelled", "unknown", "manual_pending"]);
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60 * 60 * 1000;

/** A stable UUID for one purpose, so a replayed step carries the same operation id. */
export function lineIntentId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** The four commands an entry may run itself, fixed by the entry, its attempt and its retry count. */
function operations(entryId: string, attempt: number, stepTry: number) {
  const g = [entryId, String(attempt), String(stepTry)];
  return { assignOperationId: lineIntentId("assign", ...g), startOperationId: lineIntentId("start", ...g),
    reassignOperationId: lineIntentId("reassign", ...g), reserveOperationId: lineIntentId("reserve", ...g) };
}

export interface SessionLinePumpDeps {
  workflow: WorkflowService;
  credentials(): Promise<Principal[]>;
  enabled(): Promise<boolean>;
  canWrite(): boolean;
  pollIntervalMs: number;
  onError(error: unknown): void;
  /** The Session's business identity (the recipient of its assignments), or null when none is configured. */
  recipientActorId(projectId: string, sessionId: string): Promise<string | null>;
  messageBusy?(projectId: string, sessionId: string): Promise<boolean>;
  /** How long the Session may take to answer the execution confirmation before the entry is suspended. */
  confirmationTimeoutMs?: number;
  now?(): number;
}

type Outcome = { kind: "ok" } | { kind: "wait" } | { kind: "stop" };

/**
 * Drives each Session line (DEC-045 Q1): when the Session is free, the first waiting entry is assigned, the Session is asked for its
 * execution confirmation, and once it confirms the Task starts and the Run is reserved. A Run's end frees the Session for the next entry.
 * Every step is an ordinary command with an operation id fixed by the entry, the attempt and the retry count; a restart replays
 * safely, and a step that was only refused because the Session is busy is retried under fresh ids (a refusal is journalled).
 */
export class SessionLinePump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  constructor(private readonly deps: SessionLinePumpDeps) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.pollIntervalMs);
    this.timer.unref(); void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.scan().catch(this.deps.onError).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async scan(): Promise<void> {
    if (!this.deps.canWrite() || !await this.deps.enabled()) return;
    const credentials = await this.deps.credentials();
    for (const projectId of new Set(credentials.flatMap(p => p.projectIds))) {
      const reader = credentials.find(p => p.projectIds.includes(projectId) && p.permissions.includes("read"));
      if (!reader) continue;
      for (const line of await this.deps.workflow.listSessionLines(reader, projectId)) {
        const controller = credentials.find(p => p.actorId === line.controllerActorId && p.projectIds.includes(projectId) &&
          (["read", "write", "review"] as const).every(permission => p.permissions.includes(permission)));
        if (!controller) continue;
        try { await this.advance(projectId, line.sessionId, controller); } catch (error) { this.deps.onError(error); }
      }
    }
  }
  async advance(projectId: string, sessionId: string, lead: Principal): Promise<void> {
    const wf = this.deps.workflow;
    const entries = await wf.listSessionLineEntries(lead, projectId, sessionId, true);
    // An entry whose Run ended is recorded once, so the event stream shows when the Session became free for the next one.
    for (const entry of entries.filter(e => e.state === "started" && !e.runEndedAt && e.runId)) {
      const run = (await wf.listRuntimeRuns(lead, projectId, entry.taskId)).find(r => r.id === entry.runId);
      if (run && terminalRun.has(run.state))
        await wf.execute(lead, { type: "line.runEnded", projectId, operationId: lineIntentId("runEnded", entry.id, String(entry.version)),
          entryId: entry.id, expectedVersion: entry.version, runState: run.state as "completed" | "failed" | "interrupted" });
    }
    const live = entries.filter(e => e.state === "queued" || e.state === "suspended" || e.state === "starting");
    const starting = live.find(entry => entry.state === "starting");
    if (starting) return this.drive(projectId, starting, lead);
    const head = live.find(entry => entry.state === "queued");
    if (!head || !await this.sessionFree(projectId, sessionId, lead)) return;
    if (await wf.hasOlderQueuedMessage(lead, projectId, sessionId, head.appendedAt)) return;
    const attempt = head.attempt + 1;
    const result = await wf.execute(lead, { type: "line.begin", projectId, operationId: lineIntentId("begin", head.id, String(attempt), String(head.version)),
      entryId: head.id, expectedVersion: head.version, ...operations(head.id, attempt, 0), messageId: lineIntentId("message", head.id, String(attempt)) });
    if (result.status === "rejected" && !["VERSION_CONFLICT", "SESSION_BUSY", "LINE_BUSY", "NOT_AT_HEAD"].includes(result.code))
      this.deps.onError(new Error(`session line begin ${result.code}`));
  }
  private async sessionFree(projectId: string, sessionId: string, lead: Principal): Promise<boolean> {
    if (await this.deps.workflow.sessionHasLiveRun(lead, projectId, sessionId)) return false;
    return !(await this.deps.messageBusy?.(projectId, sessionId));
  }
  private async suspend(projectId: string, entry: SessionLineEntry, lead: Principal, code: string, reason: string): Promise<Outcome> {
    await this.deps.workflow.execute(lead, { type: "line.suspend", projectId,
      operationId: lineIntentId("suspend", entry.id, String(entry.attempt), String(entry.version)),
      entryId: entry.id, expectedVersion: entry.version, code, reason: reason.slice(0, 3900) || code });
    return { kind: "stop" };
  }
  /** Register fresh operation ids for the same step after a refusal that only meant "wait". */
  private async retry(projectId: string, entry: SessionLineEntry, lead: Principal): Promise<Outcome> {
    await this.deps.workflow.execute(lead, { type: "line.retry", projectId,
      operationId: lineIntentId("retry", entry.id, String(entry.attempt), String(entry.stepTry), String(entry.version)),
      entryId: entry.id, expectedVersion: entry.version, ...operations(entry.id, entry.attempt, entry.stepTry + 1) });
    return { kind: "wait" };
  }
  private async drive(projectId: string, entry: SessionLineEntry, lead: Principal): Promise<void> {
    const wf = this.deps.workflow;
    // Run a step as an ordinary command. A refusal that only means "wait" is retried under fresh ids; any other one suspends the entry.
    const step = async (command: Parameters<WorkflowService["execute"]>[1]): Promise<Outcome> => {
      let code: string, message: string;
      try {
        const result = await wf.execute(lead, command);
        if (result.status !== "rejected") return { kind: "ok" };
        code = result.code; message = result.message ?? result.code;
      } catch (error) {
        code = (error as { code?: string }).code ?? "STEP_FAILED"; message = error instanceof Error ? error.message : code;
      }
      return transient.has(code) ? this.retry(projectId, entry, lead) : this.suspend(projectId, entry, lead, code, message);
    };
    const task = (await wf.getTask(lead, projectId, entry.taskId)).task;
    const recipient = async () => this.deps.recipientActorId(projectId, entry.sessionId);
    const noRecipient = () => this.suspend(projectId, entry, lead, "RECIPIENT_UNAVAILABLE", "the Session has no configured business identity");
    const set = async (opId: string, reason: string, current: typeof task): Promise<Outcome> => {
      const actor = await recipient();
      if (!actor) return noRecipient();
      const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      return step({ type: "task.assignment.set", projectId, operationId: opId, taskId: entry.taskId, expectedTaskVersion: current.version,
        target: { kind: "owned", sessionId: entry.sessionId }, recipientActorId: actor, expectedVersion: assignment?.version ?? 0, reason });
    };
    const fresh = (a: Awaited<ReturnType<WorkflowService["getTaskAssignment"]>>, revisionId: string) =>
      !!a && a.state !== "released" && a.target.kind === "owned" && a.target.sessionId === entry.sessionId && a.taskRevisionId === revisionId;

    if (entry.step === "assign") {
      // Replays look first, so a step that already took effect is never sent again under changed parameters.
      if (!fresh(await wf.getTaskAssignment(lead, projectId, entry.taskId), task.currentRevisionId)) {
        const done = await set(entry.assignOperationId!, `Session line: execution confirmation requested (entry ${entry.id})`, task);
        if (done.kind !== "ok") return;
      }
      const assigned = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      if (!await wf.getSessionMessageRecord(lead, projectId, entry.messageId!)) {
        const posted = await step({ type: "session.message.post", projectId, operationId: lineIntentId("message-op", entry.id, String(entry.attempt), String(entry.stepTry)),
          messageId: entry.messageId!, target: { kind: "owned", sessionId: entry.sessionId }, context: { taskId: entry.taskId, taskRevisionId: task.currentRevisionId },
          content: confirmationRequest(task.title, task.id, task.currentRevisionId, task.version, assigned?.version ?? 1) });
        if (posted.kind !== "ok") return;
      }
      await step({ type: "line.advance", projectId, operationId: lineIntentId("advance-confirm", entry.id, String(entry.attempt), String(entry.version)),
        entryId: entry.id, expectedVersion: entry.version, to: "confirm" });
      return;
    }
    if (entry.step === "confirm") {
      const message = await wf.getSessionMessageRecord(lead, projectId, entry.messageId!);
      if (!message) return void await this.suspend(projectId, entry, lead, "MESSAGE_MISSING", "the confirmation request was never recorded");
      if (failedMessage.has(message.state) || message.blockedReason)
        return void await this.suspend(projectId, entry, lead, "MESSAGE_UNDELIVERED", `the confirmation request ${message.state}${message.blockedReason ? `: ${message.blockedReason}` : ""}`);
      const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      const confirmation = assignment ? await wf.getAssignmentConfirmation(lead, projectId, entry.taskId, assignment.version) : null;
      if (!assignment || !confirmation) {
        const waited = (this.deps.now?.() ?? Date.now()) - Date.parse(entry.updatedAt);
        if (waited > (this.deps.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS))
          await this.suspend(projectId, entry, lead, "CONFIRMATION_TIMEOUT", "the Session did not answer the execution confirmation in time");
        return; // still waiting for the Session
      }
      if (confirmation.verdict === "return")
        await step({ type: "line.withdrawReturned", projectId, operationId: lineIntentId("returned", entry.id, String(entry.attempt), String(entry.version)),
          entryId: entry.id, expectedVersion: entry.version, reason: `the Session returned the Task: ${confirmation.missing.join("; ")}`.slice(0, 3900) });
      else if (assignment.state === "accepted")
        await step({ type: "line.advance", projectId, operationId: lineIntentId("advance-start", entry.id, String(entry.attempt), String(entry.version)),
          entryId: entry.id, expectedVersion: entry.version, to: "start" });
      return;
    }
    // step "start": start the Task on its fixed basis, assign it on the started revision, then reserve an ordinary Run.
    const runId = lineIntentId("run", entry.id, String(entry.attempt));
    // The Run may already exist (the reply was lost, or the entry changed in between): record it instead of reserving another.
    if ((await wf.listRuntimeRuns(lead, projectId, entry.taskId)).some(r => r.id === runId)) {
      await step({ type: "line.started", projectId, operationId: lineIntentId("started", entry.id, String(entry.attempt), String(entry.version)),
        entryId: entry.id, expectedVersion: entry.version, runId });
      return;
    }
    if (!await this.sessionFree(projectId, entry.sessionId, lead)) return;
    let current = task;
    if (current.state !== "in_progress") {
      // The confirmation covers one revision; if the Task moved on since, the Session must confirm again.
      const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      const confirmation = assignment ? await wf.getAssignmentConfirmation(lead, projectId, entry.taskId, assignment.version) : null;
      if (!(assignment?.state === "accepted" && confirmation?.verdict === "confirm" && confirmation.expectedRevisionId === current.currentRevisionId))
        return void await this.suspend(projectId, entry, lead, "CONFIRMATION_STALE", "the Task changed after the Session confirmed it; resume the entry to ask again");
      const started = await step({ type: "task.start", projectId, operationId: entry.startOperationId!, taskId: entry.taskId, expectedVersion: current.version,
        reason: `Session line: started after the Session's execution confirmation (entry ${entry.id})` });
      if (started.kind !== "ok") return;
      current = (await wf.getTask(lead, projectId, entry.taskId)).task;
    }
    if (!fresh(await wf.getTaskAssignment(lead, projectId, entry.taskId), current.currentRevisionId)) {
      const done = await set(entry.reassignOperationId!, `Session line: assigned on the started revision (entry ${entry.id})`, current);
      if (done.kind !== "ok") return;
      current = (await wf.getTask(lead, projectId, entry.taskId)).task;
    }
    const reserved = await step({ type: "runtime.run.reserve", projectId, operationId: entry.reserveOperationId!, runId, taskId: entry.taskId,
      sessionId: entry.sessionId, expectedVersion: current.version,
      input: `Session 队伍排到了：按固定 Task 修订 ${current.currentRevisionId} 执行「${current.title}」。你已确认的计划见分派确认记录；先读固定 Task 与依据，再按验收交付。` });
    if (reserved.kind !== "ok") return;
    await step({ type: "line.started", projectId, operationId: lineIntentId("started", entry.id, String(entry.attempt), String(entry.version)),
      entryId: entry.id, expectedVersion: entry.version, runId });
  }
}

function confirmationRequest(title: string, taskId: string, revisionId: string, taskVersion: number, assignmentVersion: number): string {
  return [`Session 队伍轮到任务「${title}」（${taskId}），请先做执行确认，系统在你确认后才开 Run。`,
    `1. 读固定 Task 修订 ${revisionId}（evoloop task ${taskId} --project … --revision ${revisionId}）。`,
    `2. 能执行：提交 task.assignment.acknowledge，verdict=confirm，plan=简短计划，expectedRevisionId=${revisionId}，expectedVersion=${assignmentVersion}，expectedTaskVersion=${taskVersion}，evidence=已读依据。`,
    `3. 缺少执行所需的信息：同一命令用 verdict=return，missing=缺什么（列表）。该 Task 会退出队伍、回到作者那里修改。`,
    `只做确认，不要开始改文件；确认后系统自动开 Run。不带 verdict 的普通签收会被拒绝。`].join("\n");
}
