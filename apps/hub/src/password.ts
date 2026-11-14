import { argon2, argon2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { HubError } from "./errors.js";

const argon2Async = promisify(argon2);
const PARAMS = { memory: 32768, passes: 2, parallelism: 1, tagLength: 32 } as const;

const DUMMY_HASH =
  "$argon2id$v=19$m=32768,t=2,p=1$RC5kk5z7HniqPPNeA5rMdQ$-kU8EG9G35jJxWO77A9Hd2LnP33Tdgn-l4rVjNZApmk";

type ParsedHash = {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
  salt: Buffer;
  digest: Buffer;
};

export function assertPasswordPolicy(password: string): void {
  if (password.length < 12) throw new HubError(400, "PASSWORD_TOO_SHORT", "The password must contain at least 12 characters.");
  if (password.length > 256) throw new HubError(400, "PASSWORD_TOO_LONG", "The password must contain at most 256 characters.");
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const digest = await argon2Async("argon2id", { message: Buffer.from(password, "utf8"), nonce: salt, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  try {
    const digest = await argon2Async("argon2id", {
      message: Buffer.from(password, "utf8"),
      nonce: parsed.salt,
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.tagLength,
    });
    return digest.length === parsed.digest.length && timingSafeEqual(digest, parsed.digest);
  } catch {
    return false;
  }
}

export async function spendDummyPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

export function passwordHashAlgorithm(encoded: string): string | null {
  return encoded.startsWith("$argon2id$") ? "argon2id" : null;
}

function parsePasswordHash(encoded: string): ParsedHash | null {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return null;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (!Number.isInteger(memory) || !Number.isInteger(passes) || !Number.isInteger(parallelism)) return null;
  try {
    return {
      memory,
      passes,
      parallelism,
      tagLength: Buffer.from(match[5]!, "base64url").length,
      salt: Buffer.from(match[4]!, "base64url"),
      digest: Buffer.from(match[5]!, "base64url"),
    };
  } catch {
    return null;
  }
}

// Keep the synchronous primitive referenced so a future platform without the async callback fails at build time,
// not only when the first user tries to sign in.
void argon2Sync;
