import { z } from "zod";
import type { RuntimeProvider } from "./runtime.js";

/**
 * Which runtime a Role runs on and which skills its Sessions load.
 *
 * A Role is bound to one runtime the first time it is set (or the first time one of its Sessions is
 * reserved) and keeps it; only the skill selection can change afterwards. Skills are not pinned to a
 * content version: each Turn loads the skill directories as they are on disk. The selection decides what
 * the runtime loads into the model's context; it is not a security boundary.
 */
export const skillSources = ["evoloop", "project", "personal", "builtin"] as const;
export type SkillSource = typeof skillSources[number];

/** A skill name, optionally qualified by its source (`project:frontend-design`). */
export const skillReferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/);
export const roleSkillSelectionSchema = z.strictObject({
  /** Skills of the work directory's repository: `.agents/skills` and `.claude/skills`. */
  project: z.boolean(),
  /** Skills in the user's own directories (`~/.agents/skills`, `~/.claude/skills`) and personal plugins. */
  personal: z.boolean(),
  /** Skills that ship with the runtime; self-modifying ones stay off unless added by name. */
  builtin: z.boolean(),
  add: z.array(skillReferenceSchema).max(32),
  remove: z.array(skillReferenceSchema).max(32),
}).superRefine((value, context) => {
  if (new Set(value.add).size !== value.add.length) context.addIssue({ code: "custom", message: "add lists a skill twice", path: ["add"] });
  if (new Set(value.remove).size !== value.remove.length) context.addIssue({ code: "custom", message: "remove lists a skill twice", path: ["remove"] });
  if (value.add.some(item => value.remove.includes(item)))
    context.addIssue({ code: "custom", message: "a skill cannot be both added and removed", path: ["remove"] });
});
export type RoleSkillSelection = z.infer<typeof roleSkillSelectionSchema>;

/** Role default before any explicit choice: project and built-in skills, nothing personal. */
export const defaultRoleSkillSelection = (): RoleSkillSelection =>
  ({ project: true, personal: false, builtin: true, add: [], remove: [] });

/** Built-ins that change the runtime's own configuration or install skills; off unless added by name. */
export const selfModifyingBuiltinSkills: readonly string[] = ["update-config", "fewer-permission-prompts", "skill-installer"];

export interface SkillCandidate { name: string; source: SkillSource }
/**
 * business: an evoLoop business skill the Role always carries; switch / switch_off: decided by the source's
 * switch; added / removed: named in the selection; self_modifying: a built-in kept off by default.
 */
export type SkillReason = "business" | "switch" | "switch_off" | "added" | "removed" | "self_modifying";

/** `name` matches any source; `source:name` matches that source only. Other prefixes are part of the name. */
export function skillReferenceMatches(reference: string, candidate: SkillCandidate): boolean {
  const colon = reference.indexOf(":");
  const prefix = colon > 0 ? reference.slice(0, colon) : "";
  if ((skillSources as readonly string[]).includes(prefix))
    return candidate.source === prefix && candidate.name === reference.slice(colon + 1);
  return candidate.name === reference;
}

export function decideSkill(candidate: SkillCandidate, selection: RoleSkillSelection): { selected: boolean; reason: SkillReason } {
  if (candidate.source === "evoloop") return { selected: true, reason: "business" };
  if (selection.remove.some(reference => skillReferenceMatches(reference, candidate))) return { selected: false, reason: "removed" };
  if (selection.add.some(reference => skillReferenceMatches(reference, candidate))) return { selected: true, reason: "added" };
  if (candidate.source === "builtin" && selfModifyingBuiltinSkills.includes(candidate.name)) return { selected: false, reason: "self_modifying" };
  return selection[candidate.source] ? { selected: true, reason: "switch" } : { selected: false, reason: "switch_off" };
}

/** Added references that match no candidate; the Role runs without them and the view marks them. */
export const missingSkillReferences = (selection: RoleSkillSelection, candidates: readonly SkillCandidate[]): string[] =>
  selection.add.filter(reference => !candidates.some(candidate => skillReferenceMatches(reference, candidate)));

/** One immutable entry in a Role's runtime history. Revision 1 fixes the provider for good. */
export interface RoleRuntimeRevision {
  projectId: string;
  roleId: string;
  revision: number;
  provider: RuntimeProvider;
  skills: RoleSkillSelection;
  actorId: string;
  reason: string;
  /** Null only for rows written by the migration from existing Sessions. */
  operationId: string | null;
  createdAtUtc: string;
}

export interface RoleRuntimeSkill extends SkillCandidate {
  selected: boolean;
  reason: SkillReason;
  description: string | null;
  /** Where it was found, relative to its source root (`.agents/skills/x`); null for runtime-reported built-ins. */
  location: string | null;
  /** sha256 of SKILL.md as read now; null when the runtime reported the skill without its file. */
  contentHash: string | null;
  /**
   * How the runtime receives it: `native` when the runtime finds it by itself (Codex's own list, Claude's project
   * `.claude/skills`); `role_context` when evoLoop supplies it with the Role (Codex: the Role context; Claude: the
   * Turn's linked skill plugin); `none` when not selected.
   */
  delivery: "native" | "role_context" | "none";
}

/** Live answer to "what does this Role have now". Computed on every read; nothing here is cached. */
export interface RoleRuntimeView {
  projectId: string;
  roleId: string;
  binding: RoleRuntimeRevision | null;
  history: RoleRuntimeRevision[];
  provider: RuntimeProvider;
  providerSource: "binding" | "default";
  availableProviders: RuntimeProvider[];
  providerAvailable: boolean;
  selection: RoleSkillSelection;
  selectionSource: "binding" | "default";
  /**
   * `session`: the latest Session's directory. `grant`: a Role without a Session starts in its own first granted directory (`grantCount` of them);
   * `hidden`: the reader may not see the path (not a reviewer and no grant of this Role), so `cwd` is null and the card says it is configured.
   */
  workDirectory: { cwd: string | null; source: "session" | "grant"; grantCount?: number; hidden?: boolean } | null;
  skills: RoleRuntimeSkill[];
  missing: string[];
  /** codex.list: read from the running Codex now; claude.init: the latest Turn's report; files: read from disk only. */
  skillsReportedBy: "codex.list" | "claude.init" | "files";
  plugins: { name: string; enabled: boolean }[];
  mcpServers: { name: string; auth: string | null }[];
  /** Why part of the view could not be read; null when everything was read. */
  notes: string[];
  observedAtUtc: string;
}
