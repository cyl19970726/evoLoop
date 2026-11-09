import assert from "node:assert/strict";
import test from "node:test";
import type { DirectInputCommand, DirectInputGrant, DirectInputRecord } from "@evoloop/contracts/direct-input";
import { ownerOf, type RuntimeBinding, type RuntimeCapabilities, type RuntimeProvider } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import { ClaudeAgentSdkAdapter } from "@evoloop/adapter-claude-agent-sdk";
import { CodexAppServerAdapter, RuntimeProtocolError, pinnedFeatures } from "@evoloop/adapter-codex-app-server";
import { DirectInputService, requireDirectInputRuntime } from "../src/direct-input/service.js";
import { ProviderRoutedRuntime } from "../src/runtime/routed.js";
import type { ManagedRuntime } from "../src/runtime/runner.js";

// Mid-Turn input is offered only when the runtime that drives this binding declares it.
const projectId = "97100001-0000-4000-8000-000000000001";
const sessionId = "97100002-0000-4000-8000-000000000002";
const turnId = "97100003-0000-4000-8000-000000000003";
const principal = { actorId: "sender", projectIds: [projectId], permissions: ["read", "write"] } as never;
const fingerprint = "a".repeat(64);
const bindingFor = (provider: RuntimeProvider): RuntimeBinding => ({ projectId, sessionId, roleId: "role",
  nativeThreadId: "thread", nativeSessionId: "thread", cwd: "/private/tmp/isolated", authorizationScope: "test",
  owner: ownerOf(provider),
  resumeProfile: { actorId: "agent", model: null, sandbox: "danger-full-access", approvalPolicy: "never" } });
const grantOf = (canSteer = true): DirectInputGrant => ({ projectId, sessionId, senderActorId: "sender", receiverRoleId: "role",
  receiverActorId: "agent", cwd: "/private/tmp/isolated", enabled: true, canSteer, canStart: true });
const steer = (): DirectInputCommand => ({ inputId: crypto.randomUUID(), operationId: crypto.randomUUID(),
  content: "one more detail", expectedTurnId: turnId });

/** A Session whose primary Turn is bound and running unless `idle`. Records every durable write. */
function store(idle = false) {
  const records = new Map<string, DirectInputRecord>();
  const writes: string[] = [];
  const set = (id: string, patch: Partial<DirectInputRecord>) => {
    const next = { ...records.get(id)!, ...patch, version: records.get(id)!.version + 1 };
    records.set(id, next); return next;
  };
  return { records, writes, value: {
    get: async (_project: string, id: string) => records.get(id) ?? null,
    inspect: async () => idle ? { state: "idle" as const, turnId: null, used: 0 } : { state: "running" as const, turnId, used: 0 },
    hasPrimary: async () => !idle,
    reserve: async (_project: string, session: string, actorId: string, command: DirectInputCommand) => {
      writes.push(`reserve:${command.inputId}`);
      const record: DirectInputRecord = { projectId, sessionId: session, inputId: command.inputId, operationId: command.operationId,
        actorId, content: command.content, mode: command.expectedTurnId ? "steer" : "start",
        source: { kind: "run", id: "run", processingId: null }, expectedTurnId: command.expectedTurnId,
        actualTurnId: null, nativeItemId: null, state: "attempted", reason: null, version: 1,
        createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" };
      records.set(command.inputId, record);
      return { record, created: true };
    },
    accept: async (_project: string, id: string, actual: string, item: string | null) => {
      writes.push(`accept:${id}`); return set(id, { state: "accepted", actualTurnId: actual, nativeItemId: item });
    },
    reject: async (_project: string, id: string, reason: string) => { writes.push(`reject:${id}`); return set(id, { state: "rejected", reason }); },
    unknown: async (_project: string, id: string, reason: string) => { writes.push(`unknown:${id}`); return set(id, { state: "unknown", reason }); },
  } };
}

/**
 * One native runtime with the real adapter's capability declaration. Its native calls are recorded; `steerTurn`
 * exists only for Codex and, like the adapter, refuses unless the pinned protocol has the direct input feature.
 */
function child(provider: RuntimeProvider, declared: RuntimeCapabilities, sent: string[], codexVersion = ""): ManagedRuntime {
  const runtime: Record<string, unknown> = {
    capabilities: () => declared, isReady: () => true, registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: "inProgress", completedAtUtc: null }], nextCursor: null }),
    listItems: async () => ({ data: [], nextCursor: null }),
    qualifyConversationThread: async () => ({ available: true, reason: "", fingerprint }),
    startConversationTurn: async (_binding: RuntimeBinding, _input: string, id: string) => {
      sent.push(`${provider}:start:${id}`); return { id: "started-turn", status: "inProgress", completedAtUtc: null };
    },
  };
  if (provider === "codex") runtime.steerTurn = async (_binding: RuntimeBinding, expected: string, _content: string, id: string) => {
    if (!pinnedFeatures(codexVersion)?.directInput) throw new RuntimeProtocolError("direct input requires the pinned alpha.6 protocol");
    sent.push(`codex:steer:${id}`); return { turnId: expected, itemId: "steer-item" };
  };
  return runtime as unknown as ManagedRuntime;
}

const claudeDeclared = new ClaudeAgentSdkAdapter({ configDir: "/private/tmp/evoloop-direct-input-capability" }).capabilities();
const codexDeclared = (version: string) => new CodexAppServerAdapter({ expectedVersion: version }).capabilities();

