import type { ReactNode } from "react";
import type { DocumentRevision } from "@evoloop/contracts";
import { OriginalDocumentReader } from "../documents/OriginalDocumentReader";
export type Section = "overview" | "work" | "knowledge" | "task" | "document" | "documents" | "inbox" | "journey" | "discussions" | "collaboration" | "runtime" | "schedules" | "roles" | "repository" | "operations";
export type Route = { projectId: string | null; section: Section; id?: string; revision?: string; action?: string };


export function readRoute(): Route {
  const raw = window.location.hash.slice(1) || "/";
  const [pathname, search = ""] = raw.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) return { projectId: null, section: "overview" };
  const section = parts[2];
  const action = new URLSearchParams(search).get("action") || undefined;
  const revision = new URLSearchParams(search).get("revision") || undefined;
  if (section === "tasks" && parts[3]) return { projectId: parts[1], section: "task", id: parts[3], revision };
  if (section === "documents" && parts[3]) return { projectId: parts[1], section: "document", id: parts[3], revision };
  if (["work", "knowledge", "documents", "inbox", "journey", "discussions", "collaboration", "runtime", "schedules", "roles", "repository", "operations"].includes(section ?? "")) return { projectId: parts[1], section: section as Section, action };
  return { projectId: parts[1], section: "overview" };
}

export function href(projectId: string, section: Section, id?: string, revision?: string): string {
  const part = section === "task" ? `tasks/${id}` : section === "document" ? `documents/${id}` : section;
  return `#/p/${projectId}/${part}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`;
}

export function date(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("zh-CN");
}

export function ShortId({ value }: { value: string }) {
  return <code title={value}>{value.slice(0, 8)}</code>;
}

export function Alert({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function RevisionBody({ revision, label, token }: { revision: DocumentRevision; label?: string; token: string }) {
  return <section className="revision-body">
    {label && <div className="eyebrow">{label}</div>}
    <div className="revision-meta"><span>修订 <ShortId value={revision.id} /></span><span>{date(revision.createdAt)}</span><span>作者 {revision.author}</span></div>
    {revision.body !== null && revision.format === "markdown" ? <pre>{revision.body}</pre> : <OriginalDocumentReader token={token} projectId={revision.projectId} documentId={revision.documentId} revisionId={revision.id} />}
    <p className="muted">原件 {revision.format} · <code title={revision.contentHash}>{revision.contentHash.slice(0, 22)}…</code></p>
  </section>;
}


export function taskListHref(projectId: string): string {
  try {
    const value = sessionStorage.getItem(`evoloop:list:${projectId}`);
    if (value === href(projectId, "work") || value === href(projectId, "inbox")) return value;
  } catch { /* optional navigation state */ }
  return href(projectId, "work");
}

function isProjectRoute(value: string | null, projectId: string): value is string {
  if (!value?.startsWith(`#/p/${projectId}/`)) return false;
  const path = value.split("?")[0].slice(`#/p/${projectId}/`.length);
  return /^(work|inbox|documents|journey|discussions|runtime|schedules|roles|knowledge|repository|operations|collaboration|tasks\/[0-9a-f-]{36})$/i.test(path);
}
export function documentReturnHref(projectId: string): string {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const requested = query.get("return");
  if (isProjectRoute(requested, projectId)) return requested;
  try {
    const saved = sessionStorage.getItem(`evoloop:document-return:${projectId}`);
    if (isProjectRoute(saved, projectId)) return saved;
  } catch { /* optional navigation state */ }
  return href(projectId, "documents");
}
