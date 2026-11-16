import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";

/**
 * The short-lived identity the Hub signs for one forwarded request, and the signed requests a machine sends the Hub.
 *
 * A request identity is `v1.<payload>.<signature>` (base64url). The signature is Ed25519 over `evoloop-hub-identity-v1\n<payload>`.
 * The coordinator verifies it with the Hub public key its machine saved when it joined (apps/coordinator/src/hub/identity.ts, which
 * must read exactly this format; tests/integration/hub-machine.test.ts signs here and verifies there).
 */
export const IDENTITY_DOMAIN = "evoloop-hub-identity-v1";
export const MACHINE_DOMAIN = "evoloop-machine-request-v1";
export const IDENTITY_TTL_SECONDS = 60;

export type RequestIdentity = {
  v: 1;
  kid: string;
  /** Only the machine with this ID may accept it. */
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  /** The original requester: the account or service identity that called the Hub, never the machine or the connector. */
  sub: { actorId: string; kind: "human" | "service"; accountId?: string; serviceIdentityId?: string; auth: string };
  projectId: string;
  permissions: Array<"task" | "document" | "session" | "management">;
  decisions: boolean;
  /** Empty means every Session in the project (the same meaning as the project member list). */
  sessionIds: string[];
  /** The request this identity was issued for: method and a SHA-256 of `<path>?<query>` as the Hub forwards it. */
  method: string;
  target: string;
};

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export const targetDigest = (pathAndQuery: string): string => createHash("sha256").update(pathAndQuery, "utf8").digest("base64url");

export type SigningKey = { kid: string; publicKey: string; privateKey: string };

export function generateSigningKey(kid: string = `hub-${randomUUID().slice(0, 8)}`): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    kid,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signIdentity(key: SigningKey, identity: Omit<RequestIdentity, "v" | "kid">): string {
  const payload = b64(JSON.stringify({ v: 1, kid: key.kid, ...identity }));
  const signature = sign(null, Buffer.from(`${IDENTITY_DOMAIN}\n${payload}`), createPrivateKey(key.privateKey));
  return `v1.${payload}.${b64(signature)}`;
}

/** What a machine proves with each request to the Hub: its ID, a timestamp, a nonce and what it asks for, signed with its own key. */
export const machineRequestMessage = (machineId: string, action: string, timestamp: string, nonce: string, bodyDigest: string): string =>
  `${MACHINE_DOMAIN}\n${machineId}\n${action}\n${timestamp}\n${nonce}\n${bodyDigest}`;

export function verifyMachineSignature(publicKeyPem: string, message: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(message), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export const bodyDigest = (body: string | Buffer | undefined): string =>
  createHash("sha256").update(body ?? "").digest("base64url");
