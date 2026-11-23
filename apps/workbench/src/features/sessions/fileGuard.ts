// Pasting or dropping a file or an image into the agent page (Task 5415aed3): attachments are not supported yet, so nothing is sent and the
// browser must not open the file and leave the workbench. The page says so in one line the person can close.
import { useCallback, useEffect, useRef, useState } from "react";

export const filesNotSent = "现在还不能附图片或文件";

/** A pasted image has no name of its own (the browser calls it image.png); say where it came from instead. */
export function fileLabel(file: { name: string; type: string }): string {
  if (file.type.startsWith("image/") && (!file.name || /^image\.\w+$/i.test(file.name))) return "剪贴板里的图片";
  return file.name || "这个文件";
}

export function noticeFor(files: readonly { name: string; type: string }[]): string {
  const labels = [...new Set(files.map(fileLabel))];
  const named = labels.length > 3 ? `${labels.slice(0, 3).join("、")} 等 ${labels.length} 项` : labels.join("、");
  return `${filesNotSent}，${named}没有发送。可以把内容贴成文字，或让智能体去读工作区里的路径。`;
}

/** A drag carries a file when its types say so (the contents are not readable before the drop). */
export const dragHasFiles = (transfer: { types: readonly string[] } | null | undefined): boolean => !!transfer && [...transfer.types].includes("Files");

/**
 * While the agent page is open a dragged file is refused everywhere on it: the browser's own "open this file" is stopped, the box shows that nothing
 * can be dropped, and a drop says the file was not sent. Text dragged into the box is not touched.
 */
export function useFileGuard() {
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    const enter = (event: DragEvent) => { if (dragHasFiles(event.dataTransfer)) { depth.current += 1; setDragging(true); } };
    const leave = (event: DragEvent) => { if (dragHasFiles(event.dataTransfer)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); } };
    const drop = (event: DragEvent) => {
      depth.current = 0; setDragging(false);
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setNotice(noticeFor([...(event.dataTransfer?.files ?? [])]));
    };
    const end = () => { depth.current = 0; setDragging(false); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop); window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop); window.removeEventListener("dragend", end);
    };
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, dragging, setNotice, dismiss };
}
