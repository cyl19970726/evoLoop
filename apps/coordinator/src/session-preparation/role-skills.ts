import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decideSkill, selfModifyingBuiltinSkills, skillSources, type RoleSkillSelection, type SkillReason, type SkillSource } from "@evoloop/contracts/role-skills";
import type { RuntimeCapabilityListing, RuntimeSkillPlan } from "@evoloop/contracts/runtime";
import { skillPlanHash, skillPluginManifest, verifySkillPlan } from "@evoloop/adapter-claude-agent-sdk";

/**
 * Which skills a Role can have and how each runtime is told about the selection.
 *
 * Skills are found on disk every time: evoLoop business skills from this repository, project skills from the
 * work directory up to its repository root, personal skills from the user's own directories. Nothing is copied
 * or pinned: Claude gets local plugins whose entries link to the skill directories, Codex gets a Thread-level
 * list of the skills it found that the Role does not use. This chooses what a runtime loads into the model's
 * context; it is not a security boundary.
 */
export type FileSkillSource = Exclude<SkillSource, "builtin">;
export interface DiscoveredSkill {
  name: string;
  source: FileSkillSource;
  description: string | null;
  /** Shown location: repository-relative for business and project skills, `~/…` for personal ones. */
  location: string;
  /** Real path of the skill directory. */
  dir: string;
  /** sha256 of SKILL.md as read now. */
  contentHash: string;
  /** A project skill under `.claude/skills`, which Claude reads by itself when it reads project settings. */
  claudeNative: boolean;
  /**
   * Names under which a project `.claude/skills` entry links to this same skill (a repository may link `.claude/skills`
   * to `.agents/skills`): in project context mode Claude also finds it natively under these names.
   */
  claudeNativeAliases?: string[];
}
export interface SkillRoots {
  /** Repository that holds the business skills. */
  businessRoot: string;
  /** Business SKILL.md paths relative to businessRoot (`.agents/skills/<name>/SKILL.md`). */
  businessPaths: readonly string[];
  /** Work directory of the Role's Sessions; null reads no project skills. */
  cwd: string | null;
  home: string;
}

const businessPath = /^\.agents\/skills\/([A-Za-z0-9_-]+)\/SKILL\.md$/;
const skillName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_PER_DIRECTORY = 128;
const MAX_SKILLS = 256;
const MAX_SKILL_FILE = 1024 * 1024;
const MAX_LEVELS = 32;
const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** `name` and `description` from a leading `---` block; block scalars are folded into one line. */
export function skillFrontmatter(text: string): { name: string | null; description: string | null } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };
  const values: Record<string, string> = {};
  for (let index = 1; index < lines.length && index < 400; index++) {
    const line = lines[index]!;
    if (line.trim() === "---") break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^[|>][+-]?$/.test(value) || value === "") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) block.push(lines[++index]!.trim());
      value = block.join(" ");
    }
    values[match[1]!] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  const description = values.description?.trim() ? values.description.trim().slice(0, 500) : null;
  return { name: values.name?.trim() || null, description };
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false);
}

