// Who counts as a writer for the SENDER of an ordinary Session message (Task e1f2b996, Hub hardening after #481). Two separate ways in, decided by where the principal came from
// (`Principal.origin`: set by HubIdentityVerifier when it has verified the Hub's signature, and by nothing else), never by how the actor ID is written:
//   - no origin (an identity from this machine's own token file): only the local writer test; a `senderKind: "hub"` grant is not looked at, so a local identity whose actor ID
//     happens to equal such a grant's sender gets nothing from it;
//   - origin "hub" (the request carried an identity the Hub signed): only what an explicit enabled `sessionMessages.grants` entry marked `senderKind: "hub"` for this project and
//     sender says; the token file is not consulted (the verifier already refuses a Hub account that takes a local identity's actor ID).
// The receiver of a grant and every other writer test are unchanged: they use the plain local test.
export interface SenderWriterDeps {
  isProjectWriter(projectId: string, actorId: string): Promise<boolean> | boolean;
  loadSessionMessages(): Promise<{ enabled: boolean; grants: Array<{ enabled: boolean; projectId: string; senderActorId: string; senderKind?: "local" | "hub" | undefined }> } | undefined>;
}

export function createSenderWriter(deps: SenderWriterDeps) {
  return async (projectId: string, actorId: string, origin?: "hub" | undefined): Promise<boolean> => {
    if (origin !== "hub") return !!await deps.isProjectWriter(projectId, actorId);
    const messages = await deps.loadSessionMessages();
    return !!messages?.enabled && messages.grants.some(grant => grant.enabled && grant.projectId === projectId && grant.senderActorId === actorId && grant.senderKind === "hub");
  };
}
