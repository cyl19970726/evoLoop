// “跳到” (Task 5eb93990, docs/frontend/layout.md 导航与项目范围): one small box for the whole project. Paste an id (8 digits or more),
// a full id or a PR number and press Enter: exactly one match opens it; several are listed to choose from with the arrow keys;
// none says so and stays where you are. ⌘K / Ctrl+K or the shell's button opens it, Esc closes it and focus returns to where it was.
import * as React from "react";
import { Badge, Dialog, DialogContent, DialogDescription, DialogTitle, Input, ListRow, cn } from "@evoloop/ui";
import { jumpHint, type JumpMatch } from "@evoloop/contracts/object-jump";
import { api, errorText } from "../../shared/api";
import { navigate } from "../../shared/navigation";
import { onOpenJump, takePendingJump } from "./jumpEvents";
import { jumpKindLabel, jumpRefusal } from "./jumpAddress";

type Answer =
  | { phase: "idle" }
  | { phase: "loading" }
  /** No request was made, or the service found nothing: the sentence to show. */
  | { phase: "message"; text: string }
  | { phase: "choose"; matches: JumpMatch[]; truncated: boolean }
  | { phase: "error"; text: string };

export function JumpDialog({ token, projectId }: { token: string; projectId: string }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [answer, setAnswer] = React.useState<Answer>({ phase: "idle" });
  const [active, setActive] = React.useState(0);
  const client = React.useMemo(() => api(token), [token]);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const restoreFocus = React.useRef(true);
  const inFlight = React.useRef<AbortController | null>(null);
  const listId = React.useId();

  React.useEffect(() => {
    const show = (initial: string, from: HTMLElement | null) => {
      takePendingJump();
      returnFocus.current = from; restoreFocus.current = true;
      setText(initial); setAnswer({ phase: "idle" }); setActive(0); setOpen(true);
    };
    const waiting = takePendingJump();
    if (waiting) show(waiting.initial, waiting.from);
    return onOpenJump(show);
  }, []);
  React.useEffect(() => { if (!open) inFlight.current?.abort(); }, [open]);
  // Another project is another box: nothing typed or found here carries over.
  const shownFor = React.useRef(projectId);
  React.useEffect(() => {
    if (shownFor.current === projectId) return;
    shownFor.current = projectId; setOpen(false); setText(""); setAnswer({ phase: "idle" });
  }, [projectId]);

  const go = (match: JumpMatch) => { restoreFocus.current = false; setOpen(false); navigate(match.href); };
  async function submit() {
    const value = text.trim();
    if (!value) { setAnswer({ phase: "message", text: "写一个编号（8 位以上）或 PR 号，再按回车。" }); return; }
    const refusal = jumpRefusal(value);
    if (refusal) { setAnswer({ phase: "message", text: refusal }); return; }
    inFlight.current?.abort();
    const controller = inFlight.current = new AbortController();
    setAnswer({ phase: "loading" });
    try {
      const result = await client.jump(projectId, value, controller.signal);
      if (controller.signal.aborted) return;
      if (result.matches.length === 0) setAnswer({ phase: "message", text: jumpHint.none(value) });
      else if (result.matches.length === 1) go(result.matches[0]!);
      else { setActive(0); setAnswer({ phase: "choose", matches: result.matches, truncated: result.truncated }); }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setAnswer({ phase: "error", text: `没能查找：${errorText(cause)}` });
    }
  }
  const choosing = answer.phase === "choose";
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (answer.phase === "choose" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const size = answer.matches.length;
      setActive(index => (index + (event.key === "ArrowDown" ? 1 : size - 1)) % size);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (answer.phase === "choose") go(answer.matches[active]!); else void submit();
    }
  };
  const optionId = (index: number) => `${listId}-option-${index}`;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent data-jump="" className="gap-3 p-4 compact:w-[min(560px,calc(100vw-32px))]" onCloseAutoFocus={event => {
      event.preventDefault();
      if (!restoreFocus.current) return;
      const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("workspace-main");
      target?.focus({ preventScroll: true });
    }}>
      <DialogTitle className="sr-only">跳到</DialogTitle>
      <DialogDescription className="sr-only">贴一个短编号（8 位以上）、完整编号或 PR 号，按回车直接打开那个对象。</DialogDescription>
      <Input autoFocus role="combobox" aria-label="跳到：编号或 PR 号" aria-autocomplete="list" aria-expanded={choosing} aria-controls={listId}
        aria-activedescendant={choosing ? optionId(active) : undefined} placeholder="编号前 8 位、完整编号或 #PR 号" autoComplete="off" spellCheck={false}
        value={text} onChange={event => { setText(event.target.value); setAnswer({ phase: "idle" }); }} onKeyDown={onKeyDown} className="pr-14 pl-3" />
      <div aria-live="polite" role="status" className={cn("min-h-5 text-small text-text-secondary", answer.phase === "idle" && "sr-only")}>
        {answer.phase === "loading" ? "正在查找…" : answer.phase === "message" || answer.phase === "error" ? answer.text
          : choosing ? `有 ${answer.matches.length}${answer.truncated ? " 个以上" : " 个"}对象，用上下键选，回车打开` : answer.phase === "idle" ? "按回车查找" : ""}
      </div>
      <ul id={listId} role="listbox" aria-label="匹配的对象" hidden={!choosing} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {choosing && answer.matches.map((match, index) => <li key={`${match.kind}:${match.id}`} id={optionId(index)} role="option" aria-selected={index === active}
          onMouseMove={() => setActive(index)} onClick={() => go(match)} className="cursor-pointer">
          <ListRow selected={index === active} leading={<Badge className="w-10 justify-start">{jumpKindLabel(match.kind)}</Badge>} title={match.title} meta={match.id.slice(0, 8)} />
        </li>)}
      </ul>
    </DialogContent>
  </Dialog>;
}
