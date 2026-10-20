import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";

const absolute = z.string().min(1).max(1024).regex(/^\//);
const grant = z.strictObject({
  projectId: z.uuid(), actorId: z.string().min(1).max(100), roleId: z.string().min(1).max(4000),
  authorizationScope: z.string().min(1).max(4000), cwd: absolute,
  sandbox: z.enum(["read-only", "workspace-write"]),
});
export type RuntimeGrant = z.infer<typeof grant>;
const integrationSchema = z.strictObject({
  repositories: z.array(z.strictObject({ projectId:z.uuid(), repositoryId:z.string().min(1).max(100), root:absolute, allowedPaths:z.array(z.string().min(1).max(1024)).min(1).max(200) })).max(200).default([]),
  feishu: z.strictObject({
    enabled: z.boolean(), appId: z.string().min(1), appSecret: z.string().min(1), appToken: z.string().min(1), tableId: z.string().min(1),
    fields: z.strictObject({ entityId: z.string().min(1), localVersion: z.string().min(1), operationId: z.string().min(1), title: z.string().min(1), status: z.string().min(1) }),
    grants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), scope: z.literal("project") })).max(200),
    pollEnabled: z.boolean().default(false), pollIntervalMs: z.number().int().min(30000).max(86400000).default(60000),
  }).optional(),
  knowledge: z.strictObject({
    enabled: z.boolean(), baseUrl: z.url(), manifestRoot: absolute, maintainerId: z.string().min(1).max(100), projectIds: z.array(z.uuid()).max(200),
  }).optional(),
  scheduling: z.strictObject({
    enabled: z.boolean(), grants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), scopeId: z.string().min(1).max(4000), roleId: z.string().min(1).max(4000) })).max(200),
  }).optional(),
  runtime: z.strictObject({
    enabled: z.boolean(), executable: absolute.optional(),
    grants: z.array(grant).max(200),
  }).optional(),
});
export async function loadIntegrations(path?: string) {
  let configuration: z.infer<typeof integrationSchema>;
  try { configuration = integrationSchema.parse(path ? JSON.parse(await readFile(path, "utf8")) : {}); }
  catch { throw new Error("Invalid integration configuration: check the external file and schema; values are not logged."); }
  const runtime = configuration.runtime;
  const grants = runtime?.enabled ? runtime.grants : [];
  const allowedRuntimeCwds = (projectId: string): string[] => [...new Set(grants.filter(g => g.projectId === projectId).map(g => g.cwd))];
  const hasRuntimeGrant = (scope: RuntimeGrant): boolean => grants.some(g =>
    g.projectId === scope.projectId && g.actorId === scope.actorId && g.roleId === scope.roleId &&
    g.authorizationScope === scope.authorizationScope && g.cwd === scope.cwd && g.sandbox === scope.sandbox);
  const allowedRuntimeCwd = async (projectId: string, cwd: string): Promise<boolean> => {
    if (!allowedRuntimeCwds(projectId).includes(cwd)) return false;
    try { return await realpath(cwd) === cwd; } catch { return false; }
  };
  return { runtime, repositories: configuration.repositories, feishu: configuration.feishu, knowledge: configuration.knowledge, scheduling: configuration.scheduling, allowedRuntimeCwds, allowedRuntimeCwd, hasRuntimeGrant };
}
