// Search and filters for the document list. The same conditions drive the inner rail and the table.
import React from "react";
import { Search } from "lucide-react";
import { Input, Select, cn } from "@evoloop/ui";
import { kindFilters, statusFilterLabel, type KindFilter, type StatusFilter } from "./documentPresentation";
import type { DocumentListState } from "./documentListState";


export function DocumentFilters({ state, update, layout = "rail" }: {
  state: DocumentListState; update(patch: Partial<DocumentListState>): void; layout?: "rail" | "toolbar";
}) {
  return <React.Fragment>
    <div className={cn("flex flex-wrap items-center gap-2", layout === "rail" ? "px-1" : "")}>
      <label className={cn("relative flex items-center", layout === "rail" ? "w-full" : "min-w-[200px] flex-1 compact:max-w-[340px]")}>
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-muted-foreground" />
        <Input aria-label="搜索文档" placeholder="搜索文档标题" value={state.query} onChange={event => update({ query: event.target.value })}
          className="h-8 pl-8 text-label" type="search" />
      </label>
      <Select aria-label="文档类型筛选" value={state.kind} onChange={event => update({ kind: event.target.value as KindFilter })} compact
        className={cn(layout === "rail" && "flex-1")}>
        <option value="all">全部类型</option>
        {kindFilters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <Select aria-label="文档状态筛选" value={state.status} onChange={event => update({ status: event.target.value as StatusFilter })} compact
        className={cn(layout === "rail" && "flex-1")}>
        {(Object.entries(statusFilterLabel) as Array<[StatusFilter, string]>).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
    </div>
  </React.Fragment>;
}
