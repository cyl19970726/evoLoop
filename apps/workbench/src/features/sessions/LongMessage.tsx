import { useState } from "react";
import { Button } from "@evoloop/ui";
import { foldMessage, messageSegments } from "./longText";

/**
 * A message a person sent: wrapped anywhere (a long path never widens the bubble), folded after a few lines, and a fenced block
 * drawn as code that scrolls on its own instead of stretching the bubble.
 */
export function LongMessage({ text, identity }: { text: string; identity: string }) {
  const [open, setOpen] = useState(false);
  const fold = foldMessage(text);
  const shown = open || !fold.folded ? text : fold.head;
  return <>
    {messageSegments(shown).map((part, index) => part.kind === "code"
      ? <pre key={`${identity}:${index}`} className="my-1 max-w-full overflow-x-auto rounded-sm bg-current/10 px-2 py-1 font-mono text-caption leading-(--leading-body)" data-message-code=""><code>{part.value}</code></pre>
      : <span key={`${identity}:${index}`} className="block min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{part.value}</span>)}
    {fold.folded && <Button variant="link" className="mt-1 h-auto p-0 text-caption text-current underline" aria-expanded={open} onClick={() => setOpen(value => !value)} data-message-fold="">
      {open ? "收起" : `展开，还有 ${fold.hiddenLines} 行`}</Button>}
  </>;
}
