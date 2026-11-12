// The agent page renders once before its snapshot is read (it returns early with “正在读取智能体…”) and again once the
// snapshot is back. React requires the same hooks in the same order on every render of a component; a hook placed after
// the early return runs only in the second render, and React stops the whole page (error #310, “这一页显示出错”).
//
// The workbench has no DOM test environment and browser regressions are not part of CI, so this renders the component's
// own body twice under a recording hook dispatcher: first with an empty query cache (snapshot not read), then with the
// screenshot fixture's snapshot cached (read back). Child components are not rendered; only SessionWorkspace's hooks count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { QueryClient, QueryClientContext } from "@tanstack/react-query";
import { queryKeys } from "../src/shared/query.ts";
import { SessionWorkspace } from "../src/features/sessions/SessionWorkspace.tsx";

type Dispatcher = Record<string, (...args: never[]) => unknown>;
const internals = (React as unknown as Record<string, { H: Dispatcher | null } | undefined>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
// The context TanStack Query reads its client from; the component's reads find the given cache through it.
const queryClientContext = QueryClientContext as React.Context<unknown>;

/** Runs SessionWorkspace's body once with `client` as its query cache; returns the hooks it called, in order. */
function renderHooks(props: Parameters<typeof SessionWorkspace>[0], client: QueryClient): string[] {
  const calls: string[] = [];
  const hook = (name: string, value: (...args: never[]) => unknown) => (...args: never[]) => { calls.push(name); return value(...args); };
  const context = (ctx: React.Context<unknown>) => ctx === queryClientContext ? client : (ctx as unknown as { _currentValue: unknown })._currentValue;
  const dispatcher: Dispatcher = {
    readContext: context as never, use: hook("use", context as never), useContext: hook("useContext", context as never),
    useState: hook("useState", ((init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => undefined]) as never),
    useReducer: hook("useReducer", ((_: unknown, init: unknown, make?: (value: unknown) => unknown) => [make ? make(init) : init, () => undefined]) as never),
    useRef: hook("useRef", ((current: unknown) => ({ current })) as never),
    useEffect: hook("useEffect", (() => undefined) as never), useLayoutEffect: hook("useLayoutEffect", (() => undefined) as never),
    useInsertionEffect: hook("useInsertionEffect", (() => undefined) as never), useImperativeHandle: hook("useImperativeHandle", (() => undefined) as never),
    useMemo: hook("useMemo", ((make: () => unknown) => make()) as never), useCallback: hook("useCallback", ((fn: unknown) => fn) as never),
    useSyncExternalStore: hook("useSyncExternalStore", ((_: unknown, read: () => unknown) => read()) as never),
    useId: hook("useId", (() => ":r0:") as never), useDebugValue: hook("useDebugValue", (() => undefined) as never),
    useDeferredValue: hook("useDeferredValue", ((value: unknown) => value) as never),
    useTransition: hook("useTransition", (() => [false, (run: () => void) => run()]) as never),
  };
  const previous = internals!.H;
  // tsx compiles the component's JSX to React.createElement, which the component itself does not import.
  const scope = globalThis as { React?: unknown };
  const hadReact = "React" in scope, previousReact = scope.React;
  scope.React = React;
  internals!.H = dispatcher;
  try { SessionWorkspace(props); } finally { internals!.H = previous; if (hadReact) scope.React = previousReact; else delete scope.React; }
  return calls;
}

test("the agent page calls the same hooks before and after its snapshot is read", async () => {
  assert.ok(internals && "H" in internals, "React's hook dispatcher is where this test expects it (React 19)");
  assert.ok(queryClientContext && "_currentValue" in (queryClientContext as object), "the query client context was found");
  const fixture = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
  const { projectId, agentKey, actorId } = await import(pathToFileURL(`${fixture}/common.mjs`).href);
  const { snapshot } = await import(pathToFileURL(`${fixture}/agents.mjs`).href);
  const sessionKey = agentKey("dev");
  const context = { projectId, token: "", blocked: false, principal: { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] },
    onAttempt: async () => true, onKnown: () => undefined, onChanged: () => undefined } as unknown as Parameters<typeof SessionWorkspace>[0]["context"];
  const props = { context, sessionKey, active: true, refresh: 0 };

  const empty = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const beforeRead = renderHooks(props, empty);

  const read = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  read.setQueryData(queryKeys.project(projectId, "session-work", sessionKey), snapshot("dev"));
  const afterRead = renderHooks(props, read);

  assert.ok(beforeRead.length > 10, `the first render ran the component's hooks (${beforeRead.length})`);
  assert.deepEqual(afterRead, beforeRead, `the snapshot changed the hooks: ${beforeRead.length} before it was read, ${afterRead.length} after`);
});
