import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { skillPlanHash } from "@evoloop/adapter-claude-agent-sdk";
import type { Principal } from "@evoloop/contracts";
import { decideSkill, defaultRoleSkillSelection, missingSkillReferences, type RoleRuntimeSkill, type RoleRuntimeView,
  type RoleSkillSelection } from "@evoloop/contracts/role-skills";
import { sessionProvider, type RuntimeCapabilityListing, type RuntimeObservedCapabilities, type RuntimeProvider,
  type RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { WorkflowService } from "@evoloop/core";
import { businessSkillDirs, claudePlanContent, codexSkillSource, decideDiscovered, discoverSkills, type DiscoveredSkill } from "./role-skills.js";

/**
 * Live answer to "which skills does this Role have now", for the workbench, the CLI and the Agent alike.
 * Nothing is cached: every read finds the files again and asks the running runtime where it can answer.
 */
export interface RoleRuntimeViewDeps {
  service: Pick<WorkflowService, "getRole" | "listRoleRuntimeRevisions" | "runtimeProviderSettings" | "listRuntimeSessions">;
  /** The coordinator's runtimes; absent when it drives none. */
  runtime?: {
    listCapabilitiesFor(provider: RuntimeProvider, cwd: string): Promise<RuntimeCapabilityListing | null>;
    latestObservedCapabilities(session: RuntimeSessionRecord): Promise<RuntimeObservedCapabilities | null>;
  } | undefined;
  /** Work directories the caller is authorized to run this Role in. */
  grantCwds: (projectId: string, actorId: string, roleId: string) => string[];
  /** Business skills the Role always carries and where they live. */
  skillRoots: (projectId: string, roleId: string) => Promise<{ businessRoot: string; businessPaths: readonly string[] }>;
  /** Claude context mode; decides which project skills Claude reads natively. */
  claudeContextMode: "project" | "explicit" | null;
  home?: string;
  now?: () => Date;
}

const claudeDir = /(^|\/)\.claude\/skills\//;
const ownPlugins = new Set(["evoloop", "project", "personal"]);

function fileSkill(skill: DiscoveredSkill, selection: RoleSkillSelection, delivery: (selected: boolean) => RoleRuntimeSkill["delivery"]): RoleRuntimeSkill {
  const decision = decideDiscovered(skill, selection);
  return { name: skill.name, source: skill.source, ...decision, description: skill.description, location: skill.location,
    contentHash: skill.contentHash, delivery: delivery(decision.selected) };
}

/** `~/…` under home, else the path itself; built-in paths are not shown. */
function shownPath(path: string, home: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? `~/${rel.split(sep).join("/")}` : path;
}

const order = { evoloop: 0, project: 1, personal: 2, builtin: 3 } as const;
const sorted = (skills: RoleRuntimeSkill[]) => skills.sort((a, b) => order[a.source] - order[b.source] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export async function roleRuntimeView(deps: RoleRuntimeViewDeps, principal: Principal, projectId: string, roleId: string): Promise<RoleRuntimeView> {
  await deps.service.getRole(principal, projectId, roleId);
  const [history, sessions] = await Promise.all([deps.service.listRoleRuntimeRevisions(principal, projectId, roleId),
    deps.service.listRuntimeSessions(principal, projectId)]);
  const binding = history.at(-1) ?? null;
  const { defaultProvider, availableProviders } = deps.service.runtimeProviderSettings();
  const provider = binding?.provider ?? defaultProvider;
  const selection = binding?.skills ?? defaultRoleSkillSelection();
  const home = deps.home ?? homedir();
  const notes: string[] = [];
  if (!availableProviders.includes(provider)) notes.push(`此协调器当前未驱动 ${provider}，该角色暂不能新建会话。`);

  const own = sessions.filter(session => session.roleId === roleId && sessionProvider(session) === provider)
    .sort((a, b) => b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0);
  const latest = own.find(session => session.state !== "closed") ?? own[0] ?? null;
  const grantCwd = [...new Set(deps.grantCwds(projectId, principal.actorId, roleId))].sort()[0];
  const workDirectory = latest ? { cwd: latest.cwd, source: "session" as const } : grantCwd ? { cwd: grantCwd, source: "grant" as const } : null;
  if (!workDirectory) notes.push("该角色还没有会话或授权目录，未读取项目 skill。");

  const roots = await deps.skillRoots(projectId, roleId);
  const discovery = await discoverSkills({ ...roots, cwd: workDirectory?.cwd ?? null, home });
  notes.push(...discovery.notes);

  let skills: RoleRuntimeSkill[];
  let skillsReportedBy: RoleRuntimeView["skillsReportedBy"] = "files";
  let plugins: RoleRuntimeView["plugins"] = [], mcpServers: RoleRuntimeView["mcpServers"] = [];

  if (provider === "codex") {
    let listing: RuntimeCapabilityListing | null = null;
    if (workDirectory && deps.runtime && availableProviders.includes("codex")) {
      listing = await deps.runtime.listCapabilitiesFor("codex", workDirectory.cwd).catch(() => null);
      if (!listing) notes.push("Codex 暂时无法列出 skill；以下按文件推断，内置 skill 未列出。");
    } else if (selection.builtin) notes.push("内置 skill 由运行中的 Codex 列出；当前按文件推断。");
    // Codex receives the business skills through the Role context unless it lists them itself.
    const business = discovery.skills.filter(skill => skill.source === "evoloop");
    if (listing) {
      skillsReportedBy = "codex.list";
      const businessDirs = await businessSkillDirs(roots.businessRoot, roots.businessPaths);
      const byDir = new Map(discovery.skills.map(skill => [skill.dir, skill]));
      skills = await Promise.all(listing.skills.map(async item => {
        const source = codexSkillSource(item, businessDirs);
        const decision = decideSkill({ name: item.name, source }, selection);
        const dir = dirname(item.path);
        const file = byDir.get(dir) ?? byDir.get(await realpath(dir).catch(() => dir));
        return { name: item.name, source, ...decision, description: item.description ?? file?.description ?? null,
          location: file?.location ?? (source === "builtin" ? null : shownPath(dir, home)), contentHash: file?.contentHash ?? null,
          delivery: decision.selected ? "native" as const : "none" as const };
      }));
      for (const skill of business) if (!skills.some(item => item.source === "evoloop" && item.name === skill.name))
        skills.push(fileSkill(skill, selection, () => "role_context"));
      plugins = listing.plugins ?? [];
      mcpServers = listing.mcpServers ?? [];
      if (listing.errors.length) notes.push(`部分列表未读到：${listing.errors.join("、")}`);
    } else {
      // Without Codex's own list: the `.agents/skills` it reads; `.claude/skills` belong to Claude.
      skills = discovery.skills.filter(skill => skill.source === "evoloop" || !claudeDir.test(skill.location.replace(/^~\//, "")))
        .map(skill => fileSkill(skill, selection, selected => !selected ? "none" : skill.source === "evoloop" ? "role_context" : "native"));
    }
  } else {
    const contextMode = deps.claudeContextMode ?? "project";
    skills = discovery.skills.map(skill => fileSkill(skill, selection, selected =>
      !selected ? "none" : contextMode === "project" && skill.claudeNative ? "native" : "role_context"));
    let observed: RuntimeObservedCapabilities | null = null;
    if (latest && deps.runtime && availableProviders.includes("claude")) {
      try { observed = await deps.runtime.latestObservedCapabilities(latest); }
      catch { notes.push("最近一次 Turn 的加载报告暂不可读；以下按文件推断。"); }
    }
    if (observed) {
      skillsReportedBy = "claude.init";
      const known = new Set(skills.map(skill => skill.name));
      for (const name of observed.discoveredSkills) {
        const colon = name.indexOf(":");
        if ((colon > 0 && ownPlugins.has(name.slice(0, colon))) || known.has(name)) continue;
        known.add(name);
        skills.push({ name, source: "builtin", ...decideSkill({ name, source: "builtin" }, selection), description: null,
          location: null, contentHash: null, delivery: "native" });
      }
      plugins = observed.plugins.map(name => ({ name, enabled: true }));
      mcpServers = observed.mcpServers.map(name => ({ name, auth: null }));
      if (observed.missingSkills.length) notes.push(`最近一次 Turn 未加载：${observed.missingSkills.join("、")}`);
      if (observed.pluginErrors.length) notes.push(`最近一次 Turn 插件加载出错：${observed.pluginErrors.join("、")}`);
      const current = skillPlanHash(claudePlanContent(discovery.skills, selection, contextMode));
      if (observed.planHash && observed.planHash !== current) notes.push("当前 skill 与最近一次 Turn 加载的不同，下一个 Turn 生效。");
    } else if (selection.builtin) notes.push("内置 skill 在该角色的首个 Claude Turn 上报后显示。");
  }

  return { projectId, roleId, binding, history, provider, providerSource: binding ? "binding" : "default",
    availableProviders, providerAvailable: availableProviders.includes(provider), selection,
    selectionSource: binding ? "binding" : "default", workDirectory, skills: sorted(skills),
    missing: missingSkillReferences(selection, skills), skillsReportedBy, plugins, mcpServers, notes,
    observedAtUtc: (deps.now?.() ?? new Date()).toISOString() };
}
