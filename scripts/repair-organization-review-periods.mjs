import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";
import pg from "pg";
import { observationPeriod } from "../.agents/skills/evoloop-evocation/scripts/review-format.mjs";

export const repairCommandType = "repair.organization_review_period";
export const coordinatorLeaseKey = 731209842;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFields = ["project_id", "document_id", "revision_id", "body", "format", "content_hash", "author",
  "created_at", "previous_revision_id", "reason", "media_type", "original_name", "payload_ref", "entrypoint",
  "assets_manifest"];
const knownUpdateTriggers = new Set(["immutable_document_revision", "document_revision_allocation_observation"]);
const runPgRestore = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported JSON value");
  return result;
}

function decodeCopyField(value) {
  if (value === "\\N") return null;
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[++index];
    if (escape === undefined) throw new Error("COPY row ends with a backslash");
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
    if (escape in simple) {
      result += simple[escape];
      continue;
    }
    if (escape === "x") {
      let digits = "";
      while (digits.length < 2 && /[0-9a-f]/i.test(value[index + 1] ?? "")) digits += value[++index];
      if (!digits) throw new Error("COPY row has an invalid hexadecimal escape");
      result += String.fromCodePoint(Number.parseInt(digits, 16));
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let digits = escape;
      while (digits.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) digits += value[++index];
      result += String.fromCodePoint(Number.parseInt(digits, 8));
      continue;
    }
    throw new Error(`COPY row has an unknown escape: \\${escape}`);
  }
  return result;
}

function copyColumns(value) {
  return value.split(",").map(item => {
    const column = item.trim();
    const quoted = column.startsWith("\"") && column.endsWith("\"");
    return quoted ? column.slice(1, -1).replaceAll("\"\"", "\"") : column;
  });
}

/** Read only the document_revision COPY block from pg_restore's plain SQL output. */
export function parseDocumentRevisionCopy(sql) {
  const lines = sql.split(/\r?\n/);
  let columns = null;
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const header = /^COPY\s+(?:"?public"?\.)?"?document_revision"?\s+\((.*)\)\s+FROM\s+stdin;$/i.exec(lines[index]);
    if (!header) continue;
    const nextColumns = copyColumns(header[1]);
    if (columns && !isDeepStrictEqual(columns, nextColumns))
      throw new Error("Source dump has document_revision COPY blocks with different columns");
    columns = nextColumns;
    for (index++; index < lines.length; index++) {
      if (lines[index] === "\\.") break;
      const fields = lines[index].split("\t");
      if (fields.length !== nextColumns.length)
        throw new Error(`Source dump has a document_revision row with ${fields.length} fields instead of ${nextColumns.length}`);
      rows.push(Object.fromEntries(nextColumns.map((column, field) => [column, decodeCopyField(fields[field])])));
    }
    if (index >= lines.length) throw new Error("Source dump has an unterminated document_revision COPY block");
  }
  if (!columns) throw new Error("Source dump has no document_revision COPY block");
  return { columns, rows };
}

export async function fileSha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function absent(path) {
  try { await stat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

async function externalPath(path, label) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let ancestor = path;
  while (await absent(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(await realpath(ancestor), relative(ancestor, path));
  const root = await realpath(repoRoot);
  if (canonical === root || canonical.startsWith(root + sep))
    throw new Error(`${label} must stay outside the repository`);
  return canonical;
}

export async function readSourceDumpRows(dumpPath) {
  const binDir = process.env.EVOLOOP_PG_BIN_DIR;
  if (binDir && !isAbsolute(binDir)) throw new Error("EVOLOOP_PG_BIN_DIR must be absolute");
  const executable = binDir ? join(binDir, "pg_restore") : "pg_restore";
  const { stdout } = await runPgRestore(executable,
    ["--data-only", "--table=document_revision", "--file=-", dumpPath],
    { maxBuffer: 256 * 1024 * 1024 });
  return parseDocumentRevisionCopy(stdout);
}

function jsonColumn(value, column, row) {
  if (value === null) return null;
  try { return JSON.parse(value); }
  catch { throw new Error(`Source revision ${row.document_id}/${row.revision_id} has invalid ${column} JSON`); }
}

export function normalizeSourceRow(row) {
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime()))
    throw new Error(`Source revision ${row.document_id}/${row.revision_id} has an invalid created_at`);
  return {
    ...row,
    created_at: createdAt.toISOString(),
    assets_manifest: jsonColumn(row.assets_manifest, "assets_manifest", row),
    organization_review: jsonColumn(row.organization_review, "organization_review", row),
  };
}

export function normalizeTargetRow(row) {
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime()))
    throw new Error(`Target revision ${row.document_id}/${row.revision_id} has an invalid created_at`);
  return {
    ...row,
    created_at: createdAt.toISOString(),
    assets_manifest: row.assets_manifest ?? [],
    organization_review: row.organization_review ?? null,
    revision_number: Number(row.revision_number),
  };
}

