// `--brief` for the three Leader reads (DEC-043, W7). The service answers are unchanged; the CLI keeps what arranging work needs
// and drops the rest (above all the per-Task timing history, which is most of the bytes). Pure functions over the parsed answer, so
// the default output (no flag) never goes through this file.
type Obj = Record<string, any>;
const obj = (value: unknown): Obj | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const pick = (source: Obj | null, keys: string[]): Obj | null => {
  if (!source) return null;
  const out: Obj = {};
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out;
};

/** One Task of the work index: who it is, which version, what stage, what to do next, who owns it, what waits on what. */
export function briefTask(item: Obj): Obj {
  const timing = obj(item.timing), current = obj(timing?.current);
  const blockedBy = (Array.isArray(item.dependencies) ? item.dependencies : [])
    .filter((dependency: Obj) => obj(dependency) && dependency.acceptanceSatisfied === false).map((dependency: Obj) => dependency.taskId);
  const convention = obj(item.acceptanceConvention);
  return {
    taskId: item.taskId, version: item.version, revisionId: item.currentRevisionId, title: item.title,
    kind: item.taskKind ?? null, state: item.taskState, phase: item.phase, nextAction: item.nextAction,
    ...(item.actionKey ? { actionKey: item.actionKey } : {}),
    responsible: pick(obj(item.responsible), ["kind", "id", "label"]),
    ...(item.assignment ? { assignment: pick(obj(item.assignment), ["state", "targetKind", "targetId", "recipientActorId", "taskRevisionId"]) } : {}),
    ...(item.latestRun ? { run: pick(obj(item.latestRun), ["runId", "state"]) } : {}),
    ...(item.delivery ? { delivery: { ...pick(obj(item.delivery), ["deliveryId", "taskRevisionId", "technicalResult", "consumer", "useRequired"]),
      ...(item.delivery.observationResult ? { observation: { result: item.delivery.observationResult, actorId: item.delivery.observationActorId ?? null } } : {}) } } : {}),
    waiting: current ? { stage: current.stage ?? null, for: current.waitingFor ?? null, since: current.startedAt ?? null } : null,
    ...(item.queueHold ? { queueHold: item.queueHold } : {}),
    ...(item.pendingImpactCount ? { pendingImpacts: item.pendingImpactCount } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
    ...(item.plan ? { plan: pick(obj(item.plan), ["dueAt", "plannedStartAt", "priority"]) } : {}),
    ...(convention ? { acceptance: pick(convention, ["acceptanceTarget", "acceptancePrecondition", "readiness", "namedAgent"]) } : {}),
  };
}

const PAGE_KEYS = ["total", "counts", "changeSequence", "observedAt", "partial", "nextCursor"];
/** `work leader` (tasks view): the page envelope stays, the items are briefed. */
export function briefIndex(page: Obj): Obj {
  return { brief: true, ...pick(page, PAGE_KEYS), items: (Array.isArray(page.items) ? page.items : []).map((item: Obj) => item?.kind === "task" ? briefTask(item) : item) };
}

const CAPACITY_KEYS = ["sessionId", "roleId", "state", "tenure", "isLeader", "activeRuns", "pendingMessages", "queueEntries", "openAssignments",
  "openAcceptance", "lineQueued", "lineStarting", "persistedWorkIdle", "missingCapabilities", "readyForAcceptance"];
/** `work acceptance`: the briefed work index and each Session's occupation and missing capabilities. */
export function briefAcceptanceOverview(body: Obj): Obj {
  return { brief: true, work: obj(body.work) ? briefIndex(body.work) : body.work ?? null,
    capacity: (Array.isArray(body.capacity) ? body.capacity : []).map((row: Obj) => pick(obj(row), CAPACITY_KEYS)), observedAt: body.observedAt ?? null };
}

const RELAY_KEYS = ["relayId", "version", "supersedesRelayId", "stage", "scopeKey", "mode", "state", "recipientActorId", "sessionId", "deliveryId",
  "taskRevisionId", "blockedReason", "messageState", "messageBlockedReason", "processingState", "observationResult", "observationActorId", "evidenceLevel"];
/** `work acceptance TASK`, and the relays of `work task`: the arrangement's identity and where it stands, without the long prose. */
export function briefRelays(body: Obj): Obj {
  return { brief: true, items: (Array.isArray(body.items) ? body.items : []).map((row: Obj) => pick(obj(row), RELAY_KEYS)) };
}

/** `work task`: the briefed Task, with its current acceptance arrangements when they could be read. */
export function briefTaskWithRelays(task: Obj, relays: Obj | null): Obj {
  // Only the arrangements still in force, each reduced to who, where it stands and its ID; the full rows are `work acceptance TASK --brief`.
  const current = relays && Array.isArray(relays.items)
    ? relays.items.filter((row: Obj) => !["superseded", "released"].includes(row?.state))
      .map((row: Obj) => pick(obj(row), ["relayId", "stage", "mode", "state", "recipientActorId", "deliveryId", "observationResult"])) : null;
  return { brief: true, ...briefTask(task), acceptanceRelays: current };
}
