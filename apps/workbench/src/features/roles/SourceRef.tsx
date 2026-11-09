// An evidence source as a reader follows it: a task is named by its title and linked; other sources are shown as
// written. The task's identifier stays in the link, never in the text.
import { useTaskName } from "../../shared/ui/RecordName";
import { href } from "../../shared/ui/shared";
import { nameOnly } from "../../shared/workPresentation";
import { sourceRefTaskId } from "./rolePresentation";

export function TaskLink({ projectId, taskId }: { projectId: string; taskId: string }) {
  return <a href={href(projectId, "task", taskId)} className="text-primary hover:underline">{nameOnly("任务", useTaskName(projectId, taskId))}</a>;
}

export function SourceRef({ projectId, sourceRef }: { projectId: string; sourceRef: string }) {
  const taskId = sourceRefTaskId(sourceRef);
  return taskId ? <TaskLink projectId={projectId} taskId={taskId} /> : <span className="break-all">{sourceRef}</span>;
}

/** Several sources, separated as a reader would list them. */
export function SourceRefs({ projectId, refs }: { projectId: string; refs: string[] }) {
  if (!refs.length) return <>未列出</>;
  return <>{refs.map((ref, index) => <span key={`${index}:${ref}`}>{index ? "；" : ""}<SourceRef projectId={projectId} sourceRef={ref} /></span>)}</>;
}
