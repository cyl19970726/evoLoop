// A managed agent by its name as the agent pages say it (agentDisplayName: its registered name, else its role); until
// the name is read a placeholder in words, never the identifier's first characters. The identifier itself stays in the
// full-identifier layer.
import { useSessionName } from "../../shared/ui/RecordName";
import { nameOnly } from "../../shared/workPresentation";

export function useAgentName(projectId: string, sessionId: string): string {
  return nameOnly("智能体", useSessionName(projectId, `owned:${sessionId}`));
}

export function AgentName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <>{useAgentName(projectId, sessionId)}</>;
}
