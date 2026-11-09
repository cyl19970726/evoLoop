/**
 * Version policy for the Codex App Server protocol.
 *
 * - `exact`: the installed CLI must be one reviewed version and its generated v2 schema must
 *   hash to the reviewed value. Features follow the reviewed version table. This is the default.
 * - `surface`: the CLI must be at least a minimum version and not on a blocked list, and the
 *   generated schema must still contain the methods and request parameters evoLoop actually uses.
 *   Optional features are enabled only when their methods are present in that schema.
 *
 * `surface` is structural and generic over JSON Schema; it has not yet been checked against a
 * real generated schema (plan V3). Missing structure fails closed.
 */

/** Optional protocol slices. A false flag means the adapter refuses or degrades that operation. */
export interface ProtocolFeatures {
  /** Post-0.154 surface: metadata-only Turn listing, strict cursors, naming, currentTime/read, full readback. */
  modern: boolean;
  /** Experimental workspace timeline history. */
  workspace: boolean;
  /** Owner-requested compaction and its observation. */
  compaction: boolean;
  /** Direct input on an idle or active owned Session. */
  directInput: boolean;
  /** Read-only skill, plugin and MCP server lists for a work directory. */
  capabilityLists: boolean;
}

export type ProtocolCheck = "exact" | "surface";

/**
 * Methods evoLoop sends and every request parameter it can supply. A schema that newly
 * requires any other parameter would reject evoLoop's requests, so the check refuses it.
 */
export const USED_REQUESTS: Readonly<Record<string, readonly string[]>> = {
  "initialize": ["clientInfo", "capabilities"],
  "thread/start": ["cwd", "model", "sandbox", "approvalPolicy", "serviceName", "config", "dynamicTools"],
  "thread/resume": ["threadId", "excludeTurns", "cwd", "model", "sandbox", "approvalPolicy", "config"],
  "thread/read": ["threadId", "includeTurns"],
  "thread/turns/list": ["threadId", "limit", "sortDirection", "itemsView", "cursor"],
  "thread/items/list": ["threadId", "turnId", "limit", "cursor"],
  "thread/archive": ["threadId"],
  "thread/list": ["archived", "cwd", "useStateDbOnly", "limit", "cursor"],
  "turn/start": ["threadId", "input", "clientUserMessageId", "model", "effort", "cwd", "sandboxPolicy", "approvalPolicy"],
  "turn/interrupt": ["threadId", "turnId"],
  "model/list": ["limit", "cursor"],
};
/** Notifications whose shape the runner and timeline depend on. */
export const USED_NOTIFICATIONS: readonly string[] = ["turn/started", "turn/completed", "item/started", "item/completed"];
/** Each optional feature is enabled only when all of its methods are present. */
export const FEATURE_METHODS: Readonly<Record<keyof ProtocolFeatures, readonly string[]>> = {
  modern: ["thread/name/set", "currentTime/read"],
  workspace: ["thread/timeline/list"],
  compaction: ["thread/compact/start"],
  directInput: ["turn/steer", "thread/settings/update"],
  capabilityLists: ["skills/list", "plugin/list", "mcpServerStatus/list"],
};

const PINNED_FEATURES: Readonly<Record<string, ProtocolFeatures>> = {
  "codex-cli 0.154.0": { modern: false, workspace: false, compaction: false, directInput: false, capabilityLists: false },
  "codex-cli 0.164.0-alpha.11.1": { modern: true, workspace: false, compaction: false, directInput: false, capabilityLists: false },
  "codex-cli 0.166.0-alpha.5.1": { modern: true, workspace: true, compaction: false, directInput: false, capabilityLists: true },
  "codex-cli 0.166.0-alpha.6": { modern: true, workspace: true, compaction: true, directInput: true, capabilityLists: true },
  "codex-cli 0.167.0-alpha.3.2": { modern: true, workspace: true, compaction: false, directInput: false, capabilityLists: true },
};

