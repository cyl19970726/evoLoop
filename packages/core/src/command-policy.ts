import type { Command, Permission } from "@evoloop/contracts";

export interface CommandPermissionPolicy {
  permission: Permission;
  decision: boolean;
}

const task = (decision = false): CommandPermissionPolicy => ({ permission: "task", decision });
const document = (decision = false): CommandPermissionPolicy => ({ permission: "document", decision });
const session = (decision = false): CommandPermissionPolicy => ({ permission: "session", decision });
const management = (decision = false): CommandPermissionPolicy => ({ permission: "management", decision });

/**
 * Every coordinator command has exactly one owning class. The table is intentionally explicit: adding a command
 * without classifying it makes `satisfies` fail and leaves the runtime lookup rejected.
 */
export const commandPermissionPolicy = {
  "project.create": management(),
  "document.create": document(),
  "document.revise": document(),
  "document.adopt": document(true),
  "document.publish": document(true),
  "document.archive": document(true),
  "document.restore": document(true),
  "task.create": task(),
  "task.update": task(),
  "task.reviewBasis": task(true),

  "goal.create": task(),
  "goal.revise": task(),
  "stage.propose": task(),
  "stage.phaseKey.set": task(true),
  "stage.accept": task(true),
  "task.start": task(true),
  "task.cancel": task(true),
  "task.reopen": task(true),
  "delivery.record": task(),
  "observation.record": task(),
  "task.close": task(true),
  "stage.review": task(true),
  "stage.review.correct": task(true),
  "task.acceptancePrecondition.mark": task(true),
  "task.timing.set": task(),
  "task.timing.stop": task(true),

  "runtime.session.reserve": session(true),
  "runtime.session.close": session(true),
  "runtime.run.reserve": session(true),
  "runtime.run.interrupt": session(true),
  "runtime.run.stop": session(true),
  "runtime.run.abandonReadOnly": session(true),
  "runtime.handoff.record": session(),
  "runtime.session.executionProfile.revise": session(true),
  "runtime.session.recovery.resume": session(true),
  "runtime.providerHold.release": session(true),

  "session.message.post": session(),
  "session.message.receipt": session(),
  "session.message.cancel": session(),
  "session.message.confirmSuperseded": session(),
  "session.message.reconcile": session(true),
  "session.message.interrupt": session(true),
  "session.message.manualStop": session(true),
  "session.input.reply": session(),
  "session.profile.set": session(true),
  "session.identity.set": session(true),
  "task.assignment.acknowledge": task(),
  "task.assignment.observeAcceptance": task(true),
  "task.assignment.release": task(true),
  "task.assignment.set": task(true),

  "discussion.prepare": task(),
  "discussion.handoff.record": task(),
  "discussion.decision.record": task(true),
  "discussion.action.link": task(true),
  "discussion.openTask": task(true),
  "discussion.message.post": task(),
  "discussion.receipt.record": task(),
  "discussion.action.request": task(),
  "discussion.action.decide": task(true),
  "discussion.action.execute": task(true),

  "decision.request.create": task(true),
  "decision.request.answer": task(true),
  "decision.request.withdraw": task(true),
  "leader.notice.handle": task(true),
  "leader.noticePacket.build": task(),
  "leader.noticePacket.observe": task(),
  "leader.noticePacket.recover": task(true),
  "leader.noticePacket.sent": task(),
  "leader.noticePacket.steered": task(),

  "schedule.create": management(),
  "schedule.revise": management(),
  // Dispatch intake is a decision: a line or queue can later be advanced by a decision-enabled controller, but that
  // controller is not allowed to lend its authority to a management-only issuer of the work.
  "schedule.dispatch.set": management(true),
  "schedule.directList.set": management(true),
  "schedule.directEntry.withdraw": management(true),
  "queue.create": management(true),
  "queue.reorder": management(true),
  "queue.amend": management(true),
  "queue.adopt": management(true),
  "queue.unhold": management(true),
  "queue.claim": management(true),
  "queue.continue": management(true),
  "queue.release": management(true),
  "queue.stop": management(true),
  "queue.hold": management(true),
  "queue.extendBudget": management(true),
  "queue.retryFailed": management(true),

  "line.append": management(true),
  "line.begin": management(true),
  "line.move": management(true),
  "line.remove": management(true),
  "line.suspend": management(true),
  "line.resume": management(true),
  "line.retry": management(true),
  "line.withdrawReturned": management(true),
  "line.runEnded": management(true),
  "line.started": management(true),
  "line.advance": management(true),

  "role.propose": management(),
  "role.bootstrap": management(true),
  "role.revise": management(),
  "role.decide": management(true),
  "role.review": management(true),
  "role.handoff": management(),
  "role.ackHandoff": management(),
  "role.bindSession": management(),
  "role.classify": management(),
  "role.runtime.set": management(),
  "role.retire": management(true),
  "domain.create": management(),
  "domain.update": management(),
  "host.register": management(),
  "host.verify": management(),
  "host.revoke": management(true),
  "evaluation.create": management(),
  "evaluation.revise": management(),
  "evaluation.assessment.record": management(),
  "evaluation.conclusion.record": management(true),

  "task.attention.thresholds.set": management(),
  "task.attention.followUp.set": management(),
  "task.attention.publication.record": management(),
  "task.attention.resolve": management(true),
} as const satisfies Record<Command["type"], CommandPermissionPolicy>;

export function commandPolicy(type: string): CommandPermissionPolicy {
  if (!Object.prototype.hasOwnProperty.call(commandPermissionPolicy, type))
    throw new Error(`Unclassified coordinator command: ${type}`);
  return commandPermissionPolicy[type as Command["type"]];
}
