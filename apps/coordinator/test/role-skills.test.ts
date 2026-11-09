import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoleSkillSelection, type RoleSkillSelection } from "@evoloop/contracts/role-skills";
import { verifySkillPlan } from "@evoloop/adapter-claude-agent-sdk";
import { businessSkillDirs, claudePlanContent, codexSkillConfig, discoverSkills, materializeSkillPlan, skillFrontmatter }
  from "../src/session-preparation/role-skills.js";

async function skill(dir: string, name: string, frontmatter = `---\nname: ${name}\ndescription: ${name} skill\n---\n`) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `${frontmatter}\nBody of ${name}.\n`);
}

/** business repo, a project repo with a nested work directory, and a home. */
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evoloop-role-skills-")));
  const business = join(root, "evoloop"), repo = join(root, "repo"), cwd = join(repo, "apps", "web"), home = join(root, "home");
  await skill(join(business, ".agents", "skills"), "evoloop-workflow");
  await mkdir(join(repo, ".git"), { recursive: true });
  await skill(join(repo, ".agents", "skills"), "repo-agents");
  await skill(join(repo, ".claude", "skills"), "repo-claude");
  await skill(join(cwd, ".agents", "skills"), "web-agents");
  await skill(join(cwd, ".claude", "skills"), "web-claude", "---\nname: web-claude\ndescription: >\n  folded\n  text\n---\n");
  await skill(join(home, ".agents", "skills"), "mine");
  await skill(join(home, ".claude", "skills"), "update-config");
  // A personal link to a project skill: the first real path wins. Skills above the repository root are not read.
  await symlink(join(repo, ".agents", "skills", "repo-agents"), join(home, ".agents", "skills", "linked-repo"));
  await skill(join(root, ".agents", "skills"), "above-repo");
  return { root, business, repo, cwd, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("frontmatter gives name and description; block scalars fold and quotes drop", () => {
  assert.deepEqual(skillFrontmatter("---\nname: \"demo\"\ndescription: |\n  line one\n  line two\nother: x\n---\nbody"),
    { name: "demo", description: "line one line two" });
  assert.deepEqual(skillFrontmatter("no frontmatter"), { name: null, description: null });
});

test("discovery finds business, project (cwd up to the repository root) and personal skills once each", async () => {
  const l = await layout();
  try {
    const { skills, notes } = await discoverSkills({ businessRoot: l.business,
      businessPaths: [".agents/skills/evoloop-workflow/SKILL.md", ".agents/skills/missing/SKILL.md"], cwd: l.cwd, home: l.home });
    assert.deepEqual(skills.map(item => [item.source, item.name, item.location, item.claudeNative]), [
      ["evoloop", "evoloop-workflow", ".agents/skills/evoloop-workflow", false],
      ["project", "web-agents", "apps/web/.agents/skills/web-agents", false],
      ["project", "web-claude", "apps/web/.claude/skills/web-claude", true],
      ["project", "repo-agents", ".agents/skills/repo-agents", false],
      ["project", "repo-claude", ".claude/skills/repo-claude", true],
      ["personal", "mine", "~/.agents/skills/mine", false],
      ["personal", "update-config", "~/.claude/skills/update-config", false],
    ]);
    assert.equal(skills.find(item => item.name === "web-claude")?.description, "folded text");
    assert.match(skills[0]!.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(notes, ["业务 skill 不存在：.agents/skills/missing"]);
  } finally { await l.cleanup(); }
});

test("the Claude plan links selected skills by source and turns off what the CLI would discover itself", async () => {
  const l = await layout();
  try {
    const { skills } = await discoverSkills({ businessRoot: l.business, businessPaths: [".agents/skills/evoloop-workflow/SKILL.md"],
      cwd: l.cwd, home: l.home });
    const selection: RoleSkillSelection = { ...defaultRoleSkillSelection(), remove: ["repo-claude", "builtin:simplify"] };
    const project = claudePlanContent(skills, selection, "project");
    assert.deepEqual(project.plugins.map(plugin => [plugin.name, plugin.skills.map(item => item.name)]),
      [["evoloop", ["evoloop-workflow"]], ["project", ["repo-agents", "web-agents"]]]);
    assert.deepEqual(project.off, ["fewer-permission-prompts", "repo-claude", "simplify", "skill-installer", "update-config"],
      "unselected native project skills, removed and self-modifying built-ins are off by name");
    assert.equal(project.builtin, true);
    const explicit = claudePlanContent(skills, { ...selection, personal: true, add: ["update-config"] }, "explicit");
    assert.deepEqual(explicit.plugins.map(plugin => [plugin.name, plugin.skills.map(item => item.name)]), [
      ["evoloop", ["evoloop-workflow"]], ["project", ["repo-agents", "web-agents", "web-claude"]], ["personal", ["mine", "update-config"]]]);
    assert.deepEqual(explicit.off, ["fewer-permission-prompts", "repo-claude", "simplify", "skill-installer"],
      "an added name keeps a self-modifying skill on");
    const none = claudePlanContent(skills, { project: false, personal: false, builtin: false, add: [], remove: [] }, "project");
    assert.deepEqual(none.plugins.map(plugin => plugin.name), ["evoloop"], "business skills stay with every switch off");
    assert.deepEqual(none.off.filter(name => name.startsWith("repo") || name.startsWith("web")), ["repo-claude", "web-claude"]);
    assert.equal(none.builtin, false);
  } finally { await l.cleanup(); }
});

test("a repository that links .claude/skills to .agents/skills gives Claude each skill once", async () => {
  // Like this repository: the business skills live in the work repository and `.claude/skills` links to `.agents/skills`.
  const root = await realpath(await mkdtemp(join(tmpdir(), "evoloop-role-skills-link-")));
  const repo = join(root, "repo"), home = join(root, "home");
  try {
    await mkdir(join(repo, ".git"), { recursive: true });
    await skill(join(repo, ".agents", "skills"), "evoloop-workflow");
    await skill(join(repo, ".agents", "skills"), "frontend-design");
    await mkdir(join(repo, ".claude"));
    await symlink("../.agents/skills", join(repo, ".claude", "skills"));
    const { skills } = await discoverSkills({ businessRoot: repo, businessPaths: [".agents/skills/evoloop-workflow/SKILL.md"],
      cwd: repo, home });
    assert.deepEqual(skills.map(item => [item.source, item.name, item.claudeNative, item.claudeNativeAliases ?? []]), [
      ["evoloop", "evoloop-workflow", false, ["evoloop-workflow"]],
      ["project", "frontend-design", false, ["frontend-design"]],
    ], "each skill is found once by real path, with the name Claude also reads it under");
    const project = claudePlanContent(skills, defaultRoleSkillSelection(), "project");
    assert.deepEqual(project.plugins.map(plugin => [plugin.name, plugin.skills.map(item => item.name)]),
      [["evoloop", ["evoloop-workflow"]], ["project", ["frontend-design"]]]);
    assert.ok(project.off.includes("evoloop-workflow") && project.off.includes("frontend-design"),
      "the native copies are off by name, so the plugin is each skill's one path");
    const unselected = claudePlanContent(skills, { ...defaultRoleSkillSelection(), project: false }, "project");
    assert.deepEqual(unselected.plugins.map(plugin => plugin.name), ["evoloop"]);
    assert.ok(unselected.off.includes("frontend-design"), "an unselected project skill stays off through the link too");
    const explicit = claudePlanContent(skills, defaultRoleSkillSelection(), "explicit");
    assert.ok(!explicit.off.includes("frontend-design") && !explicit.off.includes("evoloop-workflow"),
      "explicit mode reads no project settings, so nothing native needs turning off");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a plan is written once as links, reused while it matches, and rewritten when altered", async () => {
  const l = await layout();
  try {
    const { skills } = await discoverSkills({ businessRoot: l.business, businessPaths: [".agents/skills/evoloop-workflow/SKILL.md"],
      cwd: l.cwd, home: l.home });
    const pluginRoot = join(l.root, "config", "evoloop-skill-plugins");
    const content = claudePlanContent(skills, defaultRoleSkillSelection(), "project");
    const plan = await materializeSkillPlan(pluginRoot, content);
    assert.ok(await verifySkillPlan(plan));
    assert.equal(await readlink(join(plan.plugins[0]!.root, "skills", "evoloop-workflow")), join(l.business, ".agents/skills/evoloop-workflow"));
    assert.deepEqual(await materializeSkillPlan(pluginRoot, content), plan, "the same selection gives the same plan");
    await rm(join(plan.plugins[1]!.root, ".claude-plugin", "plugin.json"));
    await writeFile(join(plan.plugins[1]!.root, ".claude-plugin", "plugin.json"), "{}");
    assert.equal(await verifySkillPlan(plan), false);
    assert.ok(await verifySkillPlan(await materializeSkillPlan(pluginRoot, content)), "an altered directory is rewritten");
    const empty = await materializeSkillPlan(pluginRoot, { plugins: [], off: [], builtin: true });
    assert.deepEqual(empty.plugins, []);
    await assert.rejects(materializeSkillPlan("relative/root", content), /absolute/);
  } finally { await l.cleanup(); }
});

test("Codex config turns off listed skills the Role does not use by path, else falls back to files and names", async () => {
  const l = await layout();
  try {
    const businessPaths = [".agents/skills/evoloop-workflow/SKILL.md"];
    const businessDirs = await businessSkillDirs(l.business, businessPaths);
    const listed = [
      { name: "evoloop-workflow", path: join(l.business, ".agents/skills/evoloop-workflow/SKILL.md"), scope: "repo" as const },
      { name: "repo-agents", path: join(l.repo, ".agents/skills/repo-agents/SKILL.md"), scope: "repo" as const },
      { name: "mine", path: join(l.home, ".agents/skills/mine/SKILL.md"), scope: "user" as const },
      { name: "skill-installer", path: "/codex/skills/.system/skill-installer/SKILL.md", scope: "system" as const },
      { name: "imagegen", path: "/codex/skills/.system/imagegen/SKILL.md", scope: "system" as const },
    ].map(item => ({ ...item, enabled: true, description: null, pluginId: null }));
    assert.deepEqual(codexSkillConfig({ selection: { ...defaultRoleSkillSelection(), project: false }, listed, discovered: [], businessDirs }), {
      "skills.config": [listed[3]!, listed[1]!, listed[2]!].map(item => item.path).sort().map(path => ({ path, enabled: false })),
    }, "business skills stay; unselected project, personal and self-modifying ones are off");
    assert.deepEqual(codexSkillConfig({ selection: { ...defaultRoleSkillSelection(), personal: true, add: ["skill-installer"] },
      listed, discovered: [], businessDirs }), undefined, "nothing to turn off");
    const withoutBuiltins = codexSkillConfig({ selection: { ...defaultRoleSkillSelection(), personal: true, builtin: false }, listed,
      discovered: [], businessDirs });
    assert.equal(withoutBuiltins?.["skills.bundled.enabled"], false);
    const { skills } = await discoverSkills({ businessRoot: l.business, businessPaths, cwd: l.cwd, home: l.home });
    const fallback = codexSkillConfig({ selection: defaultRoleSkillSelection(), listed: null, discovered: skills, businessDirs });
    assert.deepEqual(fallback, { "skills.config": [
      { path: join(l.home, ".agents/skills/mine/SKILL.md"), enabled: false },
      { path: join(l.home, ".claude/skills/update-config/SKILL.md"), enabled: false },
      { name: "skill-installer", enabled: false },
    ] });
  } finally { await l.cleanup(); }
});
