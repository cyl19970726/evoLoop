import { z } from "zod";

/** A roadmap phase key as written in docs/roadmap.md: M0, M0.5, M1, … */
export const phaseKeySchema = z.string().regex(/^M[0-9]+(?:\.[0-9]+)?$/, "phase key looks like M1 or M0.5");

/**
 * `stage.review` / `stage.correct` require text in adopted, rejected and gap, so "nothing" can only be written as a word. A field that is just
 * one of these markers (alone, ignoring spaces and a closing full stop) counts as empty; a sentence that merely contains one does not.
 */
const NONE_MARKERS = new Set(["无", "没有", "暂无", "无缺口", "无拒绝", "无遗漏", "none", "nil", "n/a", "na", "-", "—", "–"]);
export function isNoneMarker(value: string): boolean {
  const text = value.trim().replace(/[。.]+$/, "").trim().toLowerCase();
  return text.length === 0 || NONE_MARKERS.has(text);
}

export interface VersionInfo { commit: string | null; builtAt: string | null; startedAt: string }

/** One level of a project's verification ladder (`GET /api/projects/:id/ladder`): its roadmap name, the first sentence of its current status, and the stages that supply evidence for it. */
export interface LadderLevel { key: string; name: string; status: string | null; evidenceStages: Array<{ id: string; shortName: string }> }
/** `available:false` with no levels means the project has no roadmap (an answer, not an error); a repository that cannot be read is the error `LADDER_UNREADABLE`. */
export interface LadderView { available: boolean; source: { commit: string | null }; levels: LadderLevel[] }
