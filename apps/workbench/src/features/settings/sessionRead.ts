// The signed-in identity, its permissions and the server's declared capabilities, read again for this page
// (/api/session, with the identity in shared/identity.ts). The shell keeps the identity read at login; 项目设置 and
// 仓库规范 read it again under one project key, so both show the same answer and a write in the project rereads it.
import { api, type Session } from "../../shared/api";

export const sessionKey = ["session"] as const;

export async function readSession(): Promise<Session> {
  const value = await api().session();
  const principal = value?.principal;
  if (!principal || typeof principal.actorId !== "string" || !principal.actorId
    || !Array.isArray(principal.permissions) || !Array.isArray(principal.projectIds)) throw new Error("身份响应不完整");
  return { principal, capabilities: value.capabilities && typeof value.capabilities === "object" ? value.capabilities : {} };
}
