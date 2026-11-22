// A message between the Leader and the agent (a dispatch notice, an execution confirmation request, ...) as one line:
// "类型 · 任务标题 · 时间 ›", the full text one click away in place. Three or more in a row are one group. The agent's answer
// is drawn by the round right under the line, so nothing here hides it.
import { Button, CollapsibleRow, cn } from "@evoloop/ui";
import { date } from "../../shared/ui/shared";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { readingProse } from "../../shared/ui/readingProse";
import { coordinationSummary, type Round } from "./timelineRounds";
import { sentAndStarted, sentStartedText } from "./roundPresentation";

interface LineProps {
  round: Round;
  projectId: string;
  titleOf(taskId: string): string | null;
  taskHref(taskId: string): string;
  onMessage(messageId: string): void;
  /** Inside a group the lines share the group's indent. */
  nested?: boolean;
}

export function CoordinationLine({ round, projectId, titleOf, taskHref, onMessage, nested }: LineProps) {
  const summary = coordinationSummary(round, titleOf);
  const body = round.input && round.input.kind === "message" && round.input.body ? round.input.body : round.fact?.content ?? "";
  const times = sentStartedText(sentAndStarted(round));
  const id = round.input?.id ?? round.key;
  return <article aria-label="统筹的协调消息" className={cn("workspace-coordination min-w-0 text-small", !nested && "pl-[38px]")} data-workspace-entry={id} data-coordination-line="" data-turn-id={round.turnId ?? undefined}>
    <CollapsibleRow summary={<span>{summary.type} · {summary.title}{summary.at ? <> · <time dateTime={summary.at}>{date(summary.at)}</time></> : ""}</span>}>
      <div className="flex min-w-0 flex-col gap-1.5 pb-1">
        {times && <p className="text-caption text-muted-foreground">{times}</p>}
        {body ? <div className={readingProse}><MarkdownBody source={body} identity={`coordination-${id}`} projectId={projectId} topHeading={4} /></div>
          : <p className="text-caption text-muted-foreground">没有读到这条消息的正文。</p>}
        <div className="flex flex-wrap gap-x-3 text-caption">
          {round.taskId && <a className="text-primary hover:underline" href={taskHref(round.taskId)}>查看任务</a>}
          {round.messageId && <Button variant="link" className="text-caption" onClick={() => onMessage(round.messageId!)}>消息详情</Button>}
        </div>
      </div>
    </CollapsibleRow>
  </article>;
}

export function CoordinationGroup({ rounds, ...rest }: Omit<LineProps, "round"> & { rounds: Round[] }) {
  return <article aria-label="统筹的协调消息组" className="workspace-coordination-group min-w-0 pl-[38px] text-small" data-workspace-entry={rounds[0]!.input?.id ?? rounds[0]!.key} data-coordination-group="">
    <CollapsibleRow summary={<span>Leader 的 {rounds.length} 条协调消息</span>}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {rounds.map(round => <CoordinationLine key={round.key} round={round} nested {...rest} />)}
      </div>
    </CollapsibleRow>
  </article>;
}
