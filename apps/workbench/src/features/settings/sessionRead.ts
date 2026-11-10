// The signed-in identity and its permissions, read again for 项目设置 (/api/session, with the identity in
// shared/identity.ts). The shell keeps the identity read at login; the page reads it again under one project key, so a
// write in the project rereads it. Capabilities come per project from GET /capabilities (仓库规范), not from here.
import { api, type Session } from "../../shared/api";

export const sessionKey = ["session"] as const;

export async function readSession(): Promise<Session> {
  const value = await api().session();
  const principal = value?.principal;
  if (!principal || typeof principal.actorId !== "string" || !principal.actorId
    || !Array.isArray(principal.permissions) || !Array.isArray(principal.projectIds)) throw new Error("身份响应不完整");
  return { principal, capabilities: value.capabilities && typeof value.capabilities === "object" ? value.capabilities : {} };
}
