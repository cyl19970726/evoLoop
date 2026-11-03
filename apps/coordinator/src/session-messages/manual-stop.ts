import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import type { Command, RuntimeSessionRecord } from '@evoloop/contracts';
import type { SessionMessageManualStopPreflight } from '@evoloop/contracts/session-messages';
import type { RuntimeBinding, RuntimePage, RuntimeTurn } from '@evoloop/contracts/runtime';
import { DomainError } from '@evoloop/contracts/ports';
import { bindingOf } from '../runtime/runner.js';

type StopCommand = Extract<Command, { type: 'session.message.manualStop' }>;
type NativeReader = {
  isReady(): boolean;
  registerBinding(binding: RuntimeBinding): Promise<void>;
  inspect(binding: RuntimeBinding): Promise<unknown>;
  listTurns(binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding: RuntimeBinding, turnId: string, cursor?: string): Promise<RuntimePage<unknown>>;
};
export type ManualStopPreview = {
  sessionId: string; nativeTurnId: string; nativeStatus: string; completedAtUtc: string | null;
  threadStatus: string; itemCount: number; itemIdsHash: string; observedAt: string;
  eligible: boolean; reason: string;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const denied = (code: string, message: string): never => { throw new DomainError(code, message); };

async function exactTurn(runtime: NativeReader, binding: RuntimeBinding, turnId: string): Promise<RuntimeTurn> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await runtime.listTurns(binding, cursor);
    const turn = page.data.find(value => value.id === turnId);
    if (turn) return turn;
    if (!page.nextCursor) break;
    if (seen.has(page.nextCursor)) return denied('MANUAL_STOP_TURN_UNREADABLE', 'Original Turn cursor repeated');
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  return denied('MANUAL_STOP_TURN_UNREADABLE', 'Original native Turn is not in the bounded owner readback');
}

/** Only the newly owning App Server reads the exact original Thread and Turn. No resume or new Turn occurs. */
export async function previewManualStop(runtime: NativeReader, session: RuntimeSessionRecord,
  turnId: string): Promise<ManualStopPreview> {
  if (!runtime.isReady() || session.state !== 'ready' || !session.nativeThreadId || !session.nativeSessionId)
    return denied('MANUAL_STOP_OWNER_UNAVAILABLE', 'The current owner and original Session binding must be ready');
  const binding = bindingOf(session);
  await runtime.registerBinding(binding);
  const inspected = record(await runtime.inspect(binding));
  const thread = record(inspected?.thread);
  if (thread?.id !== binding.nativeThreadId || thread.sessionId !== binding.nativeSessionId || thread.cwd !== binding.cwd)
    return denied('MANUAL_STOP_THREAD_MISMATCH', 'Current owner did not read the exact original Thread');
  const threadStatus = String(record(thread.status)?.type ?? 'unknown');
  const turn = await exactTurn(runtime, binding, turnId);
  const ids: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await runtime.listItems(binding, turnId, cursor);
    for (const value of page.data) {
      const item = record(value);
      if (typeof item?.id !== 'string' || !item.id) return denied('MANUAL_STOP_ITEMS_UNREADABLE', 'Original Item identity is unavailable');
      ids.push(item.id);
    }
    if (!page.nextCursor) {
      const eligible = turn.completedAtUtc == null &&
        ['inProgress', 'interrupted', 'failed'].includes(turn.status) &&
        ['idle', 'notLoaded'].includes(threadStatus);
      return { sessionId: session.id, nativeTurnId: turnId, nativeStatus: turn.status,
        completedAtUtc: turn.completedAtUtc ?? null, threadStatus, itemCount: ids.length,
        itemIdsHash: hash(JSON.stringify(ids)), observedAt: new Date().toISOString(), eligible,
        reason: eligible ? 'Original Turn has no native completion timestamp and the new owner sees no active Thread'
          : 'Use native settlement for a timestamped terminal Turn; active or unreadable Threads cannot be manually stopped' };
    }
    if (seen.has(page.nextCursor)) return denied('MANUAL_STOP_ITEMS_UNREADABLE', 'Original Item cursor repeated');
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  return denied('MANUAL_STOP_ITEMS_UNREADABLE', 'Original Items exceed the bounded evidence read');
}

function processIsAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** The private, hashed manifest records the pre-stop identities and observed exit. */
async function verifyExitManifest(command: StopCommand, session: RuntimeSessionRecord,
  preflight:SessionMessageManualStopPreflight,evidenceRoot: string): Promise<void> {
  const path = command.exitEvidenceRef;
  if (!isAbsolute(path) || !isAbsolute(evidenceRoot))
    return denied('MANUAL_STOP_EVIDENCE', 'Exit evidence must be under the configured private root');
  let bytes:Buffer;
  try {
    const root = await realpath(evidenceRoot);
    const actual = await realpath(path);
    if (!actual.startsWith(root + sep))
      return denied('MANUAL_STOP_EVIDENCE', 'Exit evidence is outside the private root');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0)
      return denied('MANUAL_STOP_EVIDENCE', 'Exit evidence must be a private regular file below 128 KiB');
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return denied('MANUAL_STOP_EVIDENCE', 'Private exit evidence is unreadable');
  }
  if (hash(bytes) !== command.exitEvidenceHash)
    return denied('MANUAL_STOP_EVIDENCE', 'Exit evidence hash changed');
  let manifest: Record<string, unknown> | null = null;
  try { manifest = record(JSON.parse(bytes.toString('utf8'))); } catch { /* malformed private evidence */ }
  const coordinator = record(manifest?.oldCoordinator), native = record(manifest?.oldNative);
  const pre = Date.parse(String(manifest?.preStopObservedAt ?? ''));
  const post = Date.parse(String(manifest?.postStopObservedAt ?? ''));
  const captured=Date.parse(preflight.capturedAt);
  let anchor:Record<string,unknown>|null=null;
  try { anchor=record(JSON.parse(preflight.preStopEvidenceJson)); } catch { /* malformed DB anchor */ }
  const anchorNative=record(anchor?.oldNative),anchorCoordinator=record(anchor?.oldCoordinator);
  const databaseLease=record(anchor?.databaseLease);
  if (preflight.projectId !== command.projectId || preflight.messageId !== command.messageId ||
    preflight.preflightId !== command.preflightId ||
    preflight.processingId !== command.processingId || preflight.sessionId !== session.id ||
    preflight.nativeTurnId !== command.nativeTurnId || preflight.nativeThreadId !== session.nativeThreadId ||
    preflight.host !== hostname() ||
    anchor?.capturedByActorId !== preflight.capturedByActorId ||
    preflight.oldCoordinatorPid !== command.oldCoordinatorPid ||
    preflight.oldNativePid !== command.oldNativePid ||
    preflight.oldCoordinatorStartIdentity !== command.oldCoordinatorStartIdentity ||
    preflight.oldNativeStartIdentity !== command.oldNativeStartIdentity ||
    hash(preflight.preStopEvidenceJson) !== preflight.preStopEvidenceHash ||
    anchor?.preflightId !== preflight.preflightId || anchor?.host !== preflight.host ||
    anchor?.projectId !== preflight.projectId || anchor?.sessionId !== preflight.sessionId ||
    anchor?.threadId !== preflight.nativeThreadId || anchor?.messageId !== preflight.messageId ||
    anchor?.processingId !== preflight.processingId || anchor?.nativeTurnId !== preflight.nativeTurnId ||
    !['127.0.0.1','::1'].includes(String(databaseLease?.clientAddr)) ||
    !['127.0.0.1','::1'].includes(String(databaseLease?.serverAddr)) ||
    !Number.isInteger(databaseLease?.clientPort) || !Number.isInteger(databaseLease?.serverPort) ||
    anchorCoordinator?.pid !== preflight.oldCoordinatorPid ||
    anchorCoordinator?.startIdentity !== preflight.oldCoordinatorStartIdentity ||
    anchorNative?.pid !== preflight.oldNativePid ||
    anchorNative?.parentPid !== preflight.oldCoordinatorPid ||
    anchorNative?.startIdentity !== preflight.oldNativeStartIdentity ||
    manifest?.preflightId !== preflight.preflightId ||
    manifest?.preStopEvidenceHash !== preflight.preStopEvidenceHash ||
    !manifest?.preStopEvidence || hash(JSON.stringify(manifest.preStopEvidence)) !== preflight.preStopEvidenceHash ||
    manifest?.captureFileHash !== preflight.captureFileHash ||
    manifest?.host !== hostname() || manifest?.projectId !== command.projectId ||
    manifest?.sessionId !== session.id || manifest?.threadId !== session.nativeThreadId ||
    manifest?.messageId !== command.messageId || manifest?.processingId !== command.processingId ||
    manifest?.nativeTurnId !== command.nativeTurnId ||
    coordinator?.pid !== command.oldCoordinatorPid || native?.pid !== command.oldNativePid ||
    coordinator.startIdentity !== command.oldCoordinatorStartIdentity ||
    native.startIdentity !== command.oldNativeStartIdentity ||
    !Number.isFinite(pre) || !Number.isFinite(post) || !Number.isFinite(captured) ||
    pre !== Date.parse(String(anchor?.osObservedAt ?? '')) ||
    post < captured || post < pre || post > Date.now() ||
    !manifest?.postStopEvidence)
    return denied('MANUAL_STOP_EVIDENCE', 'Exit evidence does not bind the original owner, Turn and stop sequence');
}

export async function verifyManualStop(command: StopCommand, session: RuntimeSessionRecord,
  preview: ManualStopPreview, preflight:SessionMessageManualStopPreflight,
  evidenceRoot: string, canWrite: () => boolean,
  isAbsent: (pid: number) => boolean = processIsAbsent): Promise<void> {
  if (!canWrite()) return denied('MANUAL_STOP_OWNER_UNAVAILABLE', 'Current coordinator has no exclusive write lease');
  if (command.oldCoordinatorPid === command.oldNativePid ||
    command.oldCoordinatorPid === process.pid || command.oldNativePid === process.pid)
    return denied('MANUAL_STOP_OWNER_LIVE', 'Old owner process identities conflict with the current coordinator');
  await verifyExitManifest(command, session, preflight,evidenceRoot);
  if (!isAbsent(command.oldCoordinatorPid) || !isAbsent(command.oldNativePid))
    return denied('MANUAL_STOP_OWNER_LIVE', 'Old coordinator or its native child still has a live PID');
  if (!preview.eligible || preview.sessionId !== session.id || preview.nativeTurnId !== command.nativeTurnId ||
    preview.nativeStatus !== command.observedNativeStatus ||
    preview.threadStatus !== command.observedThreadStatus ||
    preview.itemCount !== command.observedItemCount ||
    preview.itemIdsHash !== command.observedItemIdsHash)
    return denied('MANUAL_STOP_NATIVE_CHANGED', 'Current owner readback does not match the reviewed original Turn and Items');
  if (!canWrite() || !isAbsent(command.oldCoordinatorPid) || !isAbsent(command.oldNativePid))
    return denied('MANUAL_STOP_OWNER_LIVE', 'Owner isolation changed before the manual stop decision');
}
