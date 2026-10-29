/** Only image decoder contexts receive these bytes; originals and manifests stay unchanged. */
export function imagePreview(mediaType: string, base64: string): { mediaType: string; mismatch: boolean } | null {
  if (!mediaType.startsWith("image/")) return null;
  let head: string;
  try { head = atob(base64.slice(0, 32)); } catch { return null; }
  const starts = (...values: number[]) => values.every((value, index) => head.charCodeAt(index) === value);
  const actual = starts(137, 80, 78, 71, 13, 10, 26, 10) ? "image/png"
    : starts(255, 216, 255) ? "image/jpeg"
      : /^(GIF87a|GIF89a)/.test(head) ? "image/gif"
        : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" ? "image/webp" : null;
  if (actual) return { mediaType: actual, mismatch: actual !== mediaType };
  return mediaType === "image/svg+xml" ? { mediaType, mismatch: false } : null;
}
