import { useEffect, useState } from "react";
import type { RoleRecord, RoleSessionBinding } from "@evoloop/contracts/roles";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { ApiError, errorText, request } from "../api";
import { href } from "../ui/shared";
import { isRoleOwnerId, readOwnerRole } from "./ownerRole";
import "./task-owner.css";

const sessionState: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态未知", closed: "已关闭",
};

export function TaskOwner({ token, projectId, owner, readKey }: { token: string; projectId: string; owner: string; readKey: string }) {
  const [role, setRole] = useState<RoleRecord | null>(null);
  const [roleError, setRoleError] = useState("");
  const [sessions, setSessions] = useState<RuntimeSessionRecord[]>([]);
  const [sessionNote, setSessionNote] = useState("");
  const [reading, setReading] = useState(false);
  useEffect(() => {
    let active = true;
    setRole(null); setRoleError(""); setSessions([]); setSessionNote(""); setReading(isRoleOwnerId(owner));
    if (!isRoleOwnerId(owner)) return () => { active = false; };
    const base = `/api/projects/${encodeURIComponent(projectId)}`;
    void (async () => {
      try {
        const found = await readOwnerRole(token, projectId, owner);
        if (!active) return;
        setRole(found);
        try {
          const [bindings, registered] = await Promise.all([
            request<RoleSessionBinding[]>(token, `${base}/roles/${encodeURIComponent(owner)}/bindings`, 15000),
            request<RuntimeSessionRecord[]>(token, `${base}/runtime/sessions`, 15000),
          ]);
          if (!active) return;
          if (bindings.some(item => item.projectId !== projectId || item.roleId !== owner) || registered.some(item => item.projectId !== projectId))
            throw new Error("会话关联响应与当前项目不符");
          const bound = new Set(bindings.map(item => item.sessionId));
          const verified = registered.filter(item => bound.has(item.id) && item.roleId === owner);
          setSessions(verified);
          if (bound.size > verified.length)
            setSessionNote("部分绑定记录未能核对到同项目、同职责的会话；未提供其入口。");
          else if (bound.size === 0) setSessionNote("未登记绑定会话。");
        } catch (cause) { if (active) setSessionNote(`会话关联暂不可核对：${errorText(cause)}`); }
      } catch (cause) {
        if (active) setRoleError(cause instanceof ApiError && cause.status === 404 ? "未找到已登记职责" : `职责暂不可核对：${errorText(cause)}`);
      } finally { if (active) setReading(false); }
    })();
    return () => { active = false; };
  }, [token, projectId, owner, readKey]);
  return <span className="task-owner-meta">
    <span>责任者：{role ? <><a href={href(projectId, "roles")}>{role.proposal.title}</a> <code title={role.id}>{role.id.slice(0, 8)}</code></> : <code>{owner}</code>}
      {reading && <small> · 正在核对职责与会话…</small>}
      {roleError && <small> · {roleError}</small>}</span>
    {role && <span className="task-owner-sessions">
      {sessions.map(item => <a key={item.id} href={`${href(projectId, "runtime")}?session=${encodeURIComponent(item.id)}`}>已登记 Session {item.id.slice(0, 8)}（{sessionState[item.state]}）</a>)}
      {sessionNote && <small>{sessionNote}</small>}
      {sessions.length > 0 && <small>职责绑定不表示此任务正在该会话运行。</small>}
    </span>}
  </span>;
}
