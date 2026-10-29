import { errorText } from "../api";
import type { knowledgeClient } from "./client";

type Client = Pick<ReturnType<typeof knowledgeClient>, "capabilities" | "pages" | "candidates" | "sources">;
export type KnowledgeOverviewRead = { key: string; status: "reading" } | { key: string; status: "failed"; error: string } | {
  key: string; status: "complete"; observedAt: string;
  capabilities: Awaited<ReturnType<Client["capabilities"]>>;
  pages: Awaited<ReturnType<Client["pages"]>>;
  candidates: Awaited<ReturnType<Client["candidates"]>>;
  sources: Awaited<ReturnType<Client["sources"]>>;
};

/** One refresh verifies the capability and its accompanying index reads together. */
export async function readKnowledgeOverview(client: Client, key: string,
  apply: (read: KnowledgeOverviewRead) => void, current: () => boolean) {
  if (current()) apply({ key, status: "reading" });
  try {
    const [capabilities, pages, candidates, sources] = await Promise.all([
      client.capabilities(), client.pages(), client.candidates(), client.sources(),
    ]);
    if (current()) apply({ key, status: "complete", capabilities, pages, candidates, sources, observedAt: new Date().toISOString() });
  } catch (cause) {
    if (current()) apply({ key, status: "failed", error: errorText(cause) });
  }
}

export function currentKnowledgeCapabilities(read: KnowledgeOverviewRead, key: string) {
  return read.key === key && read.status === "complete" ? read.capabilities : null;
}
