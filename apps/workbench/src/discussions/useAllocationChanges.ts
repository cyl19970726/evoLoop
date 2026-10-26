import { useEffect, useRef, useState } from "react";
import type { SessionChanges } from "@evoloop/contracts/session-observation";
import { errorText } from "../api";
import { sessionClient } from "../sessions/client";

export function allocationChangeRequiresReload(changes: SessionChanges): boolean {
  return changes.resetRequired || changes.items.length > 0 || changes.hasMore;
}

/** Watch the project journal: a Session-only filter misses Discussion, Task and Document changes. */
export function useAllocationChanges(token: string, projectId: string, onChange: () => void): string {
  const [error, setError] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    setError("");
    const controller = new AbortController();
    const client = sessionClient(token, projectId);
    let cursor: string | null = null, checking = false;
    async function baseline() {
      const directory = await client.directory({ limit: 1 }, controller.signal);
      if (controller.signal.aborted) return;
      if (!directory.observationCursor) throw new Error("项目变化位置未返回");
      cursor = directory.observationCursor;
      setError("");
      // Read the relation after the cursor: any intervening write remains visible to the next check.
      onChangeRef.current();
    }
    async function check() {
      if (controller.signal.aborted || document.visibilityState === "hidden" || checking) return;
      checking = true;
      try {
        if (!cursor) await baseline();
        else {
          const changes = await client.changes(cursor, undefined, controller.signal);
          if (controller.signal.aborted) return;
          if (allocationChangeRequiresReload(changes)) {
            await baseline();
            if (changes.metadata.partial) setError("项目变化来源不完整，已重新核对关系；仍须留意来源限制。");
          } else {
            if (!changes.metadata.partial) cursor = changes.nextCursor;
            setError(changes.metadata.partial
              ? "项目变化来源不完整，无法确认关系是否仍是最新；保留上次读数，可手动重新读取。" : "");
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(`项目变化读取失败：${errorText(cause)}。保留上次关系读数。`);
      } finally { checking = false; }
    }
    void check();
    const timer = window.setInterval(() => void check(), 15000);
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [token, projectId]);
  return error;
}
