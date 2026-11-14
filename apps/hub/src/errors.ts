export class HubError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export function asHubError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  const value = error as { code?: unknown; constraint?: unknown; statusCode?: unknown };
  if (typeof value?.statusCode === "number" && value.statusCode >= 400 && value.statusCode < 500) {
    return new HubError(value.statusCode, "INVALID_REQUEST", "The request body or headers could not be parsed.");
  }
  if (value?.code === "23505") {
    const constraint = typeof value.constraint === "string" ? value.constraint : "";
    if (constraint.includes("project_actor")) {
      return new HubError(409, "ACTOR_IDENTITY_CONFLICT", "This actor already has the other identity kind in the project.");
    }
    if (constraint.includes("actor_id")) return new HubError(409, "ACTOR_ID_TAKEN", "This actor ID is already in use.");
    return new HubError(409, "DUPLICATE_RECORD", "The record already exists.");
  }
  if (value?.code === "23503") return new HubError(409, "REFERENCE_CONFLICT", "A referenced record does not exist.");
  return new HubError(500, "INTERNAL_ERROR", "The Hub could not complete the request.");
}
