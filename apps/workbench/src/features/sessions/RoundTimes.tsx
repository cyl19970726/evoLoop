import { date } from "../../shared/ui/shared";
import type { SentStarted } from "./roundPresentation";

/** The time of a message line: when it was sent, with when processing began beside it when that is another moment. */
export function RoundTimes({ times }: { times: SentStarted }) {
  const { sent, started } = times;
  if (!sent && !started) return null;
  return <span className="workspace-times" data-sent-at={sent ?? undefined}>
    {sent && <time dateTime={sent}>发出 {date(sent)}</time>}
    {started && <>{sent ? " · " : ""}<time dateTime={started}>开始处理 {date(started)}</time></>}
  </span>;
}
