import { DomainError, type Reader } from "@evoloop/contracts/ports";
import { canonicalTaskInputJson, taskInputSignature } from "./task-input.js";

/** The one error code of this guard (Task 399fdac2): the artifact was already sent back and nothing it was judged against has changed. */
export const RESUBMIT_REJECTED_CODE = "RESUBMIT_REJECTED_ARTIFACT";

const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。！？!?]|\.(?:\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > 300 ? `${sentence.slice(0, 300)}…` : sentence;
};

/**
 * Refuses a delivery that repeats an artifact the consumer already sent back. In this Task, the newest Delivery that has a `failed` or `notUsed` observation is looked at:
 * when the new artifact has the same fingerprint (`artifactRevision` and `contentHash`, which for a PR is its head commit) AND the Task's business input is still what it
 * was when that observation was made (title, content, acceptance, owner, basis and the like; a revision the system makes with the same content does not count), the delivery
 * is refused. A changed artifact, a changed Task, a last observation of `used`, or another Task is never refused. Reads only: nothing is written.
 * Both entries use it: the signed submission (`ordinary.submit`) and `delivery.record`.
 */
export async function assertNotRejectedResubmission(reader: Reader, taskId: string, artifact: { artifactRevision: string; contentHash: string }): Promise<void> {
  const task = await reader.getTask(taskId);
  if (!task) return;
  const observations = await reader.listObservations(taskId);
  const deliveries = await reader.listDeliveries(taskId);
  const sentBack = new Map<string, (typeof observations)[number]>();
  for (const observation of observations) {
    if (observation.result !== "failed" && observation.result !== "notUsed") continue;
    const earlier = sentBack.get(observation.deliveryId);
    if (!earlier || observation.createdAt > earlier.createdAt) sentBack.set(observation.deliveryId, observation);
  }
  const candidates = deliveries.filter(delivery => sentBack.has(delivery.id));
  if (!candidates.length) return;
  const delivery = candidates.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id)) ? b : a);
  const observation = sentBack.get(delivery.id)!;
  // A `used` observation after that one (on this delivery or on a later one) means the judgement moved on: do not block.
  if (observations.some(item => item.result === "used" && item.createdAt > observation.createdAt)) return;
  if (delivery.artifactRevision.toLowerCase() !== artifact.artifactRevision.toLowerCase() || delivery.contentHash.toLowerCase() !== artifact.contentHash.toLowerCase()) return;
  // The Task as it was when the observation was made: its newest revision not after that moment (the Delivery's own revision when none is older).
  const revisions = await reader.listTaskRevisions(taskId);
  const atObservation = revisions.filter(revision => revision.createdAt <= observation.createdAt)
    .reduce<(typeof revisions)[number] | null>((a, b) => !a || b.version > a.version ? b : a, null)?.id ?? delivery.taskRevisionId;
  try {
    const judged = canonicalTaskInputJson(await taskInputSignature(reader, task, atObservation));
    const now = canonicalTaskInputJson(await taskInputSignature(reader, task));
    if (judged !== now) return; // the Task changed since: the same artifact against the new Task is a fair new check
  } catch { return; } // what the Task was cannot be read back: do not guess a refusal
  const why = firstSentence(observation.reason || observation.evidence || "");
  throw new DomainError(RESUBMIT_REJECTED_CODE,
    `这份产物（${artifact.artifactRevision.slice(0, 12)}）已被退回：观察 ${observation.id}（${observation.observer}，${observation.result === "failed" ? "没做到" : "没用上"}）对交付 ${delivery.id}，`
    + `退回原因：${why || "（原因没有写）"} 产物和任务从那以后都没有变，再交一次只会让验收者重复核同一个东西。`
    + `请按退回原因修改后再交；如果认为不用改，请需求 Session 改任务的验收条件（任务有新修订后，同一份产物可以按新条件重新交）。`);
}