/** Reviewed feature table for exact pinning. */
export function pinnedFeatures(version: string): ProtocolFeatures | null {
  const features = PINNED_FEATURES[version];
  return features ? { ...features } : null;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Every string literal the schema names in `enum` or `const`: method names and discriminators. */
function literals(schema: unknown): Set<string> {
  const found = new Set<string>();
  const stack: unknown[] = [schema];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    const node = object(current);
    if (!node) continue;
    if (typeof node.const === "string") found.add(node.const);
    if (Array.isArray(node.enum)) for (const value of node.enum) if (typeof value === "string") found.add(value);
    stack.push(...Object.values(node));
  }
  return found;
}

function definitions(schema: Record<string, unknown>): Record<string, unknown> {
  return { ...object(schema.definitions) ?? {}, ...object(schema.$defs) ?? {} };
}

function resolve(schema: Record<string, unknown>, node: unknown): Record<string, unknown> | null {
  const current = object(node);
  const ref = typeof current?.$ref === "string" ? current.$ref : null;
  if (!ref) return current;
  const name = ref.replace(/^#\/(definitions|\$defs)\//, "");
  return object(definitions(schema)[name]);
}

/** JSON-RPC request variants: `{properties:{method:{enum|const:[name]}, params:{...}}}`. */
function requestParams(schema: Record<string, unknown>, method: string): Record<string, unknown> | null | undefined {
  const stack: unknown[] = [schema];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    const node = object(current);
    if (!node) continue;
    const properties = object(node.properties);
    const discriminator = object(properties?.method);
    const names = discriminator ? [discriminator.const, ...(Array.isArray(discriminator.enum) ? discriminator.enum : [])] : [];
    if (properties && names.includes(method)) return properties.params === undefined ? null : resolve(schema, properties.params);
    stack.push(...Object.values(node));
  }
  return undefined;
}

export interface SurfaceReport { problems: string[]; features: ProtocolFeatures }

/** Compare the generated schema with the used surface; detect optional features by method presence. */
export function checkUsedSurface(value: unknown): SurfaceReport {
  const schema = object(value);
  if (!schema) return { problems: ["schema is not an object"], features: pinnedFeatures("codex-cli 0.154.0")! };
  const names = literals(schema);
  const problems: string[] = [];
  for (const [method, sent] of Object.entries(USED_REQUESTS)) {
    if (!names.has(method)) { problems.push(`method ${method} is missing`); continue; }
    const params = requestParams(schema, method);
    if (params === undefined) { problems.push(`method ${method} has no locatable request variant`); continue; }
    const required = Array.isArray(params?.required) ? params.required.filter((name): name is string => typeof name === "string") : [];
    const unexpected = required.filter(name => !sent.includes(name));
    if (unexpected.length) problems.push(`method ${method} now requires ${unexpected.sort().join(", ")}`);
  }
  for (const notification of USED_NOTIFICATIONS) if (!names.has(notification)) problems.push(`notification ${notification} is missing`);
  const features = Object.fromEntries(Object.entries(FEATURE_METHODS).map(([feature, methods]) =>
    [feature, methods.every(method => names.has(method))])) as unknown as ProtocolFeatures;
  return { problems, features };
}

const SEMVER = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split("."), right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index], y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null, ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; continue; }
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** Semantic-version comparison of `codex-cli X.Y.Z[-pre]` strings; null when either is not one. */
export function compareCodexVersions(a: string, b: string): number | null {
  const left = SEMVER.exec(a), right = SEMVER.exec(b);
  if (!left || !right) return null;
  for (let index = 1; index <= 3; index++) {
    const x = Number(left[index]), y = Number(right[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(left[4], right[4]);
}

/** Minimum-version policy: at least `minimum`, and never an exact `blocked` entry. */
export function versionAllowed(version: string, minimum: string, blocked: readonly string[]): boolean {
  const order = compareCodexVersions(version, minimum);
  return order !== null && order >= 0 && !blocked.includes(version);
}
