import { z } from "zod";

/** Read-only named paths; writes retain the shared command/schema/receipt workflow. */
export function sessionWorkPath(words: string[], options: Map<string, string | boolean>): string {
  const kind = words[0];
  const query = new URLSearchParams();
  let path: string;
  let allowed: string[];
  const key = () => encodeURIComponent(z.string().regex(/^(owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).parse(words[1]));
  const id = () => z.uuid().parse(words[1]);
  switch (kind) {
    case "list": path = "/session-work"; allowed = ["limit", "cursor", "search", "membership"]; break;
    case "snapshot": path = `/session-work/${key()}`; allowed = []; break;
    case "changes": path = "/session-work/changes"; allowed = ["limit", "cursor"]; if (words[1]) query.set("key", decodeURIComponent(key())); break;
    case "history": path = `/session-work/${key()}/activities`; allowed = ["limit", "cursor", "task", "importance"]; break;
    case "timeline": path = `/session-work/${key()}/timeline`; allowed = ["source", "limit", "cursor", "messages-cursor"]; break;
    case "item": {
      const itemId=z.string().min(1).max(256).refine(value=>value!=='.'&&value!=='..').parse(words[2]);
      path = `/session-work/${key()}/timeline/items/${encodeURIComponent(itemId)}`;
      allowed = ["turn-id"]; break;
    }
    case "updates": path = `/session-work/${key()}/timeline/updates`; allowed = ["after", "wait-ms"]; query.set("waitMs", "0"); break;
    case "messages": path = `/session-work/${key()}/messages`; allowed = ["limit", "cursor"]; break;
    case "message": path = `/session-messages/${id()}`; allowed = []; break;
    case "profile": path = `/session-work/${key()}/profile${options.has("history") ? "/history" : ""}`;
      allowed = options.has("history") ? ["history", "limit", "cursor"] : ["history"]; break;
    case "assignment": path = `/tasks/${id()}/assignment${options.has("history") ? "/history" : ""}`;
      allowed = options.has("history") ? ["history", "limit", "cursor"] : ["history"]; break;
    case "leader":
      if (words[1] === "changes") {
        path = "/work-management/changes";
        allowed = ["limit", "cursor"];
      } else if (words[1] === "notices") {
        path = "/work-management/notices";
        allowed = ["limit", "cursor", "task"];
      } else {
        path = "/work-management/index";
        allowed = ["limit", "cursor", "documents", "closed"];
        query.set("view", options.has("documents") ? "documents" : "tasks");
        if (options.has("closed")) query.set("includeClosed", "true");
      }
      break;
    default: throw new Error("Use work list|snapshot KEY|changes [KEY]|leader [changes|notices]|history KEY|timeline KEY|item KEY ITEM_ID|updates KEY|messages KEY|message UUID|profile KEY|assignment UUID.");
  }
  const count = kind === "list" ? 1 : kind === "changes" && !words[1] ? 1 :
    kind === "leader" ? (words[1] === "changes" || words[1] === "notices" ? 2 : 1) : kind === "item" ? 3 : 2;
  if (words.length !== count) throw new Error("Unexpected Session work arguments.");
  for (const [name, value] of options) {
    if (name === "project") continue;
    if (!allowed.includes(name)) throw new Error(`--${name} does not apply to work ${kind}.`);
    if (name === "history" || name === "documents" || name === "closed") continue;
    if (typeof value !== "string") throw new Error(`--${name} requires a value.`);
    if (name === "limit") query.set(name, String(z.coerce.number().int().min(1).max(kind === "changes" || kind === "leader" ? 100 : 50).parse(value)));
    else if (name === "task") query.set("taskId", z.uuid().parse(value));
    else if (name === "membership") query.set(name, z.enum(["current", "historical", "unclassified", "all"]).parse(value));
    else if (name === "importance") query.set(name, z.enum(["important", "all"]).parse(value));
    else if (name === "source") query.set(name, z.enum(["both", "native", "messages"]).parse(value));
    else if (name === "turn-id") query.set("turnId", z.string().min(1).max(256).parse(value));
    else if (name === "messages-cursor") query.set("messagesCursor", z.string().min(1).max(8192).parse(value));
    else if (name === "after") query.set(name, z.string().min(1).max(8192).parse(value));
    else if (name === "wait-ms") query.set("waitMs", String(z.coerce.number().int().min(0).max(10000).parse(value)));
    else query.set(name, z.string().min(1).max(name === "search" ? 240 : kind === "timeline" ? 8192 : 4096).parse(value));
  }
  if (kind === "changes" && !query.has("cursor")) throw new Error("work changes requires --cursor from a directory or Session snapshot.");
  if (kind === "item" && !query.has("turnId")) throw new Error("work item requires --turn-id for the exact native Turn.");
  return path + (query.size ? `?${query}` : "");
}
