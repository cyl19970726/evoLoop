// Reads behind the stage views. Their query keys start with "journey" so a reread of 目标与阶段 (or any write in the project) refreshes them with the rest.
import type { StatusTone } from "@evoloop/ui";
import { api } from "../../shared/api";
import { statusTone } from "./stagesPresentation";
import { useProjectQuery } from "../../shared/query";

const key = "journey";

/** This browser's time zone, sent with the stage projection so "已到期待回看" counts the day where the reader is. */
export const browserTimeZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

/** The stages with short name, due date, how to tell it is reached, task counts and status: the overview's 阶段 block, 目标与阶段 and the new-task stage select all read it. */
export function useStageProjection(projectId: string, enabled = true) {
  return useProjectQuery(projectId, [key, "stage-projection"], signal => api().stageProjection(projectId, signal, browserTimeZone()), { enabled });
}
/** The verification ladder (M0 …). Its own query, so an unreadable ladder never hides the stages. */
export function useLadder(projectId: string, enabled = true) {
  return useProjectQuery(projectId, [key, "ladder"], signal => api().ladder(projectId, signal), { enabled, retry: false });
}

/**
 * The status word to show for a stage on pages that list stages by their own record (目标与阶段's side list, the chosen stage's facts): the service's `statusLabel`
 * from the stage projection, so one stage never carries two different words. A stage the projection does not list reads 状态未读到 (never an old lifecycle word).
 */
export function useStageStatusOf(projectId: string): (stage: { id: string; state: "proposed" | "active" | "reviewed" }) => { tone: StatusTone; label: string } {
  const projection = useStageProjection(projectId).data;
  return stage => {
    const read = projection?.stages.find(item => item.id === stage.id);
    if (read) return { tone: statusTone[read.status], label: read.statusLabel };
    return projection ? { tone: "unknown", label: "状态未读到" } : { tone: "unknown", label: "读取中" };
  };
}
