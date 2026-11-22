// The provider holds ("运行受阻"), read once under one key: the banner above every page, the 待我处理 count and its runtime-problem
// section all use this read, so the line, the count and the list never disagree.
import { api } from "./api";
import { useProjectQuery } from "./query";

export function useProviderHolds(projectId: string, enabled: boolean) {
  return useProjectQuery(projectId, ["provider-holds"], () => api().providerHolds(projectId), { enabled: enabled && !!projectId, refetchInterval: 30_000 });
}
