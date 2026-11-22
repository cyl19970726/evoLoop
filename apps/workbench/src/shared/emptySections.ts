// Pages with nothing to show do not take a place in the menu (the decision on 空页面不占菜单): a section is hidden only when its own list was read
// and came back empty. A read that has not finished or failed hides nothing, so "no data" is never guessed. The page a reader is on stays listed.
import type { Section } from "./routes";
import { api, request } from "./api";
import { useProjectQuery } from "./query";

type Listed = { items?: unknown[] };
const none = (value: Listed | undefined) => !!value && Array.isArray(value.items) && value.items.length === 0;

export function useEmptySections(projectId: string, token: string, enabled: boolean): ReadonlySet<Section> {
  const on = enabled && !!projectId;
  const evaluations = useProjectQuery(projectId, ["nav", "evaluations"], () => api().evaluations(projectId), { enabled: on, retry: false });
  const discussions = useProjectQuery(projectId, ["nav", "discussions"], () => api().discussions(projectId), { enabled: on, retry: false });
  const receipts = useProjectQuery(projectId, ["nav", "collaboration"], () => request<{ deliveries: Listed; incoming: Listed }>(token, `/api/projects/${encodeURIComponent(projectId)}/collaboration`, 15000),
    { enabled: on && !!token, retry: false });
  const hidden = new Set<Section>();
  if (none(evaluations.data as Listed | undefined)) hidden.add("evaluations");
  if (none(discussions.data as Listed | undefined)) hidden.add("discussions");
  if (none(receipts.data?.deliveries) && none(receipts.data?.incoming)) hidden.add("collaboration");
  return hidden;
}
