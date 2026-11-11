import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { SessionLineEntry } from "@evoloop/contracts/session-line";
import type { WorkflowService } from "@evoloop/core";

const terminalRun = new Set(["completed", "failed", "interrupted"]);
/** Waiting is not a failure: these refusals mean the Session or Task is not free yet, so the same step is tried again. */
const transient = new Set(["SESSION_BUSY", "SESSION_MESSAGE_BUSY", "VERSION_CONFLICT", "SESSION_RECOVERY_REQUIRED", "RECOVERY_GATE_BLOCKED"]);

/** A stable UUID for one purpose of one entry and attempt, so a replayed step carries the same operation id. */
export function lineIntentId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
  /**
   * A message queued for the Session before this entry was appended is still waiting. The Session takes whichever arrived first, so
   * neither the line nor the message queue starves the other (design 5.1 rule 6).
   */
  olderMessageWaiting?(projectId: string, sessionId: string, appendedAt: string): Promise<boolean>;
}

/**
 * Drives each Session line (DEC-045 Q1): when the Session is free, the first waiting entry is assigned, the Session is asked for its
 * execution confirmation, and once it confirms the Task starts and the Run is reserved. A Run's end frees the Session for the next entry.
 * Every step is an ordinary command with an operation id fixed by the entry and the attempt, so a restart replays safely.
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
    const entries = await this.deps.workflow.listSessionLineEntries(lead, projectId, sessionId);
    const starting = entries.find(entry => entry.state === "starting");
    if (starting) return this.drive(projectId, starting, lead);
    const head = entries.find(entry => entry.state === "queued");
    if (!head || !await this.sessionFree(projectId, sessionId, lead)) return;
    if (await this.deps.olderMessageWaiting?.(projectId, sessionId, head.appendedAt)) return;
    const generation = [projectId, head.id, String(head.attempt + 1)];
    const result = await this.deps.workflow.execute(lead, { type: "line.begin", projectId, operationId: lineIntentId("begin", ...generation),
      entryId: head.id, expectedVersion: head.version, assignOperationId: lineIntentId("assign", ...generation),
      startOperationId: lineIntentId("start", ...generation), reassignOperationId: lineIntentId("reassign", ...generation),
      reserveOperationId: lineIntentId("reserve", ...generation), messageId: lineIntentId("message", ...generation) });
    if (result.status === "rejected" && !["VERSION_CONFLICT", "SESSION_BUSY", "LINE_BUSY", "NOT_AT_HEAD"].includes(result.code))
      this.deps.onError(new Error(`session line begin ${result.code}`));
  }
  private async sessionFree(projectId: string, sessionId: string, lead: Principal): Promise<boolean> {
    const runs = await this.deps.workflow.listRuntimeRuns(lead, projectId);
    if (runs.some(run => run.sessionId === sessionId && !terminalRun.has(run.state))) return false;
    return !(await this.deps.messageBusy?.(projectId, sessionId));
  }
  private async suspend(projectId: string, entry: SessionLineEntry, lead: Principal, code: string, reason: string): Promise<void> {
    await this.deps.workflow.execute(lead, { type: "line.suspend", projectId,
      operationId: lineIntentId("suspend", projectId, entry.id, String(entry.attempt), entry.step ?? "", String(entry.version)),
      entryId: entry.id, expectedVersion: entry.version, code, reason: reason.slice(0, 3900) || code });
  }
  private async drive(projectId: string, entry: SessionLineEntry, lead: Principal): Promise<void> {
    const wf = this.deps.workflow;
    // Run a step as an ordinary command; a refusal that is only waiting is retried on the next tick, any other one suspends the entry.
    const run = async (command: Parameters<WorkflowService["execute"]>[1]) => {
      try { return await wf.execute(lead, command); }
      catch (error) {
        const code = (error as { code?: string }).code ?? "STEP_FAILED";
        if (transient.has(code)) return null;
        await this.suspend(projectId, entry, lead, code, error instanceof Error ? error.message : code);
        return null;
      }
    };
    const rejected = async (result: Awaited<ReturnType<typeof run>>): Promise<boolean> => {
      if (!result) return true;
      if (result.status !== "rejected") return false;
      if (!transient.has(result.code)) await this.suspend(projectId, entry, lead, result.code, result.message ?? result.code);
      return true;
    };
    const task = (await wf.getTask(lead, projectId, entry.taskId)).task;
    if (entry.step === "assign") {
      const recipient = await this.deps.recipientActorId(projectId, entry.sessionId);
      if (!recipient) return this.suspend(projectId, entry, lead, "RECIPIENT_UNAVAILABLE", "the Session has no configured business identity");
      const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      if (await rejected(await run({ type: "task.assignment.set", projectId, operationId: entry.assignOperationId!, taskId: entry.taskId,
        expectedTaskVersion: task.version, target: { kind: "owned", sessionId: entry.sessionId }, recipientActorId: recipient,
        expectedVersion: assignment?.version ?? 0, reason: `Session line: execution confirmation requested (entry ${entry.id})` }))) return;
      const assigned = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      if (await rejected(await run({ type: "session.message.post", projectId, operationId: lineIntentId("message-op", entry.id, String(entry.attempt)),
        messageId: entry.messageId!, target: { kind: "owned", sessionId: entry.sessionId }, context: { taskId: entry.taskId, taskRevisionId: task.currentRevisionId },
        content: confirmationRequest(task.title, task.id, task.currentRevisionId, task.version, assigned?.version ?? 1) }))) return;
      await rejected(await run({ type: "line.advance", projectId, operationId: lineIntentId("advance-confirm", entry.id, String(entry.attempt)),
        entryId: entry.id, expectedVersion: entry.version, to: "confirm" }));
      return;
    }
    if (entry.step === "confirm") {
      const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
      if (!assignment) return;
      const confirmation = await wf.getAssignmentConfirmation(lead, projectId, entry.taskId, assignment.version);
      if (!confirmation) return; // still waiting for the Session
      if (confirmation.verdict === "return")
        await rejected(await run({ type: "line.withdrawReturned", projectId, operationId: lineIntentId("returned", entry.id, String(entry.attempt)),
          entryId: entry.id, expectedVersion: entry.version, reason: `the Session returned the Task: ${confirmation.missing.join("; ")}`.slice(0, 3900) }));
      else if (assignment.state === "accepted")
        await rejected(await run({ type: "line.advance", projectId, operationId: lineIntentId("advance-start", entry.id, String(entry.attempt)),
          entryId: entry.id, expectedVersion: entry.version, to: "start" }));
      return;
    }
    // step "start": start the Task on its fixed basis, assign it on the started revision, then reserve an ordinary Run.
    if (!await this.sessionFree(projectId, entry.sessionId, lead)) return;
    let current = task;
    if (current.state !== "in_progress") {
      if (await rejected(await run({ type: "task.start", projectId, operationId: entry.startOperationId!, taskId: entry.taskId,
        expectedVersion: current.version, reason: `Session line: started after the Session's execution confirmation (entry ${entry.id})` }))) return;
      current = (await wf.getTask(lead, projectId, entry.taskId)).task;
    }
    const recipient = await this.deps.recipientActorId(projectId, entry.sessionId);
    if (!recipient) return this.suspend(projectId, entry, lead, "RECIPIENT_UNAVAILABLE", "the Session has no configured business identity");
    const assignment = await wf.getTaskAssignment(lead, projectId, entry.taskId);
    if (assignment?.taskRevisionId !== current.currentRevisionId || assignment.state === "released") {
      if (await rejected(await run({ type: "task.assignment.set", projectId, operationId: entry.reassignOperationId!, taskId: entry.taskId,
        expectedTaskVersion: current.version, target: { kind: "owned", sessionId: entry.sessionId }, recipientActorId: recipient,
        expectedVersion: assignment?.version ?? 0, reason: `Session line: assigned on the started revision (entry ${entry.id})` }))) return;
      current = (await wf.getTask(lead, projectId, entry.taskId)).task;
    }
    const runId = lineIntentId("run", entry.id, String(entry.attempt));
    if (await rejected(await run({ type: "runtime.run.reserve", projectId, operationId: entry.reserveOperationId!, runId, taskId: entry.taskId,
      sessionId: entry.sessionId, expectedVersion: current.version,
      input: `Session 队伍排到了：按固定 Task 修订 ${current.currentRevisionId} 执行「${current.title}」。你已确认的计划见分派确认记录；先读固定 Task 与依据，再按验收交付。` }))) return;
    await rejected(await run({ type: "line.started", projectId, operationId: lineIntentId("started", entry.id, String(entry.attempt)),
      entryId: entry.id, expectedVersion: entry.version, runId }));
  }
}

function confirmationRequest(title: string, taskId: string, revisionId: string, taskVersion: number, assignmentVersion: number): string {
  return [`Session 队伍轮到任务「${title}」（${taskId}），请先做执行确认，系统在你确认后才开 Run。`,
    `1. 读固定 Task 修订 ${revisionId}（evoloop task ${taskId} --project … --revision ${revisionId}）。`,
    `2. 能执行：提交 task.assignment.acknowledge，verdict=confirm，plan=简短计划，expectedRevisionId=${revisionId}，expectedVersion=${assignmentVersion}，expectedTaskVersion=${taskVersion}，evidence=已读依据。`,
    `3. 缺少执行所需的信息：同一命令用 verdict=return，missing=缺什么（列表）。该 Task 会退出队伍、回到作者那里修改。`,
    `只做确认，不要开始改文件；确认后系统自动开 Run。`].join("\n");
}
