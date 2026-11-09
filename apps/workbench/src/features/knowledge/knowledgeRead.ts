// Reads behind 知识空间, kept free of React so tests can drive them with a fake client. The hooks in knowledgeData.ts
// put them behind useProjectQuery; this file decides what a read result may claim.
import type { KnowledgeCapabilities, KnowledgeGraph, KnowledgePage, KnowledgeRevision, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { findFixedKnowledgeTitle } from "./knowledgeRoute";
import { pageRelations } from "./knowledgePresentation";

/** The part of a query result these decisions need (useProjectQuery returns more). */
export interface ReadLike<T> { data?: T | undefined; isFetching: boolean; isError: boolean }
export type ServiceStanding = "reading" | "checking" | "current" | "stale" | "failed";

/**
 * Whether the knowledge service can be called fully readable now. Capabilities count only together with the page
 * index read beside them. While a reread runs the last answer stays on screen marked 正在核对; once a reread fails,
 * the old list is kept for reading but no longer counts (上次读回，当前待核对). A list that was never read is not
 * 上次读回, even when the capabilities were.
 */
export function serviceState(capabilities: ReadLike<KnowledgeCapabilities>, pages: ReadLike<unknown>): { standing: ServiceStanding; capabilities: KnowledgeCapabilities | null } {
  const failed = capabilities.isError || pages.isError;
  const hasData = capabilities.data !== undefined && pages.data !== undefined;
  if (failed) return { standing: pages.data !== undefined ? "stale" : "failed", capabilities: null };
  if (!hasData) return { standing: "reading", capabilities: null };
  if (capabilities.isFetching || pages.isFetching) return { standing: "checking", capabilities: capabilities.data! };
  return { standing: "current", capabilities: capabilities.data! };
}

type ReadClient = {
  page(id: string, revision?: string): Promise<KnowledgeRevision>;
  history(id: string): Promise<KnowledgePage<KnowledgeSummary>>;
  graph(id: string): Promise<KnowledgeGraph>;
};

export interface KnowledgeReading {
  page: KnowledgeRevision;
  /** The current revision of the page, or null when it was not read back (only asked for a fixed link). */
  current: string | null;
  history: KnowledgePage<KnowledgeSummary> | null;
  /** The graph around the current version; null when it was not read back. */
  graph: KnowledgeGraph | null;
  /** Titles of relation targets the graph does not name, per `id\0revision`; null when that read failed. */
  titles: Record<string, string | null>;
}

export const titleKey = (id: string, revision: string) => `${id}\0${revision}`;

/**
 * One page read as a unit: the revision asked for, its history, its graph, the current revision for a fixed link and
 * the titles of its relation targets. The unit is swapped in one step, so the right column never mixes two pages.
 * Only the body is required; the rest is reported missing on its own.
 */
export async function readKnowledgePage(client: ReadClient, projectId: string, id: string, revision?: string): Promise<KnowledgeReading> {
  const [read, history, graph, head] = await Promise.allSettled([client.page(id, revision), client.history(id), client.graph(id),
    revision ? client.page(id) : Promise.resolve(null)]);
  if (read.status === "rejected") throw read.reason;
  const page = read.value;
  if (page.projectId !== projectId || page.knowledgeId !== id || (revision && page.revision !== revision)) throw new Error("知识响应与所选页面不符");
  const headValue = head.status === "fulfilled" ? head.value : null;
  const current = !revision ? page.revision
    : headValue && headValue.projectId === projectId && headValue.knowledgeId === id ? headValue.revision : null;
  const graphValue = graph.status === "fulfilled" ? graph.value : null;
  const relations = pageRelations(page, graphValue, current === page.revision);
  const missing = [...new Map(relations.filter(item => !findFixedKnowledgeTitle(item.otherId, item.otherRevision, graphValue?.nodes ?? []))
    .map(item => [titleKey(item.otherId, item.otherRevision), { id: item.otherId, revision: item.otherRevision }])).values()];
  const reads = await Promise.allSettled(missing.map(target => client.page(target.id, target.revision)));
  const titles: Record<string, string | null> = {};
  missing.forEach((target, index) => {
    const result = reads[index]!;
    titles[titleKey(target.id, target.revision)] = result.status === "fulfilled" && result.value.knowledgeId === target.id
      && result.value.revision === target.revision && result.value.title.trim() ? result.value.title.trim() : null;
  });
  return { page, current, history: history.status === "fulfilled" ? history.value : null, graph: graphValue, titles };
}
