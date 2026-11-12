import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { milestoneStatus, milestoneStatusLabel, type MilestonePhase, type MilestonesView, type StagePhaseLink, type VersionInfo } from "@evoloop/contracts/milestones";

export interface RoadmapPhase { id: string; title: string; deliver: string; exit: string }

/** The phase table of docs/roadmap.md: "| M1 名称 | 要交付什么 | 退出证据 |" rows under the 阶段 header. Nothing else is read. */
export function parseRoadmapPhases(markdown: string): RoadmapPhase[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => /^\|\s*阶段\s*\|\s*要交付什么/.test(line));
  if (start < 0) return [];
  const phases: RoadmapPhase[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
    const head = /^(M[0-9]+(?:\.[0-9]+)?)\s+(.+)$/.exec(cells[0] ?? "");
    if (head && cells.length >= 3) phases.push({ id: head[1]!, title: head[2]!, deliver: cells[1]!, exit: cells.slice(2).join("|").trim() });
  }
  return phases;
}

/**
 * The milestones view: roadmap text with the status and date of the stage linked to each phase. A phase no stage is linked to, or more than
 * one is, has no status ("未登记" on the page); the current phase is named only when exactly one linked stage is active.
 */
export function buildMilestones(phases: RoadmapPhase[], links: StagePhaseLink[], commit: string | null, roadmapRead: boolean): MilestonesView {
  const rows: MilestonePhase[] = phases.map(phase => {
    const linked = links.filter(link => link.phaseKey === phase.id);
    const one = linked.length === 1 ? linked[0]! : null;
    const status = one ? milestoneStatus(one, one.review) : null;
    return { ...phase, status, statusLabel: status ? milestoneStatusLabel[status] : null, stage: one ? { id: one.stageId, goalId: one.goalId } : null,
      linkedStages: linked.length, reviewedAt: one?.review?.createdAt ?? null };
  });
  const active = links.filter(link => link.state === "active");
  const current = active.length === 1 ? rows.find(row => row.stage?.id === active[0]!.stageId) ?? null : null;
  const currentNote = current ? null : active.length > 1 ? "有多个进行中的阶段，不猜哪个是当前" : "当前阶段未登记";
  return { source: { commit, roadmap: roadmapRead ? "read" : "unavailable" }, phases: rows, currentPhaseId: current?.id ?? null, currentNote };
}

const buildInfoSchema = z.object({ commit: z.string().regex(/^[0-9a-f]{7,40}$/i).nullable().optional(), builtAt: z.string().refine(value => !Number.isNaN(Date.parse(value))).nullable().optional() });
/** build-info.json next to the deployed code: { "commit": "<sha>", "builtAt": "<ISO time>" }. Missing or unreadable: both null, never a guess. */
export async function readBuildInfo(repoRoot: string): Promise<{ commit: string | null; builtAt: string | null }> {
  try {
    const parsed = buildInfoSchema.parse(JSON.parse(await readFile(join(repoRoot, "build-info.json"), "utf8")));
    return { commit: parsed.commit ?? null, builtAt: parsed.builtAt ? new Date(parsed.builtAt).toISOString() : null };
  } catch { return { commit: null, builtAt: null }; }
}

export interface MilestoneRouteOptions { service: WorkflowService; repoRoot: string; startedAt?: string }

export function registerMilestoneRoutes(app: FastifyInstance, options: MilestoneRouteOptions): void {
  const startedAt = options.startedAt ?? new Date().toISOString();
  // Public like /health (see the onRequest hook): only the commit, the build time and the process start time; no path, environment or configuration.
  app.get("/api/version", async (): Promise<VersionInfo> => ({ ...(await readBuildInfo(options.repoRoot)), startedAt }));
  app.get("/api/projects/:projectId/milestones", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    await options.service.getProject(request.principal, projectId);
    let phases: RoadmapPhase[] = [], read = false;
    try { phases = parseRoadmapPhases(await readFile(join(options.repoRoot, "docs", "roadmap.md"), "utf8")); read = phases.length > 0; } catch { /* unreadable: the page says so */ }
    const links = await options.service.listStagePhaseLinks(request.principal, projectId);
    return buildMilestones(phases, links, (await readBuildInfo(options.repoRoot)).commit, read);
  });
}
