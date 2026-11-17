import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { MACHINE_CREDENTIALS_FILE, machineCredentialsSchema, machineRequestMessage, type MachineCredentials } from "@evoloop/contracts";

export class MachineCommandError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
    this.name = "MachineCommandError";
  }
}

type Environment = Record<string, string | undefined>;
type Io = { stdout(text: string): void; stderr(text: string): void };
const MACHINE_CONTENT_TYPE = "application/vnd.evoloop-machine+json";

export const machineDirectory = (env: Environment): string => env.EVOLOOP_MACHINE_DIR?.trim() || join(homedir(), ".evoloop", "machine");

/** The Hub address: https, or http only to this machine itself (a Hub on loopback, as when trying one out). */
export function hubOrigin(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new MachineCommandError("INVALID_INPUT", "--hub must be the Hub's address, for example https://hub.example."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new MachineCommandError("INVALID_INPUT", "--hub must use https (http only for a Hub on this machine).");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new MachineCommandError("INVALID_INPUT", "--hub must be a bare origin without credentials, path, query or fragment.");
  return url.origin;
}

async function readCredentials(directory: string): Promise<MachineCredentials | null> {
  try { return machineCredentialsSchema.parse(JSON.parse(await readFile(join(directory, MACHINE_CREDENTIALS_FILE), "utf8"))); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new MachineCommandError("MACHINE_CREDENTIALS_INVALID", "The machine credentials file exists but cannot be read; it was not changed.");
  }
}

async function writeCredentials(directory: string, credentials: MachineCredentials): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, MACHINE_CREDENTIALS_FILE), temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/** Roots are real directories, absolute, not the filesystem root, and none inside another (the larger one would make the smaller meaningless). */
export async function normalizeRoots(input: string): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of input.split(",").map(value => value.trim()).filter(Boolean)) {
    if (!entry.startsWith("/")) throw new MachineCommandError("INVALID_INPUT", "--workspace-root must be absolute paths.");
    let real: string;
    try { real = await realpath(entry); } catch { throw new MachineCommandError("INVALID_INPUT", "A --workspace-root does not exist on this machine."); }
    if (!(await stat(real)).isDirectory()) throw new MachineCommandError("INVALID_INPUT", "A --workspace-root is not a directory.");
    if (real === sep) throw new MachineCommandError("INVALID_INPUT", "The filesystem root cannot be an allowed root.");
    if (!roots.includes(real)) roots.push(real);
  }
  if (!roots.length) throw new MachineCommandError("INVALID_INPUT", "join requires --workspace-root DIRECTORY[,DIRECTORY].");
  return roots.filter(root => !roots.some(other => other !== root && root.startsWith(`${other}${sep}`)));
}

async function confirmed(roots: string[], assumeYes: boolean, io: Io): Promise<void> {
  io.stderr(`This machine will allow evoLoop project directories only inside:\n${roots.map(root => `  ${root}`).join("\n")}\n`);
  if (assumeYes) return;
  if (!process.stdin.isTTY) throw new MachineCommandError("CONFIRMATION_REQUIRED", "Confirm the allowed roots by running join in a terminal, or pass --yes after checking them.");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try { if (!/^y(es)?$/i.test((await readline.question("Allow these roots? [y/N] ")).trim())) throw new MachineCommandError("NOT_CONFIRMED", "The allowed roots were not confirmed; nothing was changed."); }
  finally { readline.close(); }
}

function signedHeaders(credentials: MachineCredentials, action: string, body: string): Record<string, string> {
  const timestamp = String(Date.now()), nonce = randomUUID();
  const digest = createHash("sha256").update(body).digest("base64url");
  const signature = sign(null, Buffer.from(machineRequestMessage(credentials.machineId, action, timestamp, nonce, digest)), createPrivateKey(credentials.privateKey));
  return { "x-evoloop-machine": credentials.machineId, "x-evoloop-machine-time": timestamp, "x-evoloop-machine-nonce": nonce, "x-evoloop-machine-signature": signature.toString("base64url"),
    ...(body ? { "content-type": MACHINE_CONTENT_TYPE } : {}) };
}

async function hubError(response: Response): Promise<MachineCommandError> {
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  return new MachineCommandError(body?.error?.code ?? "HUB_REJECTED", body?.error?.message ?? `The Hub answered ${response.status}.`, { status: response.status });
}

