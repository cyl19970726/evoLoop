// The one sentence about a provider hold ("模型服务 Codex 额度用完，Leader 等 4 个智能体停着：需要你充值或重新授权") for every place that tells it: the bar above
// every page, the overview's first row and 待我处理. One component, one count (the distinct affected agents of the whole hold), one name rule.
import { holdLine, type HoldSummary } from "../providerHoldPresentation";
import { useSessionName } from "./RecordName";

/** The sentence itself: it names the first affected agent once that name is read (alone when it is the only one, "X 等 N 个" otherwise). */
export function useHoldSentence(projectId: string, summary: HoldSummary | null): string | null {
  const first = summary?.sessionIds[0];
  const name = useSessionName(projectId, first ? `owned:${first}` : null);
  return summary ? holdLine(summary, name.state === "named" ? name.name : null) : null;
}
export function HoldSentence({ projectId, summary }: { projectId: string; summary: HoldSummary | null }) {
  return <>{useHoldSentence(projectId, summary)}</>;
}