function validateReviewPeriod(value, row) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Source revision ${row.document_id}/${row.revision_id} has no organizationReview object`);
  const allowed = new Set(["observedFrom", "observedTo", "timeZone", "previous"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Source revision ${row.document_id}/${row.revision_id} has an unknown organizationReview field: ${key}`);
  if (value.previous) {
    const keys = Object.keys(value.previous).sort();
    if (!isDeepStrictEqual(keys, ["documentId", "revisionId"]))
      throw new Error(`Source revision ${row.document_id}/${row.revision_id} has an invalid previous reference`);
  }
  observationPeriod(value);
  return value;
}

function driftedFields(source, target) {
  return sourceFields.filter(field => !isDeepStrictEqual(source[field], target[field]));
}

function publicChange(change) {
  return {
    documentId: change.documentId,
    revisionId: change.revisionId,
    before: null,
    after: change.after,
    contentHash: change.before.content_hash,
    author: change.before.author,
    createdAt: change.before.created_at,
    payloadRef: change.before.payload_ref,
    bodySha256: change.before.body === null ? null : sha256(change.before.body),
    revisionNumber: change.before.revision_number,
  };
}

/**
 * Compare the source dump with the current target rows. This function never writes.
 * Any non-organization_review difference blocks the repair because overwriting it
 * would make the "only the lost field changed" claim false.
 */
export function planOrganizationReviewRepair({ projectId, documentIds, sourceRows, targetRows, documents }) {
  const blocked = [];
  const changes = [];
  const already = [];
  const targetOnly = [];
  const sourceByDocument = new Map();
  const targetByDocument = new Map();
  for (const row of sourceRows)
    sourceByDocument.set(row.document_id, [...(sourceByDocument.get(row.document_id) ?? []), row]);
  for (const row of targetRows)
    targetByDocument.set(row.document_id, [...(targetByDocument.get(row.document_id) ?? []), row]);

  for (const documentId of documentIds) {
    const source = (sourceByDocument.get(documentId) ?? []).map(normalizeSourceRow);
    const target = (targetByDocument.get(documentId) ?? []).map(normalizeTargetRow);
    const document = documents.get(documentId);
    if (!document) {
      blocked.push({ code: "DOCUMENT_NOT_FOUND", documentId });
      continue;
    }
    if (document.kind !== "organization_review") {
      blocked.push({ code: "DOCUMENT_NOT_ORGANIZATION_REVIEW", documentId, kind: document.kind });
      continue;
    }
    if (!source.length) {
      blocked.push({ code: "SOURCE_REVISIONS_NOT_FOUND", documentId });
      continue;
    }
    const targetByRevision = new Map(target.map(row => [row.revision_id, row]));
    const sourceIds = new Set(source.map(row => row.revision_id));
    for (const row of target)
      if (!sourceIds.has(row.revision_id)) targetOnly.push({ documentId, revisionId: row.revision_id });
    for (const row of source) {
      if (row.project_id !== projectId) {
        blocked.push({ code: "SOURCE_PROJECT_MISMATCH", documentId, revisionId: row.revision_id });
        continue;
      }
      const current = targetByRevision.get(row.revision_id);
      if (!current) {
        blocked.push({ code: "TARGET_REVISION_NOT_FOUND", documentId, revisionId: row.revision_id });
        continue;
      }
      const fields = driftedFields(row, current);
      if (fields.length) {
        blocked.push({ code: "SOURCE_TARGET_DRIFT", documentId, revisionId: row.revision_id, fields });
        continue;
      }
      try { validateReviewPeriod(row.organization_review, row); }
      catch (error) {
        blocked.push({ code: "INVALID_SOURCE_PERIOD", documentId, revisionId: row.revision_id, message: error.message });
        continue;
      }
      if (current.organization_review === null)
        changes.push({ documentId, revisionId: row.revision_id, before: current, after: row.organization_review });
      else if (isDeepStrictEqual(current.organization_review, row.organization_review))
        already.push({ documentId, revisionId: row.revision_id });
      else
        blocked.push({ code: "TARGET_PERIOD_DIFFERS", documentId, revisionId: row.revision_id });
    }
    const current = targetByRevision.get(document.current_revision_id);
    if (!current) {
      blocked.push({ code: "CURRENT_REVISION_NOT_FOUND", documentId, revisionId: document.current_revision_id });
      continue;
    }
    const planned = changes.find(change => change.documentId === documentId &&
      change.revisionId === document.current_revision_id);
    if (!current.organization_review && !planned)
      blocked.push({ code: "CURRENT_REVISION_WITHOUT_PERIOD", documentId, revisionId: current.revision_id });
  }

  return {
    status: blocked.length ? "blocked" : changes.length ? "planned" : "already-repaired",
    changes,
    already,
    blocked,
    targetOnly,
  };
}

