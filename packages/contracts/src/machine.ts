import { z } from "zod";

/**
 * What a machine keeps privately after `evoloop machine join` (one file, 0600, in the machine's own state directory): who it is to the Hub, its own
 * private key, the Hub public keys it verifies request identities with, and the code roots the person at the machine confirmed. Nothing here is ever sent to the Hub
 * except the public key and the roots; the file is not part of any repository.
 */
export const machineCredentialsSchema = z.strictObject({
  version: z.literal(1),
  hubOrigin: z.string().url(),
  machineId: z.uuid(),
  name: z.string().min(1).max(120),
  /** Ed25519 PKCS#8 PEM. Leaves this machine never. */
  privateKey: z.string().min(1),
  /** Every Hub signing key the machine trusts, newest first (a rotated key stays valid until removed here). */
  hubPublicKeys: z.array(z.strictObject({ kid: z.string().min(1).max(100), publicKey: z.string().min(1) })).min(1).max(8),
  /** Absolute real paths confirmed on this machine; project directories must be inside one of them. */
  allowedRoots: z.array(z.string().min(1).max(1000)).min(1).max(20),
  joinedAt: z.string().min(1),
});
export type MachineCredentials = z.infer<typeof machineCredentialsSchema>;

export const MACHINE_CREDENTIALS_FILE = "machine.json";
/** Header the Hub's signed request identity travels in on the loopback hop from the connector to the coordinator. */
export const HUB_IDENTITY_HEADER = "x-evoloop-hub-identity";
/** The only paths the connector hands to the coordinator: a project's API, and the command endpoint (its project is in the body). */
export const FORWARDED_PATH = /^\/api\/(?:commands|projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]+)(?:\?[^\s#]*)?$/i;
export const FORWARDED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * What a machine signs for each request to the Hub: its ID, the action, a time, a one-use nonce and a digest of the body. The Hub builds the same string
 * (apps/hub/src/identity.ts) and checks the signature with the public key the machine uploaded when it joined.
 */
export const MACHINE_REQUEST_DOMAIN = "evoloop-machine-request-v1";
export const machineRequestMessage = (machineId: string, action: string, timestamp: string, nonce: string, bodyDigest: string): string =>
  `${MACHINE_REQUEST_DOMAIN}\n${machineId}\n${action}\n${timestamp}\n${nonce}\n${bodyDigest}`;
