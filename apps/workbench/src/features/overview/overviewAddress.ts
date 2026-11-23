// View state of the overview that belongs in the address (?stage= for the chosen stage), so back,
// reload and a shared link bring it back. Written with replaceQuietly: a choice is not a page visit.
import { appHistory, replaceQuietly } from "../../shared/navigation";

export function readOverviewParam(key: string): string | null {
  return new URLSearchParams(appHistory().location.search).get(key);
}

/** Sets or clears one parameter of the current address, leaving the others as they are. */
export function writeOverviewParam(key: string, value: string | null): void {
  const { pathname, search } = appHistory().location;
  const params = new URLSearchParams(search);
  if (value === null) params.delete(key); else params.set(key, value);
  const next = params.toString();
  replaceQuietly(next ? `${pathname}?${next}` : pathname);
}
