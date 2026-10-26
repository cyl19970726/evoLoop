import { useEffect, useState } from "react";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { errorText } from "../api";
import { roleClient } from "../roles/client";
import { option } from "./ActionForm";

/** Current Role choices are read from the project; a partial list is never offered as complete. */
export function useRoleChoices(token: string, projectId: string, refresh: number, enabled = true) {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true); setError(""); setRoles([]);
    async function read() {
      try {
        const result: RoleRecord[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
          const page = await roleClient(token, projectId).list(cursor);
          if (page.items.some(role => role.projectId !== projectId)) throw new Error("职责响应与当前项目不符");
          result.push(...page.items);
          if (!page.nextCursor) { if (active) setRoles([...new Map(result.map(role => [role.id, role])).values()]); return; }
          if (seen.has(page.nextCursor)) throw new Error("职责列表分页游标重复");
          seen.add(page.nextCursor); cursor = page.nextCursor;
        }
        throw new Error("职责超过自动读取上限，无法完整选择；请先缩小项目范围");
      } catch (cause) { if (active) setError(errorText(cause)); }
      finally { if (active) setLoading(false); }
    }
    void read();
    return () => { active = false; };
  }, [token, projectId, refresh, enabled]);
  return { roles, error, loading, options: roles.filter(role => role.state === "active" || role.state === "trial").map(role => option(role.id, `${role.proposal.title} · ${role.state === "trial" ? "试行" : "使用中"}`)) };
}
