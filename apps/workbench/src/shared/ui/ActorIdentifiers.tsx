// The full value of the people in a line that `actorText` says in words (未登记名称的身份, 自动执行方, 日程), under
// 完整标识. Nothing is drawn when every actor is an account name the line already shows.
import { actorRow } from "../actorPresentation";
import { FullIdentifiers } from "./FullIdentifiers";

export function ActorIdentifiers({ actors, className }: { actors: Array<[label: string, actorId: string | null | undefined]>; className?: string }) {
  return <FullIdentifiers className={className} summary="记录者的完整标识" rows={actors.map(([label, actorId]) => actorRow(label, actorId))} />;
}
