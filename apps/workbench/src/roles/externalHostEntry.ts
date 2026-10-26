import type { HostLink } from "@evoloop/contracts/resident-hosts";
import type { RoleRecord } from "@evoloop/contracts/roles";

const threadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const threadUri = /^codex:\/\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Canonicalize only a complete Codex thread reference or a historical bare UUID. */
export function codexThreadHref(value: string | null | undefined): string | null {
  const ref = value?.trim();
  if (!ref) return null;
  const id = threadId.test(ref) ? ref : threadUri.exec(ref)?.[1];
  return id ? `codex://threads/${id}` : null;
}

/** A request to open a known local Codex chat, never an arbitrary stored URL. */
export function externalHostOpenHref(host: HostLink, roleState: RoleRecord["state"]): string | null {
  if (host.host.kind !== "external" || host.host.provider !== "codex-desktop"
    || (roleState !== "trial" && roleState !== "active") || host.state !== "verified"
    || !host.verifiedCapabilities.includes("open")) return null;
  return codexThreadHref(host.host.ref);
}

export function externalHostOpenReason(host: HostLink, roleState: RoleRecord["state"], currentRead: boolean): string {
  if (!currentRead) return "承载状态尚未读回为当前；暂不提供打开入口。";
  if (roleState !== "trial" && roleState !== "active") return "职责当前不承接；旧宿主引用仅供核对，不作为当前入口。";
  if (host.state === "revoked") return "宿主已撤权；旧引用仅供历史核对，不作为当前入口。";
  if (host.state !== "verified") return "宿主能力尚未核实；请先人工核对。";
  if (host.host.kind !== "external" || host.host.provider !== "codex-desktop") return "当前宿主类型不支持此打开入口。";
  if (!codexThreadHref(host.host.ref)) return "引用不是完整的 Codex 聊天 URI 或 UUID，不能生成打开入口。";
  if (!host.verifiedCapabilities.includes("open")) return "打开能力未核实；请先人工核对。";
  return "";
}