export function commandHashForPlan({ projectId, actorId, sourceDumpSha256, changes }) {
  return sha256(canonicalJson({
    commandType: repairCommandType,
    projectId,
    actorId,
    sourceDumpSha256,
    revisions: changes.map(change => ({
      documentId: change.documentId,
      revisionId: change.revisionId,
      before: change.before.organization_review,
      after: change.after,
    })),
  }));
}

export async function loadTargetRows(client, projectId, documentIds) {
  const documents = new Map((await client.query(
    `SELECT document_id, kind, title, status, current_revision_id, version
       FROM process_document WHERE project_id=$1 AND document_id = ANY($2::uuid[])`,
    [projectId, documentIds])).rows.map(row => [row.document_id, row]));
  const rows = (await client.query(
    `SELECT project_id, document_id, revision_id, body, format, content_hash, author, created_at,
            previous_revision_id, reason, media_type, original_name, payload_ref, entrypoint,
            assets_manifest, organization_review, revision_number
       FROM document_revision
      WHERE project_id=$1 AND document_id = ANY($2::uuid[])
      ORDER BY document_id, revision_number`,
    [projectId, documentIds])).rows;
  return { documents, rows };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function enableTriggerSql(state) {
  if (state === "O") return "ENABLE TRIGGER";
  if (state === "D") return "DISABLE TRIGGER";
  if (state === "R") return "ENABLE REPLICA TRIGGER";
  if (state === "A") return "ENABLE ALWAYS TRIGGER";
  throw new Error(`Unknown trigger state: ${state}`);
}

async function targetRowsForChanges(client, projectId, changes) {
  const documentIds = [...new Set(changes.map(change => change.documentId))];
  const { rows } = await loadTargetRows(client, projectId, documentIds);
  return new Map(rows.map(row => [`${row.document_id}/${row.revision_id}`, normalizeTargetRow(row)]));
}

/** Apply already-planned updates in one transaction. No body, hash, author, time or link is written. */
export async function applyOrganizationReviewPeriodRepair({
  client, projectId, actorId, sourceDumpSha256, sourceSchema = null, sourceMain = null,
  changes, operationId = randomUUID(), commandHash = null,
}) {
  if (!changes.length) throw new Error("The repair plan has no changes");
  const hash = commandHash ?? commandHashForPlan({ projectId, actorId, sourceDumpSha256, changes });
  let transaction = false;
  let locked = false;
  try {
    await client.query("BEGIN");
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS held", [coordinatorLeaseKey]);
    locked = lock.rows[0]?.held === true;
    if (!locked) throw new Error("Coordinator is still running; stop writers before applying the repair");
    if (!(await client.query("SELECT 1 FROM project WHERE project_id=$1", [projectId])).rowCount)
      throw new Error("Project was not found");

    const currentRows = await targetRowsForChanges(client, projectId, changes);
    for (const change of changes) {
      const current = currentRows.get(`${change.documentId}/${change.revisionId}`);
      if (!current || !isDeepStrictEqual(current, change.before))
        throw new Error(`Revision changed after planning: ${change.documentId}/${change.revisionId}`);
      if (current.organization_review !== null)
        throw new Error(`Revision already has organizationReview: ${change.documentId}/${change.revisionId}`);
    }

    const triggerRows = (await client.query(
      `SELECT tgname, tgenabled, (tgtype & 16) <> 0 AS updates FROM pg_trigger
        WHERE tgrelid='document_revision'::regclass AND NOT tgisinternal
        ORDER BY tgname`)).rows;
    const updateTriggers = triggerRows.filter(row => row.updates);
    const immutable = updateTriggers.find(row => row.tgname === "immutable_document_revision");
    if (!immutable) throw new Error("document_revision immutable trigger was not found");
    if (immutable.tgenabled !== "O") throw new Error("document_revision immutable trigger is not enabled");
    for (const trigger of updateTriggers)
      if (!knownUpdateTriggers.has(trigger.tgname))
        throw new Error(`Unexpected document_revision UPDATE trigger: ${trigger.tgname}`);
    const disabled = updateTriggers;
    if (disabled.length) {
      const actions = disabled.map(row => `DISABLE TRIGGER ${quoteIdentifier(row.tgname)}`).join(", ");
      await client.query(`ALTER TABLE document_revision ${actions}`);
    }

    for (const change of changes) {
      const result = await client.query(
        `UPDATE document_revision SET organization_review=$4::jsonb
          WHERE project_id=$1 AND document_id=$2 AND revision_id=$3 AND organization_review IS NULL`,
        [projectId, change.documentId, change.revisionId, JSON.stringify(change.after)]);
      if (result.rowCount !== 1)
        throw new Error(`Revision was not updated exactly once: ${change.documentId}/${change.revisionId}`);
    }

    const afterRows = await targetRowsForChanges(client, projectId, changes);
    for (const change of changes) {
      const after = afterRows.get(`${change.documentId}/${change.revisionId}`);
      if (!after) throw new Error(`Revision disappeared during repair: ${change.documentId}/${change.revisionId}`);
      const fields = driftedFields(change.before, after);
      if (fields.length)
        throw new Error(`Non-organizationReview fields changed during repair: ${fields.join(", ")}`);
      if (!isDeepStrictEqual(after.organization_review, change.after))
        throw new Error(`organizationReview was not written exactly: ${change.documentId}/${change.revisionId}`);
    }

    if (disabled.length) {
      const actions = disabled.map(row => `${enableTriggerSql(row.tgenabled)} ${quoteIdentifier(row.tgname)}`).join(", ");
      await client.query(`ALTER TABLE document_revision ${actions}`);
    }

    const result = {
      status: "applied",
      operationId,
      repair: repairCommandType,
      projectId,
      source: { dumpSha256: sourceDumpSha256, schema: sourceSchema, main: sourceMain },
      revisions: changes.map(publicChange),
    };
    const journal = await client.query(
      `INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,now())
       RETURNING created_at`,
      [projectId, operationId, actorId, hash, repairCommandType, JSON.stringify(result)]);
    await client.query("COMMIT");
    transaction = false;
    return { operationId, commandHash: hash, createdAt: new Date(journal.rows[0].created_at).toISOString(), result };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [coordinatorLeaseKey]).catch(() => {});
  }
}

