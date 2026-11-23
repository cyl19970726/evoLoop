// The relation bar under an object's title (docs/frontend/principles.md 关系条): one line of small text, each item a name and
// a link or its absence, joined by " · ". It only says what the page already read; a fact that is not registered is said so
// ("未登记"), never left out. Every object page (task, document, agent, stage, schedule) uses this one part, so the bar
// looks and reads the same wherever the reader starts.
import { Fragment } from "react";
import type React from "react";

export const link = "text-primary hover:underline";
export const unregistered = "未登记";
export const readFailed = "读取失败";

export type RelationItem = { id: string; label: string; value: React.ReactNode };

/** `kind` names the object ("task" keeps the task page's own `data-task-relations`); each item is a `data-relation`. */
export function RelationBar({ kind, items, label }: { kind: "task" | "document" | "agent" | "stage" | "schedule"; items: RelationItem[]; label?: string }) {
  const marker = kind === "task" ? { "data-task-relations": "" } : { "data-relations": kind };
  return <p className="text-label leading-(--leading-body) text-text-secondary [overflow-wrap:anywhere]" aria-label={label} {...marker}>
    {items.map((item, index) => <Fragment key={item.id}>
      {index > 0 && " · "}<span data-relation={item.id}>{item.label} {item.value}</span>
    </Fragment>)}
  </p>;
}

/** A name cut at `max` characters for a bar that must stay on a line or two; the whole name stays in the title. */
export function cut(text: string, max = 24): string {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text.trim();
}
