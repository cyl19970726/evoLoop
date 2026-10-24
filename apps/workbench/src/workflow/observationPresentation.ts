import type { ConsumerObservation } from "@evoloop/contracts";

export const observationResultLabel = { used: "已使用", failed: "使用失败", notUsed: "未使用" } as const;
export const observerKindLabel = { human: "登记为人类", agent: "登记为 Agent" } as const;

export function observationsForDelivery(observations: ConsumerObservation[], deliveryId: string): ConsumerObservation[] {
  return observations.filter(item => item.deliveryId === deliveryId);
}