export async function readRepairReadback(client, { projectId, documentIds, operationId }) {
  const { documents, rows } = await loadTargetRows(client, projectId, documentIds);
  const byRevision = new Map(rows.map(row => [`${row.document_id}/${row.revision_id}`, normalizeTargetRow(row)]));
  const journal = (await client.query(
    `SELECT operation_id, actor_id, command_type, command_hash, result, created_at
       FROM operation_journal WHERE project_id=$1 AND operation_id=$2`, [projectId, operationId])).rows[0];
  const currentPeriods = [...documents.values()].map(document => {
    const row = byRevision.get(`${document.document_id}/${document.current_revision_id}`);
    return { documentId: document.document_id, currentRevisionId: document.current_revision_id,
      organizationReview: row?.organization_review ?? null };
  });
  return {
    revisions: rows.map(row => ({
      documentId: row.document_id,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      organizationReview: row.organization_review,
      contentHash: row.content_hash,
      author: row.author,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    currentPeriods,
    operation: journal ? {
      operationId: journal.operation_id,
      actorId: journal.actor_id,
      commandType: journal.command_type,
      commandHash: journal.command_hash,
      result: journal.result,
      createdAt: new Date(journal.created_at).toISOString(),
    } : null,
  };
}

function parseArguments(argv) {
  const options = { documentIds: [], apply: false };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--help" || name === "-h") { options.help = true; continue; }
    if (name === "--apply") { options.apply = true; continue; }
    if (!["--source-dump", "--source-sha256", "--project", "--actor", "--document", "--database-url",
      "--report-out", "--source-schema", "--source-main"].includes(name) || argv[index + 1] === undefined)
      throw new Error(`Unknown or incomplete option: ${name}`);
    const value = argv[++index];
    if (name === "--document") options.documentIds.push(value);
    else if (name === "--source-dump") options.sourceDump = value;
    else if (name === "--source-sha256") options.sourceSha256 = value;
    else if (name === "--project") options.projectId = value;
    else if (name === "--actor") options.actorId = value;
    else if (name === "--database-url") options.databaseUrl = value;
    else if (name === "--report-out") options.reportOut = value;
    else if (name === "--source-schema") options.sourceSchema = value;
    else if (name === "--source-main") options.sourceMain = value;
  }
  return options;
}

function usage() {
  return `Usage: node scripts/repair-organization-review-periods.mjs \\
  --source-dump /absolute/private/evoloop-source.dump \\
  --source-sha256 <sha256> \\
  --project <project-uuid> --actor <actor-id> \\
  --document <organization-review-uuid> [--document <uuid> ...] \\
  [--database-url <postgres-url>] [--apply] [--report-out /absolute/private/report.json]`;
}

function reportPlan(plan) {
  return {
    status: plan.status,
    changes: plan.changes.map(publicChange),
    already: plan.already,
    blocked: plan.blocked,
    targetOnly: plan.targetOnly,
  };
}

async function writeReport(path, report) {
  const target = await externalPath(path, "report path");
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return target;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.sourceDump || !options.projectId || !options.actorId || !options.documentIds.length)
    throw new Error(usage());
  if (options.apply && !options.sourceSha256)
    throw new Error("--source-sha256 is required with --apply");
  if (options.apply && !options.reportOut)
    throw new Error("--report-out is required with --apply");
  const documentIds = [...new Set(options.documentIds)];
  const dumpPath = await externalPath(options.sourceDump, "Source dump");
  const sourceDumpSha256 = await fileSha256(dumpPath);
  if (options.sourceSha256 && sourceDumpSha256 !== options.sourceSha256.toLowerCase())
    throw new Error(`Source dump SHA-256 mismatch: ${sourceDumpSha256}`);
  const parsed = await readSourceDumpRows(dumpPath);
  const sourceRows = parsed.rows.filter(row => documentIds.includes(row.document_id));
  if (!sourceRows.length) throw new Error("Source dump has no revisions for the requested Documents");

  const databaseUrl = options.databaseUrl ?? process.env.EVOLOOP_REPAIR_DATABASE_URL ?? process.env.EVOLOOP_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set EVOLOOP_DATABASE_URL or pass --database-url");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { documents, rows } = await loadTargetRows(client, options.projectId, documentIds);
    const plan = planOrganizationReviewRepair({
      projectId: options.projectId, documentIds, sourceRows, targetRows: rows, documents,
    });
    const base = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      projectId: options.projectId,
      actorId: options.actorId,
      sourceDump: { sha256: sourceDumpSha256, schema: options.sourceSchema ?? null, main: options.sourceMain ?? null },
      documents: documentIds,
      plan: reportPlan(plan),
    };
    if (plan.status === "blocked") {
      const report = { ...base, status: "blocked" };
      if (options.reportOut) await writeReport(options.reportOut, report);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!options.apply || plan.status === "already-repaired") {
      const report = { ...base, status: plan.status };
      if (options.reportOut) await writeReport(options.reportOut, report);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const commandHash = commandHashForPlan({
      projectId: options.projectId, actorId: options.actorId, sourceDumpSha256, changes: plan.changes,
    });
    const applied = await applyOrganizationReviewPeriodRepair({
      client,
      projectId: options.projectId,
      actorId: options.actorId,
      sourceDumpSha256,
      sourceSchema: options.sourceSchema ?? null,
      sourceMain: options.sourceMain ?? null,
      changes: plan.changes,
      commandHash,
    });
    const readback = await readRepairReadback(client, {
      projectId: options.projectId, documentIds, operationId: applied.operationId,
    });
    if (readback.currentPeriods.some(item => !item.organizationReview))
      throw new Error("Readback found a current revision without organizationReview");
    if (!readback.operation || readback.operation.commandHash !== commandHash)
      throw new Error("Readback did not find the repair operation");
    const report = {
      ...base,
      status: "applied",
      operation: applied,
      readback,
    };
    if (options.reportOut) await writeReport(options.reportOut, report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
