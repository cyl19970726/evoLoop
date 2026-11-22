// Pages with nothing to show do not take a place in the menu (the decision on 空页面不占菜单, kept by the navigation cleanup): an optional section is listed
// only when its own list was read and has records. A read that has not finished or failed lists nothing, and the page a reader is on stays listed.
import type { Section } from "./routes";
import { api, request } from "./api";
import { useProjectQuery } from "./query";

type Listed = { items?: unknown[] };
const some = (value: Listed | undefined) => !!value && Array.isArray(value.items) && value.items.length > 0;

export function usePresentSections(projectId: string, token: string, enabled: boolean): ReadonlySet<Section> {
  const on = enabled && !!projectId;
  const discussions = useProjectQuery(projectId, ["nav", "discussions"], () => api().discussions(projectId), { enabled: on, retry: false });
  const receipts = useProjectQuery(projectId, ["nav", "collaboration"], () => request<{ deliveries: Listed; incoming: Listed }>(token, `/api/projects/${encodeURIComponent(projectId)}/collaboration`, 15000),
    { enabled: on && !!token, retry: false });
  const present = new Set<Section>();
  if (some(discussions.data as Listed | undefined)) present.add("discussions");
  if (some(receipts.data?.deliveries) || some(receipts.data?.incoming)) present.add("collaboration");
  return present;
}
