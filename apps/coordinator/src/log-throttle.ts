/**
 * A pump that fails on every tick wrote the same line every two seconds (2114 lines in an hour). The first occurrence
 * is written at once; identical ones inside the window are only counted, and the next line after the window says how
 * many were held back. Different messages never suppress each other.
 */
export function throttledLog(write: (line: string) => void, windowMs = 60_000, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; held: number }>();
  return (line: string): void => {
    const time = now();
    const entry = seen.get(line);
    if (!entry) { seen.set(line, { at: time, held: 0 }); write(line); return; }
    if (time - entry.at < windowMs) { entry.held += 1; return; }
    const held = entry.held;
    seen.set(line, { at: time, held: 0 });
    write(held ? `${line} (same message held back ${held} more time${held === 1 ? "" : "s"} in the last ${Math.round(windowMs / 1000)}s)` : line);
  };
}
