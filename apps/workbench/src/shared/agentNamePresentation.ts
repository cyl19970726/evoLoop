// An agent's name on a page (docs/frontend/principles.md 原始标识放在来源层). When nobody registered a name the
// service generates a title: for an external chat “<职责> · 外部 0aba35cb” (the first eight characters of its
// identifier), for a project-run agent its role's title, or the role's identifier when the role has none. A registered
// name is used as written. A generated title is said without identifiers (“功能开发 · 外部接入的智能体”); the
// generated title itself belongs in 完整标识. Pure, so every page that names an agent can use it.

export interface AgentNameSource {
  title: string;
  kind: "owned" | "external";
  profile?: { displayName?: string | null } | null;
  roles?: ReadonlyArray<{ title: string }>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The service's generated external title: `<role or 外部会话> · 外部 <8 hex>`. */
const generatedExternal = /^(.*?)\s*·\s*外部\s+[0-9a-f]{8}$/i;

function roleOf(source: AgentNameSource, fromTitle?: string): string {
  const named = fromTitle?.trim();
  if (named && named !== "外部会话" && !uuid.test(named)) return named;
  return source.roles?.find(role => role.title?.trim())?.title.trim() ?? "";
}

/** Whether the page's name is generated rather than registered (so it says only what kind of agent this is). */
export function agentNameIsGenerated(source: AgentNameSource): boolean {
  if (source.profile?.displayName?.trim()) return false;
  const title = source.title?.trim() ?? "";
  return !title || generatedExternal.test(title) || uuid.test(title);
}

/** The name to show: the registered name, the title, or for a generated one its kind and role. */
export function agentDisplayName(source: AgentNameSource): string {
  const registered = source.profile?.displayName?.trim();
  if (registered) return registered;
  const title = source.title?.trim() ?? "";
  if (!agentNameIsGenerated(source)) return title;
  const role = roleOf(source, generatedExternal.exec(title)?.[1]);
  const kind = source.kind === "external" ? "外部接入的智能体" : "受管智能体";
  // The role first: a narrow list that cuts the name still shows which role it is.
  return role ? `${role} · ${kind}` : kind;
}

/**
 * What tells two agents of the same generated name apart in a list: when it was last active. `formatted` is the
 * time as the page writes it; null when no progress is recorded.
 */
export function agentNameHint(source: AgentNameSource, formatted: string | null): string | null {
  if (!agentNameIsGenerated(source)) return null;
  return formatted ? `最近活动 ${formatted}` : "最近活动未记录";
}
