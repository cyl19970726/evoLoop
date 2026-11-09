/** Cards are identified by Role only: a new revision must update an open card in place, not remount it. */
export const roleCardKey = (role: { id: string }) => role.id;
/** The list is cleared only when the reader or project changes; same-scope refreshes keep what is shown while rereading. */
export const roleListScope = (token: string, projectId: string) => JSON.stringify([token, projectId]);
