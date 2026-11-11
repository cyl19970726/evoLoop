/**
 * What `session prepare` says when a managed Session cannot be created yet. The service reports short codes in
 * `missing`; this turns each configuration-related code into the private-configuration key to set, a fix that can be
 * copied, and when the change takes effect — so nobody has to read the source to learn what is absent.
 * (The same list is the checklist in docs/development/agent-cli.md; test/session-preparation-hints.test.ts keeps both honest.)
 */
export type SessionPreparationReread = "per_call" | "startup" | "not_configuration";

export interface SessionPreparationHint {
  /** The code in `missing`. */
  code: string;
  /** The private integrations-file key (or request field) that fixes it; null when it is state, not configuration. */
  setting: string | null;
  problem: string;
  fix: string;
  /** A JSON entry to add, with this request's identifiers filled in and placeholders where the request cannot know them. */
  example?: unknown;
  /** per_call: `session prepare` reads the file again on every call, so no restart is needed to see the change. */
  reread: SessionPreparationReread;
}

/** Why no Role→actor mapping could be used, as the service found it. */
export type RoleActorState = "ready" | "queue_disabled" | "no_entry" | "actor_not_project_writer";

export interface SessionPreparationHintContext {
  projectId: string;
  roleId: string;
  /** The Session's own actor (the caller of `session prepare`). */
  sessionActorId?: string | null;
  authorizationScope?: string | null;
  cwd?: string | null;
  model?: string | null;
  /** The Role→actor entry as found in `residentQueue.roleActors`, even when it cannot be used. */
  roleActorState?: RoleActorState | null;
  roleActorConfiguredId?: string | null;
  /** The actor of the matching `runtime.materialCli` entry, when there is one. */
  materialCliActorId?: string | null;
  /** The usable Role actor. */
  roleActorId?: string | null;
}

/** The codes that are private configuration; every other code in `missing` describes Session or Role state. */
export const sessionPreparationConfigurationCodes = [
  "runtime_unavailable", "runtime_grant", "model_not_authorized", "cwd", "role_actor", "material_cli", "material_cli_incompatible",
  "material_cli_actor_mismatch", "role_skill",
] as const;

/**
 * Every private-configuration key an organization needs before `session prepare` can succeed. The docs list exactly
 * these; a test reads the docs and fails when one is missing there.
 */
export const sessionPreparationChecklist: ReadonlyArray<{ setting: string; reread: SessionPreparationReread; purpose: string }> = [
  { setting: "auth 身份文件", reread: "per_call", purpose: "业务身份存在，并对本项目有 read 与 write" },
  { setting: "runtime.enabled", reread: "startup", purpose: "服务启动时已启用运行时" },
  { setting: "runtime.grants", reread: "per_call", purpose: "该 Session 的执行授权：项目、Session 身份、Role、授权范围、工作目录" },
  { setting: "runtime.grants[].cwd", reread: "per_call", purpose: "工作区：授权里的 cwd 须是规范绝对路径（与 realpath 一致），请求的 cwd 必须与之相同" },
  { setting: "runtime.materialCli", reread: "per_call", purpose: "Role 级 CLI 绑定：Session 身份 → 该 Role 的业务身份与 CLI 命令" },
  { setting: "residentQueue.roleActors", reread: "per_call", purpose: "Role → 业务身份映射（须与 materialCli 的 cliActorId 一致）" },
  { setting: "residentQueue.enabled", reread: "per_call", purpose: "打开常驻队列，Role 映射才生效" },
  { setting: "sessionMessages.grants", reread: "per_call", purpose: "消息授权：发送者、接收者 Session、工作目录与次数；session prepare 不检查，但别人给该 Session 发普通消息要它" },
  { setting: "runtime.roleSkills", reread: "per_call", purpose: "Role 的业务 skill 路径，缺省为项目业务 skill" },
];

const entry = (c: SessionPreparationHintContext, extra: Record<string, unknown>) => ({ projectId: c.projectId, roleId: c.roleId, ...extra });

