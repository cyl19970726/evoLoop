// 等我使用的交付: the one rule for "this delivery waits for me to use it", shared by the workbench's 待我处理 and the CLI/HTTP
// `work acceptance mine` (`direct`), so the two lists cannot drift apart. Pure over a work-index task and a reader's identity.
//
// The declared consumer is an exact actorId; the index's observation is the latest one on the current delivery by anyone,
// so a later observation by someone else hides mine: then mine is read from the task's observations. When my latest
// observation of the current delivery is 使用失败, the next step is the executor's rework, not mine: the delivery is not
// listed until a new delivery comes (未使用 stays listed).
import type { ConsumerObservation } from "./index.js";
import type { LeaderWorkTask } from "./work-index.js";

export type UseResult = "used" | "failed" | "notUsed";
/** The observation after which the delivery still waits for me: 未使用 (使用失败 sends it back to rework). */
export type NotUsedResult = "notUsed";

/** What the work index says about one task's current delivery for this reader. */
export type MyDeliveryJudgement =
  /** Not a current, passed delivery declared for me on an open task. */
  | { kind: "none"; reason: "closed" | "no-delivery" | "old-revision" | "other-consumer" | "not-passed" }
  /** My latest observation of the current delivery is 已使用. */
  | { kind: "used" }
  /** My latest observation of the current delivery is 使用失败: it goes back to the executor for rework, not to me. */
  | { kind: "failed" }
  /** Declared for me and not yet 已使用 by me; `last` is my latest observation, if any. */
  | { kind: "waiting"; last: NotUsedResult | null }
  /** The latest observation is someone else's: whether I recorded 已使用 is read from the task's observations. */
  | { kind: "check-own" };

export function judgeMyDelivery(item: Pick<LeaderWorkTask, "taskState" | "currentRevisionId" | "delivery">, actorId: string): MyDeliveryJudgement {
  if (item.taskState === "done" || item.taskState === "cancelled") return { kind: "none", reason: "closed" };
  const delivery = item.delivery;
  if (!delivery) return { kind: "none", reason: "no-delivery" };
  if (delivery.taskRevisionId !== item.currentRevisionId) return { kind: "none", reason: "old-revision" };
  if (!actorId || delivery.consumer !== actorId) return { kind: "none", reason: "other-consumer" };
  // A delivery whose technical check failed goes back to rework; there is nothing to use until the next one.
  if (delivery.technicalResult !== "passed") return { kind: "none", reason: "not-passed" };
  if (!delivery.observationActorId || !delivery.observationResult) return { kind: "waiting", last: null };
  if (delivery.observationActorId !== actorId) return { kind: "check-own" };
  const result = delivery.observationResult;
  return result === "used" ? { kind: "used" } : result === "failed" ? { kind: "failed" } : { kind: "waiting", last: result };
}

/** My latest observation of one delivery among a task's observations (the observer, not who typed it, is the consumer). */
export function myLatestObservation(observations: readonly ConsumerObservation[], deliveryId: string, actorId: string): ConsumerObservation | null {
  let latest: ConsumerObservation | null = null;
  for (const item of observations) {
    if (item.deliveryId !== deliveryId || item.observer !== actorId) continue;
    if (!latest || Date.parse(item.createdAt) >= Date.parse(latest.createdAt)) latest = item;
  }
  return latest;
}