export async function machineCommand(words: string[], options: Map<string, string | true>, env: Environment, io: Io, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const directory = machineDirectory(env);
  const mode = words[0];
  const allowed: Record<string, string[]> = { join: ["hub", "code", "workspace-root", "yes"], status: [], leave: ["local-only"] };
  if (!mode || !(mode in allowed) || words.length !== 1) throw new MachineCommandError("INVALID_INPUT", "Use machine join --hub URL --code CODE --workspace-root DIR [--yes] | status | leave [--local-only].");
  for (const key of options.keys()) if (!allowed[mode]!.includes(key)) throw new MachineCommandError("INVALID_INPUT", `--${key} does not apply to machine ${mode}.`);
  const existing = await readCredentials(directory);

  if (mode === "join") {
    if (existing) throw new MachineCommandError("ALREADY_JOINED", "This machine already joined a Hub; run machine leave first.");
    const hub = hubOrigin(typeof options.get("hub") === "string" ? options.get("hub") as string : undefined);
    const code = typeof options.get("code") === "string" ? options.get("code") as string : "";
    if (!code) throw new MachineCommandError("INVALID_INPUT", "join requires --code (the one-time code the Hub gave).");
    const roots = await normalizeRoots(typeof options.get("workspace-root") === "string" ? options.get("workspace-root") as string : "");
    await confirmed(roots, options.get("yes") === true, io);
    // The key pair is made here and the private half never leaves: the Hub gets only the public key.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const response = await fetchImpl(new URL("/api/machine/join", hub), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, publicKey: publicPem, allowedRoots: roots }), redirect: "manual" });
    if (response.status !== 201) throw await hubError(response);
    const joined = await response.json() as { machineId: string; name: string; hubPublicKeys: Array<{ kid: string; publicKey: string }> };
    const credentials = machineCredentialsSchema.parse({ version: 1, hubOrigin: hub, machineId: joined.machineId, name: joined.name, privateKey: privatePem,
      hubPublicKeys: joined.hubPublicKeys, allowedRoots: roots, joinedAt: new Date().toISOString() });
    await writeCredentials(directory, credentials);
    return { joined: true, machineId: credentials.machineId, name: credentials.name, hub, allowedRoots: roots,
      credentialsDirectory: directory,
      next: "Restart this machine's coordinator with EVOLOOP_MACHINE_DIR set to credentialsDirectory so it connects to the Hub (a coordinator without it does not read these credentials); the project directories in its configuration must be inside the allowed roots." };
  }

  if (!existing) return mode === "status" ? { joined: false } : { left: false, reason: "This machine has not joined a Hub." };

  if (mode === "status") {
    // Public facts only: never the private key.
    const summary = { joined: true, machineId: existing.machineId, name: existing.name, hub: existing.hubOrigin, allowedRoots: existing.allowedRoots, joinedAt: existing.joinedAt };
    try {
      const response = await fetchImpl(new URL("/api/machine/status", existing.hubOrigin), { method: "POST", headers: signedHeaders(existing, "status", "{}"), body: "{}", redirect: "manual" });
      if (!response.ok) { const error = await hubError(response); return { ...summary, hubReachable: true, hubAccepts: false, error: error.code }; }
      const remote = await response.json() as { state: string; online: boolean };
      return { ...summary, hubReachable: true, hubAccepts: true, state: remote.state, online: remote.online };
    } catch {
      return { ...summary, hubReachable: false };
    }
  }

  // leave
  let hubSaid: string;
  try {
    const response = await fetchImpl(new URL("/api/machine/leave", existing.hubOrigin), { method: "POST", headers: signedHeaders(existing, "leave", "{}"), body: "{}", redirect: "manual" });
    if (response.status === 204) hubSaid = "removed";
    else {
      const error = await hubError(response);
      if (error.code !== "MACHINE_REMOVED") throw error;
      hubSaid = "already_removed";
    }
  } catch (error) {
    if (options.get("local-only") !== true) {
      if (error instanceof MachineCommandError) throw error;
      throw new MachineCommandError("HUB_UNREACHABLE", "The Hub could not be reached, so it was not told this machine left. Nothing was deleted; retry, or use --local-only (an administrator must then remove the machine at the Hub).");
    }
    hubSaid = "not_told";
  }
  // The credentials go at once; the project data, the database and the coordinator are not touched.
  await rm(join(directory, MACHINE_CREDENTIALS_FILE), { force: true });
  return { left: true, machineId: existing.machineId, hub: hubSaid, projectDataKept: true };
}
