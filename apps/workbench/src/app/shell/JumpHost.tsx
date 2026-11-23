// What the shell holds of “跳到”: the two buttons, ⌘K / Ctrl+K, and the place the box mounts. The box itself (dialog, list, lookup)
// loads the first time it is asked for, so the first-load bundle carries only this.
import * as React from "react";
import { Search } from "lucide-react";
import { Button, IconButton, cn } from "@evoloop/ui";
import { lazyChunk } from "../chunkLoad";
import { isJumpShortcut, jumpShortcutLabel, onOpenJump, openJump } from "../../features/jump/jumpEvents";

const Box = lazyChunk(() => import("../../features/jump/JumpDialog"), "JumpDialog");

export function JumpHost({ token, projectId }: { token: string; projectId: string }) {
  const [wanted, setWanted] = React.useState(false);
  React.useEffect(() => onOpenJump(() => setWanted(true)), []);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (isJumpShortcut(event)) { event.preventDefault(); openJump(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return wanted ? <React.Suspense fallback={null}><Box token={token} projectId={projectId} /></React.Suspense> : null;
}

/** The shell's way in on a wide screen: under the project switcher, with the shortcut written on it. */
export function JumpButton({ className }: { className?: string }) {
  return <Button type="button" size="compact" aria-label="跳到：按编号或 PR 号打开对象" aria-keyshortcuts="Control+K Meta+K" onClick={() => openJump()}
    className={cn("w-full justify-start gap-2 font-normal text-text-secondary", className)}>
    <Search aria-hidden="true" />跳到…<kbd className="ml-auto rounded-sm bg-field px-1.5 text-caption text-muted-foreground">{jumpShortcutLabel()}</kbd>
  </Button>;
}

/** The phone header's way in: the same box. */
export function JumpIconButton() {
  return <IconButton label="跳到：按编号或 PR 号打开对象" icon={<Search size={19} />} aria-keyshortcuts="Control+K Meta+K" onClick={() => openJump()} />;
}
