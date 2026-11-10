// Who recorded something, as every page says it (docs/frontend/principles.md 原始标识放在来源层). An account name from
// the identity file (lead, zhang-reviewer) is a name people read and stays as written. An identity known only by an
// identifier is never written into the text, whole or shortened: a UUID is “未登记名称的身份”, a coordinator worker
// credential (`worker-<UUID>`, issued per automatic run) is “自动执行方”, a schedule (`schedule:<role>`) is “日程”;
// their full value goes to 完整标识 (`actorIdentifier`, `actorRow`). Pure, so every page and its tests agree.

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ActorKind = "missing" | "me" | "account" | "worker" | "schedule" | "opaque";

/** What kind of identity an actor ID is. `me` is the reader, when the page says “我” for them. */
export function actorKind(actorId: string | null | undefined, me?: string): ActorKind {
  const value = actorId?.trim() ?? "";
  if (!value) return "missing";
  if (me && value === me) return "me";
  if (/^worker-/i.test(value)) return "worker";
  if (/^schedule:/i.test(value)) return "schedule";
  return uuid.test(value) ? "opaque" : "account";
}

/** The actor in the text: 我, the account name, 自动执行方, 日程 or 未登记名称的身份 (未记录 when there is none). */
export function actorText(actorId: string | null | undefined, me?: string): string {
  switch (actorKind(actorId, me)) {
    case "missing": return "未记录";
    case "me": return "我";
    case "worker": return "自动执行方";
    case "schedule": return "日程";
    case "opaque": return "未登记名称的身份";
    case "account": return actorId!.trim();
  }
}

/** The full value to keep under 完整标识 when `actorText` does not write it, or null. */
export function actorIdentifier(actorId: string | null | undefined, me?: string): string | null {
  const kind = actorKind(actorId, me);
  return kind === "worker" || kind === "schedule" || kind === "opaque" ? actorId!.trim() : null;
}

/** A 完整标识 row for an actor: empty (left out by FullIdentifiers) when the text already names them. */
export const actorRow = (label: string, actorId: string | null | undefined, me?: string) => ({ label, value: actorIdentifier(actorId, me) });
