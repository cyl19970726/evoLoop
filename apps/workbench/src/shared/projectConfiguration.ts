// The project's configuration as the service reads it (contracts.md 项目配置只读): its repositories, the capabilities judged
// for it, and its members. Each is read under one project key, so 仓库规范, the Git registration form and every member
// chooser share one answer, and a write in the project rereads it. `unavailable` is never read as "none".
import { api } from "./api";
import { useProjectQuery } from "./query";

export const configurationKeys = {
  repositories: ["configuration", "repositories"] as const,
  capabilities: ["configuration", "capabilities"] as const,
  members: ["configuration", "members"] as const,
};

export const useProjectRepositories = (projectId: string, options: { enabled?: boolean } = {}) =>
  useProjectQuery(projectId, configurationKeys.repositories, () => api().projectRepositories(projectId), options);

export const useProjectCapabilities = (projectId: string) =>
  useProjectQuery(projectId, configurationKeys.capabilities, () => api().projectCapabilities(projectId));

export const useProjectMembers = (projectId: string, options: { enabled?: boolean } = {}) =>
  useProjectQuery(projectId, configurationKeys.members, () => api().projectMembers(projectId), options);
