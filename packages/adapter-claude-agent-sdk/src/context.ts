import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RuntimeObservedCapabilities, RuntimeSkillPlan } from "@evoloop/contracts/runtime";

/**
 * What one Claude Turn is given besides its prompt: the Role's skill plan (local plugins linking the selected
 * skills, plus the discovered skills it turns off) and, in explicit mode, the project instructions the CLI
 * would otherwise discover itself.
 */
export type ContextMode = "project" | "explicit";
export interface TurnContext {
  mode: ContextMode;
  plan: RuntimeSkillPlan | null;
  /** The plan's skills as the CLI names them (`<plugin>:<skill>`); null when no plan was supplied. */
  allowedSkills: string[] | null;
  instructions: { file: "AGENTS.md" | "CLAUDE.md"; contentHash: string; truncated: boolean; text: string } | null;
}

/** Bounded so one oversized instruction file cannot crowd out the Turn; the rest is reported as truncated. */
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
const pluginOrder = ["evoloop", "project", "personal"] as const;
const safeSkillName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const reportedName = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const MAX_PLAN_SKILLS = 128;
const MAX_OFF = 256;
/**
 * Skills of the plugins built into Claude Code. They stay after `disableBundledSkills`, so a Role without
 * built-ins turns them off by name.
 */
export const CLAUDE_BUILTIN_PLUGIN_SKILLS: readonly string[] = ["design", "doctor", "plugin-authoring"];
const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const sorted = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || values[index - 1]! < value);

/** Hash of what a plan loads: plugin names, link names and targets, `off` and `builtin`. Roots are derived from it. */
export function skillPlanHash(plan: { plugins: ReadonlyArray<{ name: string; skills: ReadonlyArray<{ name: string; target: string }> }>;
  off: readonly string[]; builtin: boolean }): string {
  return sha256(JSON.stringify({ format: 1, builtin: plan.builtin, off: plan.off,
    plugins: plan.plugins.map(plugin => [plugin.name, plugin.skills.map(skill => [skill.name, skill.target])]) }));
}

/** The manifest written for one plugin of a plan; the CLI reads only its name. */
export const skillPluginManifest = (name: string, planHash: string): string =>
  `${JSON.stringify({ name, version: `0.0.0-${planHash.slice(0, 12)}`, description: `evoLoop Role skills (${name})` }, null, 2)}\n`;

/** Canonical form: plugins in source order, skills and `off` sorted and unique, roots `<dir>/<planHash>/<plugin>`. */
export function validSkillPlan(plan: RuntimeSkillPlan): boolean {
  if (!plan || !/^[a-f0-9]{64}$/.test(plan.planHash) || typeof plan.builtin !== "boolean" || !Array.isArray(plan.plugins) ||
    !Array.isArray(plan.off) || plan.off.length > MAX_OFF || !plan.off.every(name => typeof name === "string" && reportedName.test(name)) ||
    !sorted(plan.off)) return false;
  const order = plan.plugins.map(plugin => pluginOrder.indexOf(plugin.name));
  if (order.some(index => index < 0) || !order.every((value, index) => index === 0 || order[index - 1]! < value)) return false;
  if (plan.plugins.reduce((total, plugin) => total + (Array.isArray(plugin.skills) ? plugin.skills.length : MAX_PLAN_SKILLS + 1), 0) > MAX_PLAN_SKILLS)
    return false;
  for (const plugin of plan.plugins) {
    if (typeof plugin.root !== "string" || !isAbsolute(plugin.root) || resolve(plugin.root) !== plugin.root ||
      basename(plugin.root) !== plugin.name || basename(dirname(plugin.root)) !== plan.planHash) return false;
    if (plugin.skills.length < 1 || !sorted(plugin.skills.map(skill => skill.name))) return false;
    if (!plugin.skills.every(skill => safeSkillName.test(skill.name) && typeof skill.target === "string" &&
      isAbsolute(skill.target) && resolve(skill.target) === skill.target)) return false;
  }
  return skillPlanHash(plan) === plan.planHash;
}

/**
 * Each plugin directory holds exactly its manifest and one link per skill to the listed target. Checked before
 * every Turn; the linked skills themselves are read as they are on disk.
 */