/** Hints for the given `missing` codes, in the same order; a code that is not configuration still gets a one-line pointer. */
export function sessionPreparationHints(missing: readonly string[], context: SessionPreparationHintContext): SessionPreparationHint[] {
  const actor = context.roleActorConfiguredId ?? context.roleActorId ?? "<该 Role 的业务身份 actorId>";
  const hint = (code: string): SessionPreparationHint => {
    switch (code) {
      case "role_actor": {
        const state = context.roleActorState ?? "no_entry";
        const base = { code, setting: "residentQueue.roleActors", reread: "per_call" as const,
          example: { residentQueue: { enabled: true, roleActors: [entry(context, { actorId: actor })] } } };
        if (state === "queue_disabled") return { ...base, setting: "residentQueue.enabled",
          problem: "residentQueue 未启用（或没有 residentQueue 配置），所以 residentQueue.roleActors 里的 Role→actor 映射不被采用。",
          fix: "在私有 integrations 文件把 residentQueue.enabled 设为 true，并在 residentQueue.roleActors 里有这个 Role 的一项。保存后再次 session prepare；该配置每次调用重读，不需要重启。" };
        if (state === "actor_not_project_writer") return { ...base,
          problem: `residentQueue.roleActors 里已有这个 Role 的映射（actorId=${context.roleActorConfiguredId ?? "?"}），但该身份在 auth 身份文件里对本项目没有 read 与 write，所以不被采用。`,
          fix: "在 auth 身份文件里给这个 actorId 加上本项目的 read 与 write（身份文件每次调用重读；新增 HTTP 令牌仍要重启才被服务认可），或把映射改成已有写权限的 actorId。" };
        return { ...base,
          problem: "residentQueue.roleActors 里没有这个 Role 的映射（projectId + roleId → 业务身份 actorId）。",
          fix: "在私有 integrations 文件的 residentQueue.roleActors 数组里加一项 { projectId, roleId, actorId }（见 example），actorId 与该 Role 的 runtime.materialCli 里的 cliActorId 必须一致，并保证 residentQueue.enabled 为 true。保存后再次 session prepare；每次调用重读，不需要重启。" };
      }
      case "material_cli":
        return { code, setting: "runtime.materialCli", reread: "per_call",
          problem: "runtime.materialCli 里没有匹配这个 Session 或 Role 的绑定（或 runtime 未启用）。",
          fix: "在 runtime.materialCli 数组加一项：Role 级 { projectId, roleId, sessionActorId, cliActorId, command }，其中 sessionActorId 是调用 session prepare 的身份，cliActorId 是该 Role 的业务身份（须等于 residentQueue.roleActors 里的 actorId），command 是该身份 CLI 包装脚本的绝对路径。每次调用重读，不需要重启。",
          example: { runtime: { materialCli: [entry(context, { sessionActorId: context.sessionActorId ?? "<Session 身份>", cliActorId: actor, command: "/absolute/path/to/<该身份>/evoloop" })] } } };
      case "material_cli_incompatible":
        return { code, setting: "runtime.materialCli", reread: "per_call",
          problem: "runtime.materialCli 绑定的 command 不支持固定首包（handoff）读取，或其身份与项目不符。",
          fix: "升级该 CLI 包装脚本到当前构建，并确认它绑定的 actorId 就是 cliActorId；改后再次 session prepare，不需要重启。" };
      case "material_cli_actor_mismatch":
        return { code, setting: "runtime.materialCli / residentQueue.roleActors", reread: "per_call",
          problem: `runtime.materialCli 的 cliActorId（${context.materialCliActorId ?? "?"}）与 residentQueue.roleActors 的 actorId（${context.roleActorId ?? "?"}）不一致；同一个“这个 Role 由谁执行”写了两处，必须相同。`,
          fix: "把两处改成同一个业务 actorId（二者每次调用重读，不需要重启）。" };
      case "runtime_grant":
        return { code, setting: "runtime.grants", reread: "per_call",
          problem: "没有与本次请求完全一致的运行时授权（项目、Session 身份、Role、授权范围、工作目录；全权限、never）。",
          fix: "在 runtime.grants 加一项与请求一致的授权（见 example）；工作目录须是已授权目录。每次调用重读；但 runtime 的启用与执行配置以服务启动时读到的为准，若服务启动时 runtime.enabled 是 false，仍须重启。",
          example: { runtime: { grants: [{ projectId: context.projectId, actorId: context.sessionActorId ?? "<Session 身份>", roleId: context.roleId, authorizationScope: context.authorizationScope ?? "<授权范围>", cwd: context.cwd ?? "<绝对路径>", sandbox: "danger-full-access", approvalPolicy: "never" }] } } };
      case "model_not_authorized":
        return { code, setting: "runtime.grants", reread: "per_call",
          problem: `运行时授权存在，但不允许所选模型${context.model ? `（${context.model}）` : ""}。`,
          fix: "换成授权允许的模型 slug，或在该授权项里加入这个模型。每次调用重读，不需要重启。" };
      case "cwd":
        return { code, setting: "runtime.grants", reread: "per_call",
          problem: `工作目录${context.cwd ? `（${context.cwd}）` : ""}不是已授权目录，或不是规范绝对路径（含符号链接）。`,
          fix: "用 runtime.grants 里已有的 cwd，或给这个 cwd 加授权；路径须与 realpath 一致。每次调用重读，不需要重启。" };
      case "runtime_unavailable":
        return { code, setting: "runtime.enabled", reread: "startup",
          problem: "服务当前没有可用的运行时。",
          fix: "在私有 integrations 文件把 runtime.enabled 设为 true 并配好运行时，然后重启 coordinator（启用状态只在启动时读取）。" };
      case "role_skill":
        return { code, setting: "runtime.roleSkills", reread: "per_call",
          problem: "没有可读的业务 skill（默认读 .agents/skills/evoloop-workflow/SKILL.md）。",
          fix: "确认仓库里有该 skill 文件，或在 runtime.roleSkills 为这个 Role 列出 .agents/skills/<name>/SKILL.md 路径。每次调用重读，不需要重启。" };
      case "model_selection_required":
        return { code, setting: null, reread: "not_configuration",
          problem: "新建 Session 需要精确的模型 slug。", fix: "先 `models --project UUID` 查可用模型，把其中一个写进准备文件的 model。这不是私有配置。" };
      case "role_inactive":
        return { code, setting: null, reread: "not_configuration",
          problem: "这个 Role 不是 trial 或 active。", fix: "先用 role.decide 接受试行（或等待决定）；这不是私有配置。" };
      default:
        return { code, setting: null, reread: "not_configuration",
          problem: "这是 Session 或 Role 当前状态，不是缺私有配置。", fix: "读 `read session UUID --recovery`、docs/development/agent-cli.md 的“准备或复用受管 Session”，按状态处理。" };
    }
  };
  return missing.map(hint);
}
