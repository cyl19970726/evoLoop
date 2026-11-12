// A sign-in identity chosen from the project's members by name (shared/memberPresentation.ts), with the full identity
// typed under a folded “按完整标识填写” for when names are not enough (service identities such as a loop controller or
// a gateway sender are members too), while the list is still being read, or when no list can be read. The value stays
// the plain identity string the form keeps, so drafts, baselines and the request body are the same as when it was
// typed. While the list is read nothing is concluded; when it cannot be read, or the service has no member list, the
// identity is typed. A place that must name someone (必须本人验收) offers no empty choice.
import { Button, Input, Notice, Select } from "@evoloop/ui";
import { errorText } from "../api";
import { useFormPending } from "../command/CommandForm";
import { memberChoices, memberPlaceholder, type MemberKind, type MemberNeed } from "../memberPresentation";
import { useProjectMembers } from "../projectConfiguration";
import { FullIdentifiers } from "./FullIdentifiers";

type Control = { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined };
const note = "m-0 text-caption text-muted-foreground";

export function MemberChoice({ projectId, control, value, onChange, need, kind = null, optional = false, noneLabel = "不指定" }: {
  projectId: string; control: Control; value: string; onChange(value: string): void;
  /** What the chosen member must be able to do here. */
  need: MemberNeed;
  /** 人 or 智能体 only, when the place takes one kind. */
  kind?: MemberKind;
  optional?: boolean;
  /** The empty choice of an optional field. */
  noneLabel?: string;
}) {
  const read = useProjectMembers(projectId);
  // The form around this choice does not send while the member list is still being read.
  useFormPending(read.data || read.isError ? null : "正在读取本项目的成员，读回后才能提交。");
  const choices = read.data ? memberChoices(read.data, need, kind, value) : null;
  // The identity is typed instead of chosen when the list cannot be read or the service has none; while the list is still being read it can be typed too.
  const typedMode = (!read.data && read.isError) || choices?.mode === "typed";
  // One tree in every state (reading, read, unreadable): the typed field keeps its place and key, so what is typed meanwhile and its focus survive the list
  // turning into a failure. Only the parts around it come and go.
  const typedInput = <Input key="typed" {...typedMode ? control : { "aria-label": "完整标识" }} value={value} autoComplete="off" spellCheck={false}
    placeholder="登录身份，例如 zhang-reviewer" onChange={event => onChange(event.target.value)} />;
  const typedFold = <details key="fold" open={typedMode ? true : undefined} className="text-caption text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">按完整标识填写</summary>
    <div className="mt-1.5 flex min-w-0 flex-col gap-1">
      <p className={note}>名称相同、要指定服务身份（例如自动循环的控制者、网关发送者），或成员还没读回时，按完整的登录身份填写。</p>
      {typedInput}
    </div>
  </details>;
  return <div className="flex min-w-0 flex-col gap-1.5" data-member-choice="">
    {!read.data && read.isError && <Notice key="unreadable" tone="error" action={<Button size="compact" variant="ghost" onClick={() => void read.refetch()}>重新读取</Button>}>
      本项目的成员没有读回：{errorText(read.error)}。读回之前无法判断谁可选，可以按完整标识填写。</Notice>}
    {choices?.mode === "typed" && <>
      {choices.notice && <Notice key="typed-notice" tone={choices.notice.tone} title={choices.notice.title}>{choices.notice.text}</Notice>}
      <FullIdentifiers key="typed-code" rows={[{ label: "原因代码", value: choices.code }]} /></>}
    {!typedMode && read.stale && <Notice key="stale" tone="waiting" title="上次读回，当前待核对">成员清单重新读取失败：{errorText(read.error)}。</Notice>}
    {!typedMode && choices?.notice && <Notice key="choices-notice" tone={choices.notice.tone} title={choices.notice.title}>{choices.notice.text}
      {choices.pending.length > 0 && <ul className="m-0 mt-1 list-none p-0">{choices.pending.map(line => <li key={line}>{line}</li>)}</ul>}</Notice>}
    {!typedMode && (choices ? <Select key="select" {...control} className="w-full" value={value.trim()} onChange={event => onChange(event.target.value)}>
      <option value="" disabled={!optional}>{memberPlaceholder(choices, optional, noneLabel)}</option>
      {choices.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </Select>
      // Still being read: nothing is concluded, and the identity can be typed meanwhile.
      : <Select key="select" {...control} className="w-full" value={value.trim()} disabled>
        <option value="">正在读取本项目的成员…</option>
        {value.trim() && <option value={value.trim()}>{value.trim()}（当前所填）</option>}
      </Select>)}
    {!typedMode && choices?.leftOut && <p key="left-out" className={note}>{choices.leftOut}</p>}
    {typedFold}
  </div>;
}