export async function verifySkillPlan(plan: RuntimeSkillPlan): Promise<boolean> {
  if (!validSkillPlan(plan)) return false;
  try {
    for (const plugin of plan.plugins) {
      const top = (await readdir(plugin.root)).sort();
      if (top.join("/") !== ".claude-plugin/skills") return false;
      if ((await readdir(join(plugin.root, ".claude-plugin"))).join("/") !== "plugin.json") return false;
      const manifest = join(plugin.root, ".claude-plugin", "plugin.json");
      if (!(await lstat(manifest)).isFile() || await readFile(manifest, "utf8") !== skillPluginManifest(plugin.name, plan.planHash)) return false;
      const links = (await readdir(join(plugin.root, "skills"))).sort();
      if (links.join("/") !== plugin.skills.map(skill => skill.name).join("/")) return false;
      for (const skill of plugin.skills) {
        const link = join(plugin.root, "skills", skill.name);
        if (!(await lstat(link)).isSymbolicLink() || await readlink(link) !== skill.target) return false;
      }
    }
    return true;
  } catch { return false; }
}

/** `<plugin>:<skill>` for every plan skill, as the CLI names plugin skills. */
export const planSkillsOf = (plan: RuntimeSkillPlan): string[] =>
  plan.plugins.flatMap(plugin => plugin.skills.map(skill => `${plugin.name}:${skill.name}`));

/** CLI settings that apply the plan to what the CLI discovers by itself. */
export function skillSettingsOf(plan: RuntimeSkillPlan): { skillOverrides: Record<string, "off">; disableBundledSkills: boolean } {
  const off = new Set(plan.off);
  if (!plan.builtin) for (const name of CLAUDE_BUILTIN_PLUGIN_SKILLS) off.add(name);
  return { skillOverrides: Object.fromEntries([...off].sort().map(name => [name, "off" as const])), disableBundledSkills: !plan.builtin };
}

/**
 * The cwd's AGENTS.md, else CLAUDE.md: the same project instructions Codex reads, so both runtimes start from
 * one source. Only the file at the cwd is read; imports and nested files are not expanded.
 */
export async function readInstructions(cwd: string): Promise<TurnContext["instructions"]> {
  for (const file of ["AGENTS.md", "CLAUDE.md"] as const) {
    let handle;
    try { handle = await open(join(cwd, file), "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const data = await handle.readFile();
      const truncated = data.length > MAX_INSTRUCTION_BYTES;
      // Cut on a character boundary so the passed text never ends in a broken sequence.
      const body = truncated ? new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(0, MAX_INSTRUCTION_BYTES)).replace(/�+$/, "") : data.toString("utf8");
      const text = `Project instructions from ${file} in the working directory. evoLoop passes them because this Session does not ` +
        `read project settings itself.${truncated ? ` The file is longer than ${MAX_INSTRUCTION_BYTES} bytes; read it for the rest.` : ""}\n\n${body}`;
      return { file, contentHash: sha256(data), truncated, text };
    } finally { await handle.close(); }
  }
  return null;
}

/** Bounded names from the init message; skill bodies, plugin paths and error messages are not kept. */
export function observeInit(context: TurnContext,
  message: { skills?: unknown; plugins?: unknown; plugin_errors?: unknown; mcp_servers?: unknown },
  observedAtUtc: string): RuntimeObservedCapabilities {
  const names = (values: unknown[]): string[] =>
    [...new Set(values.filter((value): value is string => typeof value === "string" && reportedName.test(value)))].slice(0, 128);
  const discoveredSkills = names(Array.isArray(message.skills) ? message.skills : []);
  const plugins = names(Array.isArray(message.plugins) ? message.plugins.map(plugin => (plugin as { name?: unknown } | null)?.name) : []);
  const pluginErrors = [...new Set((Array.isArray(message.plugin_errors) ? message.plugin_errors : [])
    .map(error => (error as { type?: unknown } | null)?.type)
    .map(type => typeof type === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(type) ? type : "unrecognized"))].slice(0, 16);
  // Server names may carry spaces (claude.ai connectors do); an unusable name still counts as a server.
  const mcpServers = [...new Set((Array.isArray(message.mcp_servers) ? message.mcp_servers : [])
    .map(server => (server as { name?: unknown } | null)?.name)
    .map(name => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9 :_.-]{0,127}$/.test(name) ? name : "unrecognized"))].slice(0, 32);
  const allowed = context.allowedSkills;
  return {
    source: "claude.init", observedAtUtc, planHash: context.plan?.planHash ?? null,
    discoveredSkills, allowedSkills: allowed ? [...allowed] : null,
    missingSkills: allowed ? allowed.filter(name => !discoveredSkills.includes(name)) : [],
    plugins, pluginErrors, mcpServers, contextMode: context.mode,
    instructions: context.instructions ? { file: context.instructions.file, contentHash: context.instructions.contentHash,
      truncated: context.instructions.truncated } : null,
  };
}
