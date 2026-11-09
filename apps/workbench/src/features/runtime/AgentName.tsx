// A managed agent by its registered name; until the name is read (or when none is registered) a placeholder in words,
// never the identifier's first characters. The identifier itself stays in the full-identifier layer.
import { useSessionName } from "../../shared/ui/RecordName";
import { nameOnly } from "../../shared/workPresentation";

export function useAgentName(projectId: string, sessionId: string): string {
  return nameOnly("智能体", useSessionName(projectId, `owned:${sessionId}`));
}

export function AgentName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <>{useAgentName(projectId, sessionId)}</>;
}
