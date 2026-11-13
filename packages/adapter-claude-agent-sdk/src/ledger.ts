import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeProtocolError, type RuntimeHistoryItem, type RuntimeObservedCapabilities, type RuntimeTurnFailure,
  type RuntimeUsage } from "@evoloop/contracts/runtime";

/**
 * The SDK streams the closing answer as an assistant text block (recorded as commentary) and then repeats it in the result,
 * which the adapter records as the Turn's final answer. One answer is shown once: a final answer replaces the commentary item
 * right before it when the text is the same. Applied when reading, so ledgers written before this rule read the same way.
 */
function addItem(items: RuntimeHistoryItem[], item: RuntimeHistoryItem): void {
  if (item.type === "agentMessage" && item.phase === "final_answer") {
    const previous = items[items.length - 1];
    if (previous?.type === "agentMessage" && previous.phase === "commentary" && previous.text === item.text) items.pop();
  }
  items.push(item);
}

/**
 * Adapter-owned, append-only Turn ledger.
 *
 * Claude Code keeps its own transcript, but the transcript format and the in-process readers are tied to
 * the process-wide CLAUDE_CONFIG_DIR and do not carry the per-Turn result, usage or cost. The adapter
 * therefore records every Turn it starts in its own JSONL file before any native process is spawned, and
 * appends what it observes from the SDK stream. The ledger is local private run material: it lives under
 * the dedicated Claude config directory, never in Git.
 */
export interface TurnSettlement {
  status: "completed" | "failed" | "interrupted";
  completedAtUtc: string;
  usage: RuntimeUsage | null;
  /** Cost of this Turn alone; null when the provider's cumulative total cannot prove it. */
  costUsd: number | null;
  /** The provider's cumulative session total after this Turn, kept to derive the next Turn's cost. */
  cumulativeCostUsd: number | null;
  /** Thinking tokens of this Turn alone (already inside output tokens); null or absent when not provable. */
  thinkingTokens?: number | null;
  /** The provider's cumulative session thinking tokens after this Turn, kept to derive the next Turn's. */
  cumulativeThinkingTokens?: number | null;
  error?: RuntimeTurnFailure;
  /** The exact model ID of the Turn's main-thread answers (null when no assistant message carried one) and of its subagents' answers. */
  observedModel?: string | null;
  subagentModels?: string[];
  /** result: the SDK result message; process_exit: the Turn process ended without one; orphan: observed after a restart. */
  source: "result" | "process_exit" | "orphan";
}

export type LedgerRecord =
  | { kind: "session"; at: string; projectId: string; sessionId: string; nativeSessionId: string; cwd: string }
  | { kind: "session.archived"; at: string }
  | { kind: "turn.started"; at: string; turnId: string; operationId: string; input: string; resume: boolean }
  | { kind: "turn.process"; at: string; turnId: string; pid: number }
  | { kind: "turn.sent"; at: string; turnId: string }
  | { kind: "turn.withdrawn"; at: string; turnId: string; reason: string }
  | { kind: "item"; at: string; turnId: string; item: RuntimeHistoryItem }
  | { kind: "turn.capabilities"; at: string; turnId: string; observed: RuntimeObservedCapabilities }
  | ({ kind: "turn.settled"; at: string; turnId: string } & TurnSettlement);

export interface LedgerTurn {
  turnId: string;
  operationId: string;
  input: string;
  resume: boolean;
  startedAt: string;
  pid: number | null;
  sent: boolean;
  withdrawn: boolean;
  items: RuntimeHistoryItem[];
  /** First init report of the Turn process; null when none was observed. */
  capabilities: RuntimeObservedCapabilities | null;
  settled: TurnSettlement | null;
}

export interface LedgerView {
  session: Extract<LedgerRecord, { kind: "session" }> | null;
  /** Adapter-owned archive: no further Turn starts on this Session. */
  archived: boolean;
  /** Oldest first, in ledger order. */
  turns: LedgerTurn[];
}

