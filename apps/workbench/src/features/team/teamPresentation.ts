// Pure helpers for the team space: which view a team section shows.
export type TeamView = "roles" | "reviews" | "discussions" | "execution";
export type TeamSection = "runtime" | "roles" | "reviews" | "discussions";

/** `/roles`, `/reviews` and `/discussions` are their own addresses; `/runtime` is 分工与运行. Old `?view=` links are
 * rewritten to these addresses before a page opens (shared/routes.ts `legacyTeamAddress`). */
export function teamViewOf(section: TeamSection): TeamView {
  return section === "runtime" ? "execution" : section;
}
