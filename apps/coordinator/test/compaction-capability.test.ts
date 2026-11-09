import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import { CompactionMaintenance, type CompactionIntent } from "../src/runtime/compaction.js";
import type { RuntimeRunner } from "../src/runtime/runner.js";
import { ProviderRoutedRuntime } from "../src/runtime/routed.js";
import { ownerOf, type ManagedRuntime, type RuntimeProvider } from "@evoloop/contracts/runtime";

const projectId = randomUUID(), sessionId = randomUUID();
const reviewer: Principal = { actorId: "maintainer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const intent = (): CompactionIntent => ({ operationId: randomUUID(), threadId: "owned-thread", expectedSessionVersion: 3,
  expectedGateVersion: 1, evidenceRef: "handoff:1", reason: "context near limit" });

function harness(mode: "owned_request" | "unavailable" | null, saved: Record<string, unknown> | null = null,
  options: { adapter?: ManagedRuntime; provider?: RuntimeProvider } = {}) {
  const queries: string[] = [];
  let bindings = 0, observed = 0;
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: saved ? [saved] : [] }; } } as unknown as Pool;
  const adapter = options.adapter ?? ({ capabilities: mode ? () => ({ compaction: { autoCompacts: true, mode } }) : undefined } as unknown as ManagedRuntime);
  const runner = {
    nativeAdapter: () => adapter,
    compactionBinding: async () => { bindings++; return { owner: ownerOf(options.provider ?? "codex") }; },
    observeCompaction: async () => { observed++; throw Error("stop after the gate"); },
  } as unknown as RuntimeRunner;
  return { pool, runner, queries, bindings: () => bindings, observed: () => observed };
}

test("owner compaction is refused before any native work when the policy is off", async () => {
  const h = harness("owned_request");
  const maintenance = new CompactionMaintenance(h.pool, h.runner, { owned: () => false });
  await assert.rejects(maintenance.start(reviewer, projectId, sessionId, intent()),
    (error: { code?: string; message: string }) => error.code === "CAPABILITY_UNAVAILABLE" && /disabled/.test(error.message));
  assert.equal(h.bindings(), 0);
  assert.equal(h.queries.length, 1, "only the existing-operation lookup ran");
});

test("owner compaction is refused when the adapter declares no owned request", async () => {
  const h = harness("unavailable");
  const maintenance = new CompactionMaintenance(h.pool, h.runner, { owned: () => true });
  await assert.rejects(maintenance.start(reviewer, projectId, sessionId, intent()),
    (error: { code?: string; message: string }) => error.code === "CAPABILITY_UNAVAILABLE" && /does not accept/.test(error.message));
  assert.equal(h.observed(), 0, "refused before the first native call");
});

test("an adapter that declares owned requests passes the gate", async () => {
  for (const mode of ["owned_request", null] as const) {
    const h = harness(mode);
    const maintenance = new CompactionMaintenance(h.pool, h.runner, { owned: () => true });
    await assert.rejects(maintenance.start(reviewer, projectId, sessionId, intent()), /stop after the gate/);
    assert.equal(h.bindings(), 1);
    assert.equal(h.observed(), 1);
  }
});

test("with two runtimes, the Session's own runtime decides, whichever is the default", async () => {
  const child = (provider: RuntimeProvider, mode: "owned_request" | "unavailable") =>
    ({ capabilities: () => ({ provider, compaction: { autoCompacts: true, mode } }) }) as unknown as ManagedRuntime;
  for (const defaultProvider of ["codex", "claude"] as const) {
    const routed = new ProviderRoutedRuntime(new Map([["codex", child("codex", "owned_request")], ["claude", child("claude", "unavailable")]]), defaultProvider);
    const codex = harness(null, null, { adapter: routed, provider: "codex" });
    await assert.rejects(new CompactionMaintenance(codex.pool, codex.runner, { owned: () => true }).start(reviewer, projectId, sessionId, intent()),
      /stop after the gate/, `a Codex Session compacts when the default is ${defaultProvider}`);
    const claude = harness(null, null, { adapter: routed, provider: "claude" });
    await assert.rejects(new CompactionMaintenance(claude.pool, claude.runner, { owned: () => true }).start(reviewer, projectId, sessionId, intent()),
      (error: { code?: string }) => error.code === "CAPABILITY_UNAVAILABLE", `a Claude Session is refused when the default is ${defaultProvider}`);
    assert.equal(claude.observed(), 0);
  }
});

test("an operation recorded before the policy changed can still be read back", async () => {
  const input = intent();
  const { createHash } = await import("node:crypto");
  const now = new Date();
  const saved = { project_id: projectId, operation_id: input.operationId, session_id: sessionId, thread_id: input.threadId,
    request_hash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), gate_version: 1, session_version: 3,
    actor_id: reviewer.actorId, state: "unknown", native_request_id: 7, native_acknowledged_at: null,
    native_connection_id: null, baseline_turn_id: null, native_turn_id: null, compaction_item_id: null, error_code: null,
    before_input_tokens: null, after_input_tokens: null, created_at: now, updated_at: now };
  const h = harness("unavailable", saved);
  const maintenance = new CompactionMaintenance(h.pool, h.runner, { owned: () => false });
  const view = await maintenance.start(reviewer, projectId, sessionId, input);
  assert.equal(view.operationId, input.operationId);
  assert.equal(view.state, "unknown");
  assert.equal(h.bindings(), 0);
});
