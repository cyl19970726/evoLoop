// Typography for a full Markdown text read in the center (documents, knowledge), on design tokens only.
// MarkdownBody keeps its own rendering and link rules; this only sets type, spacing and code/table blocks.
import { cn } from "@evoloop/ui";

export const readingProse = cn("text-body leading-(--leading-reading) text-foreground",
  "[&_:is(p,li,td,th,h1,h2,h3,h4,dt,dd)]:text-foreground",
  "[&_h1]:mb-3 [&_h1]:mt-9 [&_h1]:text-heading [&_h1]:font-semibold [&_h1]:leading-(--leading-tight)",
  "[&_h2]:mb-3 [&_h2]:mt-9 [&_h2]:text-heading [&_h2]:font-semibold [&_h2]:leading-(--leading-tight)",
  "[&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-body [&_h3]:font-semibold",
  "[&_h4]:mb-2 [&_h4]:mt-6 [&_h4]:font-semibold",
  "[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-1",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-small",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-small [&_pre]:leading-(--leading-body) [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5");

/** The Markdown source shown beside the typeset text (原文). */
export const readingSource = "overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-small leading-(--leading-body) [overflow-wrap:anywhere]";