/** Nearest ancestor with `.git` (directory or file), else null. */
async function repositoryRoot(cwd: string): Promise<string | null> {
  let current = cwd;
  for (let level = 0; level < MAX_LEVELS; level++) {
    if (await lstat(join(current, ".git")).then(() => true, () => false)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Skills under the work directory, then personal ones; business skills first. First by real path wins. */
export async function discoverSkills(roots: SkillRoots): Promise<{ skills: DiscoveredSkill[]; notes: string[] }> {
  const skills: DiscoveredSkill[] = [];
  const notes: string[] = [];
  const seenDirs = new Set<string>();
  const seenNames = new Set<string>();
  const add = async (source: FileSkillSource, path: string, location: string, claudeNative: boolean, fallbackName: string) => {
    if (skills.length >= MAX_SKILLS) return;
    let dir: string, data: Buffer;
    try {
      dir = await realpath(path);
      const file = join(dir, "SKILL.md");
      const info = await stat(file);
      if (!info.isFile()) return;
      if (info.size > MAX_SKILL_FILE) { notes.push(`${location}: SKILL.md 超过 1 MiB，未读取`); return; }
      data = await readFile(file);
    } catch { return; }
    const front = skillFrontmatter(data.toString("utf8"));
    const name = front.name && skillName.test(front.name) ? front.name : skillName.test(fallbackName) ? fallbackName : null;
    if (!name) { notes.push(`${location}: skill 名称不可用`); return; }
    if (seenDirs.has(dir)) {
      // A project `.claude/skills` link to a skill already found: Claude reads that copy too.
      const first = claudeNative ? skills.find(item => item.dir === dir && !item.claudeNative) : undefined;
      if (first && !first.claudeNativeAliases?.includes(name)) first.claudeNativeAliases = [...first.claudeNativeAliases ?? [], name];
      return;
    }
    if (seenNames.has(`${source}:${name}`)) return;
    seenDirs.add(dir); seenNames.add(`${source}:${name}`);
    skills.push({ name, source, description: front.description, location, dir, contentHash: sha256(data), claudeNative });
  };
  const scan = async (source: FileSkillSource, directory: string, shown: (name: string) => string, claudeNative: boolean) => {
    let entries: string[];
    try { entries = (await readdir(directory)).filter(name => !name.startsWith(".")).sort(); }
    catch { return; }
    if (entries.length > MAX_PER_DIRECTORY) notes.push(`${shown("")}: 超过 ${MAX_PER_DIRECTORY} 项，只读取前 ${MAX_PER_DIRECTORY} 项`);
    for (const name of entries.slice(0, MAX_PER_DIRECTORY))
      if (await isDirectory(join(directory, name))) await add(source, join(directory, name), shown(name), claudeNative, name);
  };

  for (const path of roots.businessPaths) {
    const match = businessPath.exec(path);
    if (!match) { notes.push(`业务 skill 路径无效：${path}`); continue; }
    const before = skills.length;
    await add("evoloop", join(roots.businessRoot, dirname(path)), dirname(path), false, match[1]!);
    if (skills.length === before && !seenNames.has(`evoloop:${match[1]}`)) notes.push(`业务 skill 不存在：${dirname(path)}`);
  }
  if (roots.cwd) {
    if (!isAbsolute(roots.cwd) || resolve(roots.cwd) !== roots.cwd) notes.push("工作目录不是规范的绝对路径，未读取项目 skill");
    else {
      const top = await repositoryRoot(roots.cwd);
      const levels: string[] = [];
      for (let current = roots.cwd; levels.length < MAX_LEVELS; current = dirname(current)) {
        levels.push(current);
        if (!top || current === top || dirname(current) === current) break;
      }
      const base = top ?? roots.cwd;
      for (const level of levels) {
        for (const [folder, native] of [[".agents/skills", false], [".claude/skills", true]] as const) {
          const directory = join(level, folder);
          await scan("project", directory, name => relative(base, join(directory, name)) || ".", native);
        }
      }
    }
  }
  for (const folder of [".agents/skills", ".claude/skills"]) {
    const directory = join(roots.home, folder);
    await scan("personal", directory, name => `~${sep}${relative(roots.home, join(directory, name))}`, false);
  }
  return { skills, notes };
}

export interface SkillDecision { selected: boolean; reason: SkillReason }
export const decideDiscovered = (skill: DiscoveredSkill, selection: RoleSkillSelection): SkillDecision =>
  decideSkill({ name: skill.name, source: skill.source }, selection);

/** Bare names the selection turns off among skills a runtime ships with. */
function builtinOff(selection: RoleSkillSelection, known: readonly string[]): string[] {
  const names = new Set<string>();
  for (const name of known) if (!decideSkill({ name, source: "builtin" }, selection).selected) names.add(name);
  for (const reference of selection.remove) {
    const colon = reference.indexOf(":");
    const prefix = colon > 0 ? reference.slice(0, colon) : "";
    if (prefix === "builtin") names.add(reference.slice(colon + 1));
    else if (!(skillSources as readonly string[]).includes(prefix)) names.add(reference);
  }
  return [...names];
}

export type ClaudePlanContent = Pick<RuntimeSkillPlan, "off" | "builtin"> &
  { plugins: Array<{ name: RuntimeSkillPlan["plugins"][number]["name"]; skills: Array<{ name: string; target: string }> }> };

/**
 * Claude: each selected skill is linked into the plugin of its source. In project context mode the CLI reads
 * `.claude/skills` itself, so those are not linked; the unselected ones are turned off by name instead. A
 * `.claude/skills` link to a skill found elsewhere is always turned off by name, so the plugin is its one path.
 */
export function claudePlanContent(skills: readonly DiscoveredSkill[], selection: RoleSkillSelection,
  contextMode: "project" | "explicit", builtinNames: readonly string[] = selfModifyingBuiltinSkills): ClaudePlanContent {
  const linked = new Map<FileSkillSource, Array<{ name: string; target: string }>>();
  const off = new Set(builtinOff(selection, builtinNames));
  for (const skill of skills) {
    const { selected } = decideDiscovered(skill, selection);
    const native = contextMode === "project" && skill.claudeNative;
    if (native) { if (!selected) off.add(skill.name); continue; }
    if (contextMode === "project") for (const alias of skill.claudeNativeAliases ?? []) off.add(alias);
    if (!selected) continue;
    const list = linked.get(skill.source) ?? [];
    if (!list.some(item => item.name === skill.name)) list.push({ name: skill.name, target: skill.dir });
    linked.set(skill.source, list);
  }
  const plugins = (["evoloop", "project", "personal"] as const).filter(name => linked.get(name)?.length)
    .map(name => ({ name, skills: linked.get(name)!.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }));
  return { plugins, off: [...off].sort(), builtin: selection.builtin };
}

/**
 * Writes `<pluginRoot>/<planHash>/<source>/` (manifest plus one link per skill) once per plan and returns the
 * plan. An existing directory is reused only when it matches; an altered one is rewritten.
 */
export async function materializeSkillPlan(pluginRoot: string, content: ClaudePlanContent): Promise<RuntimeSkillPlan> {
  if (!isAbsolute(pluginRoot) || resolve(pluginRoot) !== pluginRoot) throw new Error("Skill plugin root must be an absolute normalized path");
  const planHash = skillPlanHash(content);
  const planDir = join(pluginRoot, planHash);
  const plan: RuntimeSkillPlan = { planHash, off: content.off, builtin: content.builtin,
    plugins: content.plugins.map(plugin => ({ ...plugin, root: join(planDir, plugin.name) })) };
  if (!plan.plugins.length || await verifySkillPlan(plan)) return plan;
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  const staging = join(pluginRoot, `.staging-${randomUUID()}`);
  try {
    for (const plugin of plan.plugins) {
      const root = join(staging, plugin.name);
      await mkdir(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
      await mkdir(join(root, "skills"), { mode: 0o700 });
      await writeFile(join(root, ".claude-plugin", "plugin.json"), skillPluginManifest(plugin.name, planHash), { mode: 0o444, flag: "wx" });
      for (const skill of plugin.skills) await symlink(skill.target, join(root, "skills", skill.name));
    }
    try { await rename(staging, planDir); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // Another Turn wrote the same plan first; a directory that no longer matches is replaced (links are
      // removed, never followed).
      if (!await verifySkillPlan(plan)) {
        await rm(planDir, { recursive: true, force: true });
        await rename(staging, planDir);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!await verifySkillPlan(plan)) throw new Error("Skill plugin directory could not be written");
  return plan;
}

const codexScopeSource = { repo: "project", user: "personal", system: "builtin", admin: "builtin" } as const;

/** Source of a skill Codex listed: a business skill by its directory, otherwise by Codex scope. */
export function codexSkillSource(skill: RuntimeCapabilityListing["skills"][number], businessDirs: ReadonlySet<string>): SkillSource {
  return businessDirs.has(dirname(skill.path)) ? "evoloop" : codexScopeSource[skill.scope];
}

/**
 * Codex: the skills it lists that the Role does not use are turned off by path for the Thread; without
 * built-ins the bundled ones are turned off too. When Codex cannot list, the files found here stand in for
 * its project and personal skills and self-modifying built-ins are turned off by name.
 */
export function codexSkillConfig(input: { selection: RoleSkillSelection; listed: RuntimeCapabilityListing["skills"] | null;
  discovered: readonly DiscoveredSkill[]; businessDirs: ReadonlySet<string> }): Record<string, unknown> | undefined {
  const entries: Array<{ path: string; enabled: false } | { name: string; enabled: false }> = [];
  if (input.listed) {
    const paths = input.listed.filter(skill => !decideSkill({ name: skill.name, source: codexSkillSource(skill, input.businessDirs) },
      input.selection).selected).map(skill => skill.path);
    for (const path of [...new Set(paths)].sort()) entries.push({ path, enabled: false });
  } else {
    const paths = input.discovered.filter(skill => !decideDiscovered(skill, input.selection).selected).map(skill => join(skill.dir, "SKILL.md"));
    for (const path of [...new Set(paths)].sort()) entries.push({ path, enabled: false });
    for (const name of builtinOff(input.selection, ["skill-installer"]).sort()) entries.push({ name, enabled: false });
  }
  const config: Record<string, unknown> = {};
  if (entries.length) config["skills.config"] = entries;
  if (!input.selection.builtin) config["skills.bundled.enabled"] = false;
  return Object.keys(config).length ? config : undefined;
}

/** Real paths of the business skill directories, plus their paths as written. */
export async function businessSkillDirs(businessRoot: string, businessPaths: readonly string[]): Promise<Set<string>> {
  const dirs = new Set<string>();
  for (const path of businessPaths) {
    if (!businessPath.test(path)) continue;
    const dir = join(businessRoot, dirname(path));
    dirs.add(dir);
    await realpath(dir).then(real => dirs.add(real), () => undefined);
  }
  return dirs;
}
