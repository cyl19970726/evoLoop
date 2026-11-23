// 知识空间 takes a place in the menu only once the project has a knowledge backend. The signal is the service's own judgment of the project
// (`GET /projects/:id/capabilities`, the key `knowledge`, the same rule the knowledge routes use), so a project without a backend is answered with
// a 200 and no page carries a refused request or a console error for it. Only an explicit "configured" lists it; "not configured", an unknown
// state, a failed read or a read that has not finished lists nothing.
// Kept free of the page's own modules: the shell loads this on every page, so it only touches the small shared reads.
import type { ProjectCapabilitiesView } from "../../shared/api";
import { useProjectCapabilities } from "../../shared/projectConfiguration";

export const knowledgeConfiguredIn = (view: ProjectCapabilitiesView): boolean =>
  view.status === "available" && view.items.some(item => item.key === "knowledge" && item.state === "configured");

export function useKnowledgeConfigured(projectId: string, enabled: boolean): boolean {
  const read = useProjectCapabilities(projectId, { enabled: enabled && !!projectId, retry: false });
  return !!read.data && knowledgeConfiguredIn(read.data);
}
