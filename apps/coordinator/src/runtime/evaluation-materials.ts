import { createHash } from "node:crypto";
import type { EvaluationFixedRef, Principal, RuntimeRunRecord } from "@evoloop/contracts";

export const evaluationPacketBuilderVersion = "evoLoop-evaluation-packet/1";
export const evaluationPacketMediaType = "application/vnd.evoloop.evaluation-packet+json";
export const maxEvaluationPacketBytes = 16 * 1024 * 1024;

export interface FixedEvaluationMaterial { content: string; contentHash: string }
export type ReadEvaluationMaterial = (principal: Principal,
  projectId: string, source: EvaluationFixedRef) => Promise<FixedEvaluationMaterial>;

export interface EvaluationPacketManifest {
  builderVersion: string;
  projectId: string;
  runId: string;
  operationId: string;
  taskId: string;
  taskRevisionId: string;
  evaluation: NonNullable<RuntimeRunRecord["evaluationBinding"]>;
  sources: EvaluationFixedRef[];
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function canonicalEvaluationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvaluationJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvaluationJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

const sourceKey = (source: EvaluationFixedRef) => `${source.kind}\0${source.id}\0${source.revision}\0${source.contentHash}`;

export function uniqueEvaluationSources(sources: EvaluationFixedRef[]): EvaluationFixedRef[] {
  const unique = new Map<string, EvaluationFixedRef>();
  for (const source of sources) unique.set(sourceKey(source), source);
  return [...unique.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

export function evaluationPacketManifest(run: RuntimeRunRecord, sources: EvaluationFixedRef[]): EvaluationPacketManifest {
  if (!run.evaluationBinding) throw new Error("Evaluation binding is required for a dispatch packet");
  return { builderVersion: evaluationPacketBuilderVersion, projectId: run.projectId, runId: run.id,
    operationId: run.operationId, taskId: run.taskId, taskRevisionId: run.taskRevisionId,
    evaluation: run.evaluationBinding, sources: uniqueEvaluationSources(sources) };
}

export async function buildEvaluationPacket(principal: Principal, run: RuntimeRunRecord, taskInput: string, rawSources: EvaluationFixedRef[],
  readMaterial: ReadEvaluationMaterial): Promise<{ content: string; contentHash: string; manifestHash: string; builderVersion: string; sources: EvaluationFixedRef[] }> {
  if (!run.evaluationBinding) throw new Error("Evaluation binding is required for a dispatch packet");
  if (!run.input || !taskInput) throw new Error("Complete frozen Task input is required");
  const sources = uniqueEvaluationSources(rawSources);
  if (!sources.length) throw new Error("Evaluation packet has no fixed sources");
  const materials = [];
  for (const source of sources) {
    if (!run.projectId || !source.id || !source.revision || !/^[a-f0-9]{64}$/.test(source.contentHash))
      throw new Error("Evaluation source reference is incomplete");
    const material = await readMaterial(principal, run.projectId, source);
    if (!material || typeof material.content !== "string" || material.contentHash !== source.contentHash)
      throw new Error(`Fixed evaluation source ${source.kind}:${source.id}@${source.revision} failed hash verification`);
    materials.push({ source, ...material });
  }
  const manifest = evaluationPacketManifest(run, sources);
  const manifestHash = sha256(canonicalEvaluationJson(manifest));
  const content = `[evoloop-run-operation:${run.operationId}]\n${JSON.stringify({ manifest, taskInput, materials })}`;
  if (Buffer.byteLength(content, "utf8") > maxEvaluationPacketBytes)
    throw new Error("Complete evaluation packet exceeds the 16 MiB external Blob limit");
  return { content, contentHash: sha256(content), manifestHash, builderVersion: evaluationPacketBuilderVersion, sources };
}

export function evaluationPacketBlobId(size: number, randomId: string): string {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxEvaluationPacketBytes || !/^[a-f0-9-]{36}$/i.test(randomId))
    throw new Error("Evaluation packet Blob metadata is invalid");
  return `eval_packet_${randomId.replaceAll("-", "")}_s${size}`;
}

export function evaluationPacketBlobPayload(payloadRef: string, projectId: string, contentHash: string) {
  const match = /^eval_packet_[a-f0-9]{32}_s(0|[1-9][0-9]*)$/.exec(payloadRef);
  if (!match || !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("Evaluation packet Blob reference is invalid");
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size > maxEvaluationPacketBytes) throw new Error("Evaluation packet Blob size is invalid");
  return { id: payloadRef, projectId, contentHash, size, mediaType: evaluationPacketMediaType };
}

export async function verifyEvaluationPacket(principal: Principal, run: RuntimeRunRecord, content: string,
  readMaterial: ReadEvaluationMaterial, expectedTaskInput?: string): Promise<{ manifestHash: string; builderVersion: string; sources: EvaluationFixedRef[] }> {
  const binding = run.evaluationPacket;
  if (!run.evaluationBinding || !binding) throw new Error("Evaluation packet is not attached to this Run");
  if (binding.builderVersion !== evaluationPacketBuilderVersion || sha256(content) !== binding.contentHash ||
      !/^[a-f0-9]{64}$/.test(binding.manifestHash)) throw new Error("Stored evaluation packet metadata failed verification");
  const expectedSources = uniqueEvaluationSources(binding.sources);
  if (canonicalEvaluationJson(expectedSources) !== canonicalEvaluationJson(binding.sources) || !expectedSources.length)
    throw new Error("Stored evaluation packet source manifest is malformed");
  const expectedManifest = evaluationPacketManifest(run, expectedSources);
  const manifestHash = sha256(canonicalEvaluationJson(expectedManifest));
  if (manifestHash !== binding.manifestHash) throw new Error("Stored evaluation packet manifest hash failed verification");
  const split = content.indexOf("\n");
  if (split < 0 || content.slice(0, split) !== `[evoloop-run-operation:${run.operationId}]`)
    throw new Error("Stored evaluation packet operation marker failed verification");
  let decoded: unknown;
  try { decoded = JSON.parse(content.slice(split + 1)); } catch { throw new Error("Stored evaluation packet JSON is invalid"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Stored evaluation packet shape is invalid");
  const packet = decoded as { manifest?: unknown; taskInput?: unknown; materials?: unknown };
  if (canonicalEvaluationJson(packet.manifest) !== canonicalEvaluationJson(expectedManifest) ||
      typeof packet.taskInput !== "string" || !packet.taskInput ||
      (expectedTaskInput !== undefined && packet.taskInput !== expectedTaskInput) || !Array.isArray(packet.materials) ||
      packet.materials.length !== expectedSources.length) throw new Error("Stored evaluation packet body differs from its manifest");
  for (let index = 0; index < expectedSources.length; index++) {
    const expected = expectedSources[index]!;
    const material = packet.materials[index] as { source?: unknown; content?: unknown; contentHash?: unknown };
    if (canonicalEvaluationJson(material?.source) !== canonicalEvaluationJson(expected) || typeof material?.content !== "string" ||
        material.contentHash !== expected.contentHash)
      throw new Error("Stored evaluation packet material failed source hash verification");
    const current = await readMaterial(principal, run.projectId, expected);
    if (current.contentHash !== expected.contentHash || current.content !== material.content)
      throw new Error("A fixed evaluation source is no longer readable or unchanged");
  }
  return { manifestHash, builderVersion: binding.builderVersion, sources: expectedSources };
}
