import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { IssuedWorker, WorkerIdentity, WorkerMetadata, WorkerScope } from "./types.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = (value: string) => createHash("sha256").update(value).digest();
const metadataFile = "metadata.json", secretFile = "credential", wrapperFile = "worker-cli.mjs";
const principalFor = (metadata: WorkerMetadata) => ({actorId: metadata.actorId, projectIds: [metadata.scope.projectId],
  permissions: metadata.scope.kind === "cognition" ? ["read", "write", "review"] as const : ["read", "write"] as const});

function validateScope(scope: WorkerScope): void {
  for (const key of ["projectId", "loopId", "taskId", "runId", "sessionId"] as const)
    if (!uuid.test(scope[key])) throw new Error(`Invalid worker ${key}`);
  if (!scope.roleId || scope.roleId.length > 4000 || !["business", "cognition"].includes(scope.kind) ||
    !Array.isArray(scope.allowedRoleIds) || !scope.allowedRoleIds.length || scope.allowedRoleIds.length > 21 ||
    scope.allowedRoleIds.some(role => typeof role !== "string" || !role || role.length > 4000) ||
    !scope.allowedRoleIds.includes(scope.roleId)) throw new Error("Invalid worker role scope");
}

export class WorkerCredentialBroker {
  private readonly root: string;
  private readonly apiUrl: string;
  private readonly cliMain: string;
  private readonly nodeExecutable: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly receiptDirectory: ((scope: WorkerScope) => string) | undefined;
  constructor(options: { workerRoot: string; apiUrl: string; cliMain: string; nodeExecutable: string; ttlMs: number; now?: () => number;
    receiptDirectory?: (scope: WorkerScope) => string }) {
    if (![options.workerRoot, options.cliMain, options.nodeExecutable].every(isAbsolute)) throw new Error("Worker paths must be absolute");
    const url = new URL(options.apiUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Worker API URL must be an HTTP(S) origin");
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1000 || options.ttlMs > 86_400_000)
      throw new Error("Invalid worker credential TTL");
    this.root = resolve(options.workerRoot); this.apiUrl = url.origin;
    this.cliMain = options.cliMain; this.nodeExecutable = options.nodeExecutable;
    this.ttlMs = options.ttlMs; this.now = options.now ?? Date.now;
    this.receiptDirectory = options.receiptDirectory;
  }
  private runDir(runId: string): string {
    if (!uuid.test(runId)) throw new Error("Invalid worker run ID");
    return join(this.root, runId);
  }
  private async privateRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("Worker root must be a private directory");
  }
  async issue(scope: WorkerScope): Promise<IssuedWorker> {
    validateScope(scope);
    await this.privateRoot();
    const dir = this.runDir(scope.runId);
    await mkdir(dir, { mode: 0o700 }); // Existing run IDs fail closed; never overwrite a credential.
    const token = randomBytes(32).toString("base64url");
    const actorId = `worker-${randomUUID()}`;
    const metadata: WorkerMetadata = { actorId, scope: structuredClone(scope), issuedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(), revokedAt: null };
    const wrapperPath = join(dir, wrapperFile);
    const receipts = this.receiptDirectory?.(scope) ?? join(dir, "receipts");
    if (!isAbsolute(receipts)) throw new Error("Worker receipt directory must be absolute");
    // The script contains paths and public scope only; the token is read at execution time from a 0600 file.
    const script = `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst token = readFileSync(${JSON.stringify(join(dir, secretFile))}, 'utf8').trim();\nconst meta = JSON.parse(readFileSync(${JSON.stringify(join(dir, metadataFile))}, 'utf8'));\nif (meta.revokedAt || Date.now() >= Date.parse(meta.expiresAt)) { console.error('Worker credential unavailable'); process.exit(1); }\nconst env = { ...process.env, EVOLOOP_API_URL: ${JSON.stringify(this.apiUrl)}, EVOLOOP_TOKEN: token, EVOLOOP_PROJECT: ${JSON.stringify(scope.projectId)}, EVOLOOP_STATE_DIR: ${JSON.stringify(receipts)} };\nconst child = spawnSync(${JSON.stringify(this.nodeExecutable)}, [${JSON.stringify(this.cliMain)}, ...process.argv.slice(2)], { env, stdio: 'inherit' });\nif (child.error) { console.error('Worker CLI unavailable'); process.exit(1); }\nprocess.exit(child.status ?? 1);\n`;
    try {
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, secretFile), token, { mode: 0o600, flag: "wx" });
      await writeFile(join(dir, metadataFile), JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
      await writeFile(wrapperPath, script, { mode: 0o700, flag: "wx" });
      await chmod(dir, 0o700);
    } catch (error) { await this.revoke(scope.runId).catch(() => {}); throw error; }
    return { principal: {...principalFor(metadata), permissions: [...principalFor(metadata).permissions]}, wrapperPath,
      metadataWithoutSecret: metadata };
  }
  /** Idempotent restart lookup. Expiry may only be ignored by trusted terminal sealing of an already signed submission. */
  async lookup(runId: string, options: {allowExpired?: boolean} = {}): Promise<IssuedWorker | null> {
    await this.privateRoot();
    try {
      const dir = this.runDir(runId), stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) return null;
      const record = JSON.parse(await readFile(join(dir, metadataFile), "utf8")) as WorkerMetadata;
      validateScope(record.scope);
      if (record.scope.runId !== runId || record.revokedAt || !options.allowExpired && Date.parse(record.expiresAt) <= this.now()) return null;
      return {principal: {...principalFor(record), permissions: [...principalFor(record).permissions]},
        wrapperPath: join(dir, wrapperFile), metadataWithoutSecret: record};
    } catch {return null;}
  }
  private async records(): Promise<WorkerMetadata[]> {
    await this.privateRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > 10_000) throw new Error("Worker credential registry exceeds limit");
    const records: WorkerMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      try {
        const dir = this.runDir(entry.name);
        const stat = await lstat(dir);
        if (stat.mode & 0o077) continue;
        const value = JSON.parse(await readFile(join(dir, metadataFile), "utf8")) as WorkerMetadata;
        if (value.scope.runId === entry.name) records.push(value);
      } catch { /* Incomplete/revoked records do not authenticate. */ }
    }
    return records;
  }
  async authenticate(header: string | undefined): Promise<WorkerIdentity | null> {
    if (!header?.startsWith("Bearer ") || header.length > 256) return null;
    const candidate = sha(header.slice(7));
    for (const record of await this.records()) {
      if (record.revokedAt || Date.parse(record.expiresAt) <= this.now()) continue;
      try {
        const token = await readFile(join(this.runDir(record.scope.runId), secretFile), "utf8");
        if (timingSafeEqual(candidate, sha(token))) {
          validateScope(record.scope);
          return { principal: {...principalFor(record), permissions: [...principalFor(record).permissions]}, scope: record.scope };
        }
      } catch { /* An unreadable credential fails closed. */ }
    }
    return null;
  }
  async identityForActor(actorId: string): Promise<WorkerIdentity | null> {
    const record = (await this.records()).find(value => value.actorId === actorId && !value.revokedAt && Date.parse(value.expiresAt) > this.now());
    if (!record) return null;
    validateScope(record.scope);
    return {principal: {...principalFor(record), permissions: [...principalFor(record).permissions]}, scope: record.scope};
  }
  /** Historical source classification only. Expired/revoked records confer no current authority. */
  async wasActorRole(projectId: string, actorId: string, loopId: string, roleId: string): Promise<boolean> {
    const record = (await this.records()).find(value => value.actorId === actorId);
    if (!record) return false;
    try {validateScope(record.scope);} catch {return false;}
    return record.scope.projectId === projectId && record.scope.loopId === loopId && record.scope.roleId === roleId;
  }
  async revoke(runId: string): Promise<void> {
    const dir = this.runDir(runId), path = join(dir, metadataFile);
    const record = JSON.parse(await readFile(path, "utf8")) as WorkerMetadata;
    if (record.scope.runId !== runId) throw new Error("Worker credential scope mismatch");
    if (record.revokedAt) return;
    record.revokedAt = new Date(this.now()).toISOString();
    const staged = join(dir, `.metadata-${randomUUID()}`);
    await writeFile(staged, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await rename(staged, path);
    await rm(join(dir, secretFile), { force: true });
  }
}
