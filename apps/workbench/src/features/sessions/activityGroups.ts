import type { SessionActivity } from "@evoloop/contracts/session-observation";

export interface ActivityGroup { key: string; items: SessionActivity[]; latest: SessionActivity }

/** Only identical recorded source identities are combined. A shared Task title or Role is insufficient. */
export function groupActivities(items: SessionActivity[]): ActivityGroup[] {
  const groups = new Map<string, SessionActivity[]>();
  for (const item of items) {
    const key = `${item.source.kind}:${item.source.id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([key, values]) => ({ key, items: values, latest: values[0]! }));
}
