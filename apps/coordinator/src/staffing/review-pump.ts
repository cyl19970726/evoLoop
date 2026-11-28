// A trial Role that reaches its review date gets a Task (DEC-056, PROP-012): reviews were a rule nobody was asked to carry out, so seven trials passed
// their date with no review on record. The pump reads the staffing check and, for each due trial, creates one review Task through the real
// `task.create` command, as the actor and for the owner the private configuration names. The Task and operation ids are derived from the Role and its
// review date, so a restart or a second round is the same Task, and a trial continued to a new date gets a new one when that date passes.
import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { StaffingCheck, StaffingTrialDue } from "@evoloop/contracts/staffing";

export interface ReviewTaskGrant {
  projectId: string;
  /** Who creates the Task; needs Task write permission in the project. */
  actorId: string;
  /** The Role that owns the review (a trial or active Role). */
  owner: string;
  /** The identity that accepts the review's delivery; never the author. */
  consumer: string;
}
export interface TrialReviewDeps {
  canWrite(): boolean;
  /** The grants of the enabled staffing section, read on each round. */
  grants(): Promise<ReviewTaskGrant[]>;
  /** The creating actor as a principal; null when the identity file no longer has it. */
  principal(grant: ReviewTaskGrant): Promise<Principal | null>;
  check(principal: Principal, projectId: string): Promise<StaffingCheck>;
  taskExists(principal: Principal, projectId: string, taskId: string): Promise<boolean>;
  createTask(principal: Principal, command: ReturnType<typeof reviewTaskCommand>): Promise<{ status: string; code?: string }>;
  onCreated?(projectId: string, taskId: string, due: StaffingTrialDue): void;
  /** A refused creation, said once per Task while the process runs. */
  onRefused?(projectId: string, taskId: string, code: string): void;
  onError?(error: unknown): void;
}

/** Stable RFC 4122 UUID for one logical intent (the same construction as the managed loop's ids). */
const stableId = (...parts: string[]): string => {
  const bytes = Buffer.from(createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const reviewTaskIds = (projectId: string, roleId: string, reviewAtUtc: string) => ({
  taskId: stableId("trial-review", projectId, roleId, reviewAtUtc, "task"),
  operationId: stableId("trial-review", projectId, roleId, reviewAtUtc, "operation"),
});

export function reviewTaskCommand(grant: ReviewTaskGrant, due: StaffingTrialDue) {
  const day = due.reviewAtUtc.slice(0, 10);
  const content = [
    `试行职责「${due.title}」的回看日是 ${day}，到这一天还没有回看记录。系统据此自动生成本任务。`,
    "",
    "## 要做什么",
    "",
    `对照这个职责试行以来的真实工作，给出四选一的结论，并用 \`role.review\` 记下：继续试行（写明下一个回看日）、转正、并入另一个职责、收回。`,
    "",
    "## 依据从哪里来",
    "",
    "- 分工检查（`staffing check`）：这个职责现在有几个打开的 Session，哪些连续多天没有工作。",
    "- 分工账（`npm run metrics:duties`）：这个职责在试行期里承接了多少、被接受多少、打回率和已记花费。",
    "- 提出这个职责时写下的基线、预期效果、花费上限和退出条件，在 Role 的当前修订里。",
    "",
    "## 约束",
    "",
    "- 结论要引用具体的任务、交付或统计，不写印象。",
    "- 回看没有记下之前，系统不允许再加业务 Session（确有必要时可写明例外）。",
    `- 职责编号：\`${due.roleId}\`。`,
    "",
    "关闭后下一步：结论是收回或合并时，由 Leader 按 role.handoff 交接并收回这个职责的 Session；结论是继续试行时，到新的回看日系统会再生成一个回看任务。",
  ].join("\n");
  return {
    type: "task.create" as const, projectId: grant.projectId, ...reviewTaskIds(grant.projectId, due.roleId, due.reviewAtUtc),
    title: `试行回看：${due.title}（${day} 到期）`.slice(0, 240), content,
    acceptance: `这个职责有一条回看日之后的 role.review 记录，结论是继续试行、转正、合并或收回之一，并引用了具体的任务、交付或统计。`,
    owner: grant.owner, kind: "operation" as const, noStage: true, noStageReason: "试行回看是组织维护，不属于某个交付阶段。",
    consumer: grant.consumer, completionBoundary: "delivered" as const,
  };
}

export class TrialReviewPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private readonly told = new Set<string>();
  constructor(private readonly deps: TrialReviewDeps, private readonly pollMs = 300_000) {}
  start(): void { if (this.timer) return; this.timer = setInterval(() => { void this.tick(); }, this.pollMs); this.timer.unref(); void this.tick(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.scan().catch(error => this.deps.onError?.(error)).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async scan(): Promise<void> {
    if (!this.deps.canWrite()) return;
    for (const grant of await this.deps.grants()) {
      const principal = await this.deps.principal(grant);
      if (!principal) continue;
      const check = await this.deps.check(principal, grant.projectId);
      for (const due of check.trialsDue) {
        const command = reviewTaskCommand(grant, due);
        if (await this.deps.taskExists(principal, grant.projectId, command.taskId)) continue;
        const result = await this.deps.createTask(principal, command);
        if (result.status === "applied") this.deps.onCreated?.(grant.projectId, command.taskId, due);
        else if (!this.told.has(command.taskId)) { this.told.add(command.taskId); this.deps.onRefused?.(grant.projectId, command.taskId, result.code ?? "unknown"); }
      }
    }
  }
}
