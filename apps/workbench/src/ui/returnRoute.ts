/** A saved return location must remain inside this project's known workbench routes. */
export function isProjectRoute(value: string | null, projectId: string): value is string {
  if (!value?.startsWith(`#/p/${projectId}/`)) return false;
  const path = value.split("?")[0].slice(`#/p/${projectId}/`.length);
  return /^(work|inbox|documents|journey|discussions|reviews|runtime|schedules|roles|knowledge|repository|operations|collaboration|evaluations(?:\/[0-9a-f-]{36})?|tasks\/[0-9a-f-]{36})$/i.test(path);
}

/** Preserve the source page in this tab without accepting a foreign or self-referential hash. */
export function knowledgeReturnHref(projectId: string, storage?: Pick<Storage, "getItem">): string | null {
  try {
    const saved = (storage ?? sessionStorage).getItem(`evoloop:knowledge-return:${projectId}`);
    if (isProjectRoute(saved, projectId) && saved.split("?")[0] !== `#/p/${projectId}/knowledge`) return saved;
  } catch { /* optional navigation state */ }
  return null;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
function returnsFromFixedSourceDocument(projectId: string, previousHash: string, nextHash: string, storage: Pick<Storage, "getItem">): boolean {
  const [path, query = ""] = previousHash.split("?");
  if (!new RegExp(`^#/p/${projectId}/documents/${uuid}$`, "i").test(path ?? "")) return false;
  if (!new RegExp(`^#/p/${projectId}/knowledge\\?knowledgeId=${uuid}&knowledgeRevision=${uuid}$`, "i").test(nextHash)) return false;
  const params = new URLSearchParams(query);
  if (params.size !== 2 || params.getAll("revision").length !== 1 || params.getAll("return").length !== 1
    || !new RegExp(`^${uuid}$`, "i").test(params.get("revision") ?? "") || params.get("return") !== nextHash) return false;
  return storage.getItem(`evoloop:document-return:${projectId}`) === nextHash
    && knowledgeReturnHref(projectId, storage) !== null;
}

/** An explicit Document return to the same fixed Wiki is a nested read, not a new source. */
export function rememberKnowledgeSource(projectId: string, previousHash: string, nextHash: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  try {
    const store = storage ?? sessionStorage;
    if (returnsFromFixedSourceDocument(projectId, previousHash, nextHash, store)) return;
    const key = `evoloop:knowledge-return:${projectId}`;
    if (isProjectRoute(previousHash, projectId) && previousHash.split("?")[0] !== `#/p/${projectId}/knowledge`)
      store.setItem(key, previousHash);
    else store.removeItem(key);
  } catch { /* optional navigation state */ }
}

/** A newly verified login starts with no inherited knowledge source for its accessible projects. */
export function clearKnowledgeReturnsOnLogin(projectIds: readonly string[], storage?: Pick<Storage, "removeItem">): void {
  try {
    for (const projectId of projectIds) (storage ?? sessionStorage).removeItem(`evoloop:knowledge-return:${projectId}`);
  } catch { /* optional navigation state */ }
}
