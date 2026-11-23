// What the center shows instead of an object page while its address carries an id written short (Task 5eb93990): the prefix is
// looked up; exactly one object replaces the address with its full id (a replace, so Back never returns to the short one);
// none, several or a text that is no id is 找不到这个对象 with what was looked for and what to do. `/p/{project}/go/{text}` is the same
// lookup for any kind (GoPage). Neither shows 任务读取失败, which is for a task that exists and could not be read.
import * as React from "react";
import { Badge, Button, ErrorState, ListRow, LoadingState } from "@evoloop/ui";
import { jumpHint, type JumpMatch } from "@evoloop/contracts/object-jump";
import { api, errorText } from "../../shared/api";
import { navigate } from "../../shared/navigation";
import { href } from "../../shared/routes";
import { useProjectQuery } from "../../shared/query";
import { openJump } from "./jumpEvents";
import { jumpKindLabel, jumpRefusal, kindListSection, type ShortAddress } from "./jumpAddress";

const shell = "mx-auto flex w-full max-w-[880px] flex-col items-start gap-3 px-4 py-5 compact:px-8 compact:py-7";

function useLookup(token: string, projectId: string, text: string) {
  const refusal = jumpRefusal(text);
  const client = React.useMemo(() => api(token), [token]);
  const read = useProjectQuery(projectId, ["jump", text], signal => client.jump(projectId, text, signal), { enabled: !refusal, retry: false });
  return { refusal, read };
}

function NotFoundObject({ projectId, what, reason, text, matches, list }: {
  projectId: string; what: string; reason: string; text: string; matches?: readonly JumpMatch[]; list?: { section: keyof typeof listLabels; label: string };
}) {
  return <div data-ui="" data-not-found-object="" className={shell}>
    <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">找不到这个对象</h1>
    <p className="text-small text-text-secondary">地址里写的是 {what}。{reason}</p>
    {matches && matches.length > 0 && <ul aria-label="以它开头的对象" className="m-0 flex w-full max-w-[560px] list-none flex-col gap-0.5 p-0">
      {matches.map(match => <li key={`${match.kind}:${match.id}`}><ListRow href={match.href} leading={<Badge className="w-10 justify-start">{jumpKindLabel(match.kind)}</Badge>} title={match.title} meta={match.id.slice(0, 8)} /></li>)}
    </ul>}
    <div className="flex flex-wrap gap-2 pt-1">
      {list && <Button asChild variant="primary" size="compact"><a href={href(projectId, list.section)}>{list.label}</a></Button>}
      <Button size="compact" onClick={() => openJump(text)}>打开“跳到”</Button>
    </div>
  </div>;
}
const listLabels = { work: "回到任务列表", documents: "回到文档列表", sessions: "回到智能体", journey: "回到目标与阶段", schedules: "回到日程" } as const;

/** A task, document, agent, stage or schedule address whose id is written short. `active` is false for a page kept in the background: it looks nothing up. */
export function ResolveAddress({ token, projectId, short, active }: { token: string; projectId: string; short: ShortAddress; active: boolean }) {
  const { refusal, read } = useLookup(token, projectId, active ? short.text : "");
  const matches = (read.data?.matches ?? []).filter(match => match.kind === short.kind);
  const only = matches.length === 1 ? matches[0]! : null;
  React.useEffect(() => { if (active && only) navigate(short.withId(only.id), { replace: true }); }, [active, only, short]);
  const what = `${jumpKindLabel(short.kind)}「${short.text}」`;
  const list = { section: kindListSection[short.kind], label: listLabels[kindListSection[short.kind]] };
  if (!active) return null;
  if (refusal) return <NotFoundObject projectId={projectId} what={what} reason={`${refusal}。`} text={short.text} list={list} />;
  if (read.isError) return <div data-ui="" className={shell}><ErrorState title="没能查找这个对象" happened={errorText(read.error)} next="可以重新查找；查找失败不代表对象不存在。"
    action={<Button size="compact" onClick={() => void read.refetch()}>重新查找</Button>} /></div>;
  if (!read.data || only) return <div data-ui="" className={shell}><LoadingState lines={3} label="正在按编号查找…" /></div>;
  if (matches.length === 0) return <NotFoundObject projectId={projectId} what={what} reason={`本项目里没有以它开头的${jumpKindLabel(short.kind)}，可能拼错了，或者对象在别的项目里。`} text={short.text} list={list} />;
  return <NotFoundObject projectId={projectId} what={what} reason={`有 ${matches.length}${read.data.truncated ? " 个以上" : " 个"}${jumpKindLabel(short.kind)}以它开头，写长一点，或从下面选一个。`} text={short.text} matches={matches} list={list} />;
}

/** `/p/{project}/go/{text}`: the “跳到” box as a page, for a link that carries the text. */
export function GoPage({ token, projectId, text, active }: { token: string; projectId: string; text: string; active: boolean }) {
  const { refusal, read } = useLookup(token, projectId, active ? text : "");
  const matches = read.data?.matches ?? [];
  const only = matches.length === 1 ? matches[0]! : null;
  React.useEffect(() => { if (active && only) navigate(only.href, { replace: true }); }, [active, only]);
  if (!active) return null;
  if (refusal) return <NotFoundObject projectId={projectId} what={`「${text}」`} reason={`${refusal}。`} text={text} />;
  if (read.isError) return <div data-ui="" className={shell}><ErrorState title="没能查找这个对象" happened={errorText(read.error)} next="可以重新查找；查找失败不代表对象不存在。"
    action={<Button size="compact" onClick={() => void read.refetch()}>重新查找</Button>} /></div>;
  if (!read.data || only) return <div data-ui="" className={shell}><LoadingState lines={3} label="正在按编号查找…" /></div>;
  if (matches.length === 0) return <NotFoundObject projectId={projectId} what={`「${text}」`} reason={`${jumpHint.none(text)}。`} text={text} />;
  return <NotFoundObject projectId={projectId} what={`「${text}」`} reason={`有 ${matches.length}${read.data.truncated ? " 个以上" : " 个"}对象以它开头，从下面选一个。`} text={text} matches={matches} />;
}
