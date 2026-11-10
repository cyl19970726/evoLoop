// An agent's name on a page (docs/frontend/principles.md 原始标识放在来源层). When nobody registered a name the
// service generates a title: for an external chat “<职责> · 外部 0aba35cb” (the first eight characters of its
// identifier), for a project-run agent its role's title, or the role's identifier when the role has none. A registered
// name is used as written, unless it is only that generated title saved back. A generated title is said without
// identifiers (“功能开发 · 外部接入的智能体”); the generated title itself belongs in 完整标识. Several agents of one role
// then share a name: a list tells them apart by what the service records (when the external connection was last
// written, when a project-run agent last progressed) and, where the names still collide, by the short identifier as
// secondary text. Pure, so every page that names an agent can use it.

export interface AgentNameSource {
  /** `owned:<id>` or `external:<id>`; its identifier gives the short form that tells same-named agents apart. */
  key?: string;
  title: string;
  kind: "owned" | "external";
  profile?: { displayName?: string | null } | null;
  roles?: ReadonlyArray<{ title: string }>;
  /** A project-run agent's latest business run; the service gives none for an external agent. */
  lastProgressAt?: string | null;
  /** For an external agent, when its connection record was last written (registered or verified). */
  metadata?: { sourceObservedAt?: string | null } | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The service's generated external title: `<role or 外部会话> · 外部 <8 hex>`. */
const generatedExternal = /^(.*?)\s*·\s*外部\s+[0-9a-f]{8}$/i;
const generated = (value: string) => !value || generatedExternal.test(value) || uuid.test(value);

function roleOf(source: AgentNameSource, fromTitle?: string): string {
  const named = fromTitle?.trim();
  if (named && named !== "外部会话" && !uuid.test(named)) return named;
  return source.roles?.find(role => role.title?.trim())?.title.trim() ?? "";
}

/** Whether the page's name is generated rather than registered (so it says only what kind of agent this is). */
export function agentNameIsGenerated(source: AgentNameSource): boolean {
  const registered = source.profile?.displayName?.trim();
  if (registered) return generated(registered);
  return generated(source.title?.trim() ?? "");
}

/** The name to show: the registered name, the title, or for a generated one its role and kind. */
export function agentDisplayName(source: AgentNameSource): string {
  const title = source.profile?.displayName?.trim() || source.title?.trim() || "";
  if (!agentNameIsGenerated(source)) return title;
  const role = roleOf(source, generatedExternal.exec(title)?.[1]);
  const kind = source.kind === "external" ? "外部接入的智能体" : "受管智能体";
  // The role first: a narrow list that cuts the name still shows which role it is.
  return role ? `${role} · ${kind}` : kind;
}

/** The first eight characters of the agent's identifier, as the service's generated title writes them. */
export function agentShortId(source: AgentNameSource): string | null {
  const id = source.key?.slice(source.key.indexOf(":") + 1) ?? "";
  return id ? id.slice(0, 8) : null;
}

/**
 * What the service records that tells agents of a generated name apart: for an external agent when its connection
 * record was last written, for a project-run agent when it last progressed. `time` writes an instant as the page does.
 */
export function agentNameHint(source: AgentNameSource, time: (iso: string) => string): string | null {
  if (!agentNameIsGenerated(source)) return null;
  if (source.kind === "external") {
    const at = source.metadata?.sourceObservedAt;
    return at ? `接入更新于 ${time(at)}` : "接入时间未记录";
  }
  return source.lastProgressAt ? `最近活动 ${time(source.lastProgressAt)}` : "最近活动未记录";
}

/** For agents whose shown names collide in one list: their short identifiers, by key, to add as secondary text. */
export function agentNameCollisions(sources: readonly AgentNameSource[]): Map<string, string> {
  const byName = new Map<string, AgentNameSource[]>();
  for (const source of sources) {
    const name = agentDisplayName(source);
    byName.set(name, [...(byName.get(name) ?? []), source]);
  }
  const result = new Map<string, string>();
  for (const group of byName.values()) {
    if (new Set(group.map(source => source.key)).size < 2) continue;
    for (const source of group) {
      const short = agentShortId(source);
      if (source.key && short) result.set(source.key, short);
    }
  }
  return result;
}