/** The coordinator's routed composite: Codex and Claude driven together, each Session by its binding's owner. */
function harness(provider: RuntimeProvider, codexVersion: string, options: { idle?: boolean; canSteer?: boolean } = {}) {
  const sent: string[] = [];
  const routed = new ProviderRoutedRuntime(new Map<RuntimeProvider, ManagedRuntime>([
    ["codex", child("codex", codexDeclared(codexVersion), sent, codexVersion)],
    ["claude", child("claude", claudeDeclared, sent)],
  ]), "codex");
  const saved = store(options.idle);
  const binding = bindingFor(provider);
  const service = new DirectInputService({ store: saved.value as never, runtime: () => requireDirectInputRuntime(routed),
    canWrite: () => true, admission: async () => ({ grant: grantOf(options.canSteer), binding }), bindingFor: async () => binding });
  return { service, sent, saved };
}

for (const [label, provider, version] of [
  ["Claude", "claude", "codex-cli 0.166.0-alpha.6"],
  ["Codex on the default 0.166.0-alpha.5.1 protocol", "codex", "codex-cli 0.166.0-alpha.5.1"],
  ["Codex on 0.167.0-alpha.3.2", "codex", "codex-cli 0.167.0-alpha.3.2"],
] as const) {
  test(`${label}: a running Session with a steer grant is not offered mid-Turn input`, async () => {
    const { service, sent } = harness(provider, version);
    const capability = await service.capability(principal, projectId, sessionId);
    assert.deepEqual({ available: capability.available, mode: capability.mode, expectedTurnId: capability.expectedTurnId,
      reasonCode: capability.reasonCode }, { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_STEER_UNSUPPORTED" });
    assert.deepEqual(sent, []);
  });

  test(`${label}: a steer submission is refused before any record or native send`, async () => {
    const { service, sent, saved } = harness(provider, version);
    const outcome = await service.submit(principal, projectId, sessionId, steer()).then(
      receipt => ({ state: receipt.state, reason: receipt.reason }),
      error => error instanceof DomainError ? { code: error.code } : { thrown: String(error) });
    assert.deepEqual(outcome, { code: "DIRECT_STEER_UNSUPPORTED" });
    assert.deepEqual(saved.writes, [], "no direct input record is reserved, so none is left unknown");
    assert.deepEqual(sent, []);
  });
}

test("Codex pinned to 0.166.0-alpha.6 still offers and sends mid-Turn input", async () => {
  const { service, sent, saved } = harness("codex", "codex-cli 0.166.0-alpha.6");
  const capability = await service.capability(principal, projectId, sessionId);
  assert.deepEqual({ available: capability.available, mode: capability.mode, expectedTurnId: capability.expectedTurnId,
    reasonCode: capability.reasonCode }, { available: true, mode: "steer", expectedTurnId: turnId, reasonCode: "READY_TO_STEER" });
  const command = steer();
  const receipt = await service.submit(principal, projectId, sessionId, command);
  assert.deepEqual({ state: receipt.state, actualTurnId: receipt.actualTurnId, nativeItemId: receipt.nativeItemId },
    { state: "accepted", actualTurnId: turnId, nativeItemId: "steer-item" });
  assert.deepEqual(sent, [`codex:steer:${command.inputId}`]);
  assert.deepEqual(saved.writes, [`reserve:${command.inputId}`, `accept:${command.inputId}`]);
});

test("a missing steer grant is still reported first, for every runtime", async () => {
  for (const [provider, version] of [["claude", "codex-cli 0.166.0-alpha.6"], ["codex", "codex-cli 0.166.0-alpha.5.1"],
    ["codex", "codex-cli 0.166.0-alpha.6"]] as const)
    assert.equal((await harness(provider, version, { canSteer: false }).service.capability(principal, projectId, sessionId)).reasonCode,
      "DIRECT_STEER_DISABLED");
});

test("an idle Claude or default-protocol Codex Session still starts a new Turn", async () => {
  for (const [provider, version] of [["claude", "codex-cli 0.166.0-alpha.6"], ["codex", "codex-cli 0.166.0-alpha.5.1"]] as const) {
    const { service, sent } = harness(provider, version, { idle: true });
    assert.equal((await service.capability(principal, projectId, sessionId)).reasonCode, "READY_TO_START");
    const command = { ...steer(), expectedTurnId: null };
    assert.equal((await service.submit(principal, projectId, sessionId, command)).state, "accepted");
    assert.deepEqual(sent, [`${provider}:start:${command.inputId}`]);
  }
});

test("a runtime without a capability declaration is never offered mid-Turn input", async () => {
  const sent: string[] = [];
  const undeclared = child("codex", codexDeclared("codex-cli 0.166.0-alpha.6"), sent, "codex-cli 0.166.0-alpha.6") as unknown as Record<string, unknown>;
  delete undeclared.capabilities;
  const saved = store();
  const binding = bindingFor("codex");
  const service = new DirectInputService({ store: saved.value as never, runtime: () => requireDirectInputRuntime(undeclared),
    canWrite: () => true, admission: async () => ({ grant: grantOf(), binding }), bindingFor: async () => binding });
  assert.equal((await service.capability(principal, projectId, sessionId)).reasonCode, "DIRECT_STEER_UNSUPPORTED");
  await assert.rejects(() => service.submit(principal, projectId, sessionId, steer()),
    error => error instanceof DomainError && error.code === "DIRECT_STEER_UNSUPPORTED");
  assert.deepEqual(saved.writes, []);
  assert.deepEqual(sent, []);
});
