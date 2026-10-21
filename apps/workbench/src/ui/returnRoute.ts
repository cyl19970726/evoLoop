/** A saved return location must remain inside this project's known workbench routes. */
export function isProjectRoute(value: string | null, projectId: string): value is string {
  if (!value?.startsWith(`#/p/${projectId}/`)) return false;
  const path = value.split("?")[0].slice(`#/p/${projectId}/`.length);
  return /^(work|inbox|documents|journey|discussions|runtime|schedules|roles|knowledge|repository|operations|collaboration|evaluations(?:\/[0-9a-f-]{36})?|tasks\/[0-9a-f-]{36})$/i.test(path);
}

/** Preserve the source page in this tab without accepting a foreign or self-referential hash. */
export function knowledgeReturnHref(projectId: string, storage?: Pick<Storage, "getItem">): string | null {
  try {
    const saved = (storage ?? sessionStorage).getItem(`evoloop:knowledge-return:${projectId}`);
    if (isProjectRoute(saved, projectId) && saved.split("?")[0] !== `#/p/${projectId}/knowledge`) return saved;
  } catch { /* optional navigation state */ }
  return null;
}

/** A newly verified login starts with no inherited knowledge source for its accessible projects. */
export function clearKnowledgeReturnsOnLogin(projectIds: readonly string[], storage?: Pick<Storage, "removeItem">): void {
  try {
    for (const projectId of projectIds) (storage ?? sessionStorage).removeItem(`evoloop:knowledge-return:${projectId}`);
  } catch { /* optional navigation state */ }
}