const safeSegment = /^[A-Za-z0-9-]{1,64}$/;

export class TurnLedger {
  private readonly chains = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  private path(projectId: string, nativeSessionId: string): string {
    if (!safeSegment.test(projectId) || !safeSegment.test(nativeSessionId)) throw new RuntimeProtocolError("invalid ledger identity");
    return join(this.root, projectId, `${nativeSessionId}.jsonl`);
  }

  /** Durable append: the record is on disk (datasync) when the promise resolves. Appends to one file are serialized. */
  async append(projectId: string, nativeSessionId: string, record: LedgerRecord): Promise<void> {
    const path = this.path(projectId, nativeSessionId);
    const previous = this.chains.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(join(this.root, projectId), { recursive: true, mode: 0o700 });
      const handle = await open(path, "a+", 0o600);
      try {
        const { size } = await handle.stat();
        const last = Buffer.alloc(1);
        if (size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 0x0a) {
          // A crash tore the previous append. Reads already skip that partial record; drop it so this record
          // starts on its own line instead of turning the torn one into corruption in the middle of the file.
          const content = Buffer.alloc(size);
          await handle.read(content, 0, size, 0);
          await handle.truncate(content.lastIndexOf(0x0a) + 1);
        }
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.datasync();
      } finally { await handle.close(); }
    });
    this.chains.set(path, next);
    void next.finally(() => { if (this.chains.get(path) === next) this.chains.delete(path); }).catch(() => undefined);
    return next;
  }

  async read(projectId: string, nativeSessionId: string): Promise<LedgerView> {
    const path = this.path(projectId, nativeSessionId);
    await (this.chains.get(path) ?? Promise.resolve()).catch(() => undefined);
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { session: null, archived: false, turns: [] };
      throw error;
    }
    const lines = text.split("\n");
    const view: LedgerView = { session: null, archived: false, turns: [] };
    const byId = new Map<string, LedgerTurn>();
    lines.forEach((line, index) => {
      if (!line) return;
      let record: LedgerRecord;
      try { record = JSON.parse(line) as LedgerRecord; }
      catch {
        // Only the final line can be torn by a crash during append; anything else is corruption.
        if (index === lines.length - 1 || index === lines.length - 2 && lines[lines.length - 1] === "") return;
        throw new RuntimeProtocolError("Claude Turn ledger is corrupted");
      }
      if (record.kind === "session") {
        if (view.session) throw new RuntimeProtocolError("Claude Turn ledger repeats its Session");
        view.session = record; return;
      }
      if (record.kind === "session.archived") { view.archived = true; return; }
      if (record.kind === "turn.started") {
        if (byId.has(record.turnId)) throw new RuntimeProtocolError("Claude Turn ledger repeats a Turn");
        const turn: LedgerTurn = { turnId: record.turnId, operationId: record.operationId, input: record.input,
          resume: record.resume, startedAt: record.at, pid: null, sent: false, withdrawn: false, items: [], capabilities: null, settled: null };
        byId.set(record.turnId, turn); view.turns.push(turn);
        return;
      }
      const turn = byId.get(record.turnId);
      if (!turn) throw new RuntimeProtocolError("Claude Turn ledger references an unknown Turn");
      switch (record.kind) {
        case "turn.process": turn.pid = record.pid; break;
        case "turn.sent": turn.sent = true; break;
        case "turn.withdrawn": turn.withdrawn = true; break;
        case "item": addItem(turn.items, record.item); break;
        case "turn.capabilities": turn.capabilities ??= record.observed; break;
        case "turn.settled": {
          // The first settlement is authoritative; a later observation never rewrites a terminal Turn.
          if (!turn.settled) {
            const { kind: _kind, at: _at, turnId: _turnId, ...settlement } = record;
            turn.settled = settlement;
          }
          break;
        }
      }
    });
    return view;
  }
}
