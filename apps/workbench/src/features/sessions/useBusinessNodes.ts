import { useEffect, useRef, useState } from "react";
import { sessionClient } from "../../shared/sessionClient";
import { isNodeActivity, type NodeActivity } from "./businessNodes";

/** Pages read for one range: a range holding more nodes than this is cut at the oldest page, and says so. */
const pageBudget = 6;

/**
 * The business nodes of an agent from `since` on (Task 13518ac6), read a page at a time from the session activities and kept by id.
 * `since` is the time of the earliest round on the page, so history read further back brings the nodes of its time range with it
 * and the first read asks for no more than the rounds shown. `since` of null reads all (the whole timeline is on the page).
 * `version` changes when something may have happened (a refresh, a finished turn): the range is read again and merged.
 * A read that fails leaves what was read and says so; it never shows a node that was not read.
 */
export function useBusinessNodes(projectId: string, sessionKey: string, since: string | null, enabled: boolean, version: string) {
  const scope = `${projectId}\0${sessionKey}`;
  const [state, setState] = useState<{ scope: string; nodes: Map<string, NodeActivity>; error: boolean; cut: boolean; loaded: boolean }>({ scope, nodes: new Map(), error: false, cut: false, loaded: false });
  const current = useRef(scope); current.current = scope;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      const found: NodeActivity[] = []; let cursor: string | undefined; let cut = false;
      try {
        for (let page = 0; page < pageBudget; page++) {
          const read = await sessionClient("", projectId).businessNodes(sessionKey, since, cursor, controller.signal);
          // The reader already answers only for this agent's Tasks; a node of another Session is kept out here as well.
          found.push(...read.items.filter(isNodeActivity).filter(item => item.sessionKey === sessionKey));
          cursor = read.nextCursor ?? undefined;
          if (!cursor) break;
          if (page === pageBudget - 1) cut = true;
        }
      } catch {
        if (controller.signal.aborted || current.current !== scope) return;
        setState(previous => ({ scope, nodes: previous.scope === scope ? previous.nodes : new Map(), error: true, cut: previous.scope === scope && previous.cut, loaded: previous.scope === scope && previous.loaded }));
        return;
      }
      if (controller.signal.aborted || current.current !== scope) return;
      setState(previous => {
        const nodes = new Map(previous.scope === scope ? previous.nodes : []);
        for (const item of found) nodes.set(item.id, item);
        return { scope, nodes, error: false, cut: cut || (previous.scope === scope && previous.cut), loaded: true };
      });
    })();
    return () => controller.abort();
  }, [scope, since, enabled, version]);
  const own = state.scope === scope;
  return { nodes: own ? [...state.nodes.values()] : [], error: own && state.error, cut: own && state.cut, loaded: own && state.loaded };
}
