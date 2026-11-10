// The three reads of 待我处理, shared by the page (InboxIndex.tsx) and the count in the shell (app/App.tsx): one key and
// one answer each, so the page and the count never disagree. Kept small and free of components: the shell loads it
// with the first screen, and the work-index reading (inboxDeliveries.ts) loads on demand after sign-in.
import type { AcceptanceHumanItem } from "@evoloop/contracts/acceptance-relay";
import type { Impact } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { inboxBadge, type InboxBadge } from "./inboxModel";
import type { DeliveriesForMe } from "./inboxDeliveries";

export type { DeliveriesForMe } from "./inboxDeliveries";

export const inboxKeys = {
  acceptance: ["acceptance", "mine"] as const,
  impacts: ["impacts"] as const,
  deliveries: (actorId: string) => ["inbox", "deliveries", actorId] as const,
};

export async function readAcceptanceMine(projectId: string): Promise<{ items: AcceptanceHumanItem[] }> {
  const value = await api().acceptanceMine(projectId);
  if (!Array.isArray(value?.items) || value.items.some(item => item.projectId !== projectId)) throw new Error("待验收列表响应与当前项目不符");
  return value;
}

export async function readImpacts(projectId: string): Promise<Impact[]> {
  const value = await api().impacts(projectId);
  if (!Array.isArray(value)) throw new Error("依据变化响应不完整");
  return value;
}

const readDeliveries = async (projectId: string, actorId: string, signal: AbortSignal): Promise<DeliveriesForMe> =>
  (await import("./inboxDeliveries")).readDeliveriesForMe(projectId, actorId, signal);

/** The three reads; `enabled` waits for a signed-in identity. */
export function useInboxReads(projectId: string, actorId: string, enabled = true) {
  const acceptance = useProjectQuery(projectId, inboxKeys.acceptance, () => readAcceptanceMine(projectId), { enabled });
  const impacts = useProjectQuery(projectId, inboxKeys.impacts, () => readImpacts(projectId), { enabled });
  const deliveries = useProjectQuery(projectId, inboxKeys.deliveries(actorId), signal => readDeliveries(projectId, actorId, signal),
    { enabled: enabled && !!actorId });
  return { acceptance, impacts, deliveries };
}

/** The 待我处理 count: 验收安排 + 依据变化 + 等我使用的交付, or why it cannot be counted now. */
export function useInboxCount(projectId: string, actorId: string, enabled = true): InboxBadge {
  const { acceptance, impacts, deliveries } = useInboxReads(projectId, actorId, enabled);
  return inboxBadge([
    { label: "待我验收", count: acceptance.data?.items.length, failed: acceptance.isError },
    { label: "依据变化", count: impacts.data?.filter(item => item.state === "pending").length, failed: impacts.isError },
    { label: "等我使用的交付", count: deliveries.data?.items.length, failed: deliveries.isError, incomplete: deliveries.data ? !deliveries.data.complete : false },
  ]);
}
