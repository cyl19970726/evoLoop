// The sub-pages of a section as a row of links in the page, for the narrow frame (below 760px) where the inner rail is a drawer behind a menu button.
// Without it a section's sub-pages (团队: 分工与运行、职责、分工讨论、组织复盘、协作回执) were reachable only through the drawer and the page itself showed no sign of them.
// The wide frame keeps its rail and does not show this. Wrapping, not scrolling: a narrow page never scrolls sideways.
import { cn } from "@evoloop/ui";
import { href, type Route } from "../../shared/routes";
import { leafOf, workNavigation, workSectionOf, type NavItem } from "./spaces";

/** The section whose sub-pages the page should show in itself, or null. Team only for now (the Task that added it); other sections keep the drawer. */
export function sectionTabsFor(route: Pick<Route, "section">): NavItem | null {
  const owner = workSectionOf(route.section);
  return owner === "runtime" ? workNavigation.find(item => item.section === "runtime") ?? null : null;
}

export function SectionTabs({ item, route, projectId }: { item: NavItem; route: Pick<Route, "section">; projectId: string }) {
  const leaf = leafOf(route.section);
  return <nav data-ui="" data-shell="section-tabs" aria-label={`${item.label}子页`} className="flex flex-wrap gap-1.5 px-4 pt-3">
    {item.children!.map(child => <a key={child.section} href={href(projectId, child.section)} aria-current={leaf === child.section ? "page" : undefined}
      className={cn("rounded-full px-3 py-1.5 text-label text-text-secondary outline-none hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)]",
        leaf === child.section ? "bg-selected font-medium text-foreground" : "bg-field")}>{child.label}</a>)}
  </nav>;
}
