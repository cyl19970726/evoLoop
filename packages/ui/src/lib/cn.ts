import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme adds font sizes (text-caption … text-title) and colours (text-text-secondary, bg-field …). Without this,
// tailwind-merge reads text-small as a colour and drops whichever of it and text-foreground comes first.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "label", "small", "body", "heading", "title"] }],
    },
  },
});

/** Joins class names and lets later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
