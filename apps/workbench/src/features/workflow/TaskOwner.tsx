// 负责职责与同职责的其他智能体 (tasks.md 当前工作): the task's owner Role, read by its exact identifier, and the managed
// agents bound to that Role in this project. A Role is the standing division of work; who takes this task is in the
// right column, so a bound agent is never presented as running it. Until the Role is confirmed no agent link is offered.
import { useEffect, useRef } from "react";
import type { RoleSessionBinding } from "@evoloop/contracts/roles";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { errorText, request } from "../../shared/api";
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { hereOrigin, withReturn } from "../../shared/returnLink";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { useSessionName } from "../../shared/ui/RecordName";
import { href } from "../../shared/ui/shared";
import { nameOnly } from "../../shared/workPresentation";
import { boundAgents, ownerRoleProblem, ownerSessionState } from "./taskOwnerPresentation";

const note = "text-caption text-muted-foreground";
const link = "text-primary hover:underline";

function AgentLink({ projectId, session, actorId }: { projectId: string; session: RuntimeSessionRecord; actorId?: string | undefined }) {
  const key = `owned:${session.id}`;
  const name = nameOnly("智能体", useSessionName(projectId, key));
  return <a className={link} href={withReturn(`${href(projectId, "sessions")}?session=${encodeURIComponent(key)}`, actorId ? hereOrigin(actorId) : null)}>{name}（{ownerSessionState[session.state]}）</a>;
}

export function TaskOwner({ projectId, owner, readKey, onResolved, actorId }: {
  projectId: string; owner: string; readKey: string;
  onResolved?: (title: string | null) => void;
  /** The reader, so a link to one of the agents comes back here. */
  actorId?: string;
}) {
  const isRole = isRoleOwnerId(owner);
  // Same key and value as the role names elsewhere (useRoleName), so they share one read.
  const role = useProjectQuery(projectId, ["role", owner, "title"], signal => readOwnerRole("", projectId, owner, signal), { enabled: isRole });
  const confirmed = !!role.data && !role.error;
  const bindings = useProjectQuery(projectId, ["role", owner, "bindings"], signal => request<RoleSessionBinding[]>("",
    `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(owner)}/bindings`, 15000, { signal }), { enabled: confirmed });
  // Its own key: the other readers of the agent list drop records of other projects, while this check reports them.
  const sessions = useProjectQuery(projectId, ["runtime", "sessions", "owner-check"], () => runtimeClient("", projectId).sessions(), { enabled: confirmed });
  // “重新读取当前任务” moves readKey: the owner is checked again with the task.
  const firstKey = useRef(readKey);
  useEffect(() => {
    if (firstKey.current === readKey || !isRole) return;
    firstKey.current = readKey;
    void role.refetch(); void bindings.refetch(); void sessions.refetch();
  }, [readKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = confirmed ? role.data!.proposal.title.trim() || null : null;
  useEffect(() => { onResolved?.(title); }, [title]); // eslint-disable-line react-hooks/exhaustive-deps
  let agents: ReturnType<typeof boundAgents> | null = null, agentProblem = "";
  if (bindings.error || sessions.error) agentProblem = `智能体关联暂不可核对：${errorText(bindings.error ?? sessions.error)}`;
  else if (bindings.data && sessions.data) {
    try { agents = boundAgents(projectId, owner, bindings.data, sessions.data); }
    catch (cause) { agentProblem = `智能体关联暂不可核对：${errorText(cause)}`; }
  }
  return <div data-task-owner-facts="" className="flex min-w-0 flex-col gap-2 text-label text-foreground [overflow-wrap:anywhere]">
    <p>负责职责：{!isRole ? owner
      : confirmed ? <a className={link} href={`${href(projectId, "roles")}?role=${encodeURIComponent(owner)}`}>{role.data!.proposal.title}</a>
        : role.data ? <>{role.data.proposal.title}<span className={note}>（上次读回，当前待核对）</span></>
          : role.error ? <span className="text-text-secondary">{ownerRoleProblem(role.error)}</span>
            : <span className={note}>正在核对职责…</span>}</p>
    {isRole && role.error && role.data && <p className={note} role="status">{ownerRoleProblem(role.error)}。职责核对前不提供同职责智能体的入口。</p>}
    {confirmed && <div className="flex flex-col gap-1">
      <p className={note}>同职责的其他智能体</p>
      {agentProblem ? <p className={note} role="status">{agentProblem}</p>
        : !agents ? <p className={note}>正在核对绑定的智能体…</p>
          : <>
            {agents.agents.length > 0 && <ul className="flex flex-wrap gap-x-4 gap-y-1">{agents.agents.map(session => <li key={session.id}><AgentLink projectId={projectId} session={session} actorId={actorId} /></li>)}</ul>}
            {agents.note && <p className={note}>{agents.note}</p>}
            {agents.agents.length > 0 && <p className={note}>职责绑定不表示此任务正由该智能体运行。</p>}
          </>}
    </div>}
    <FullIdentifiers rows={[{ label: isRole ? "负责职责" : "责任者", value: owner },
      ...(agents?.agents ?? []).map(session => ({ label: "绑定的智能体", value: session.id }))]} />
  </div>;
}
