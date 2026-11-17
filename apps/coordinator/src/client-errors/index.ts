// A page that stopped rendering leaves a record the service can read back (Task c3a8e5d1). The browser posts what its page boundary caught; this module bounds
// and redacts it, stores it once, and lists the newest. It is a diagnostic list for one failure kind, not an error-reporting system: nothing here is aggregated,
// sampled or sent anywhere, and each project keeps its newest 200 rows.
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

export const clientRenderErrorSchema = z.strictObject({
  route: z.string().max(2000),
  message: z.string().max(20000),
  componentStack: z.string().max(40000).default(""),
  commit: z.string().max(100).nullable().default(null),
  occurredAt: z.iso.datetime().optional(),
});
export type ClientRenderErrorInput = z.infer<typeof clientRenderErrorSchema>;

export interface ClientRenderErrorRecord {
  id: string; actorId: string; route: string; message: string; componentStack: string; commit: string | null; occurredAt: string; recordedAt: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Token-like text never reaches the table: `Bearer …`, `token=…`, a Hub identity (`v1.payload.signature`) and any run of 32 or more URL-safe characters that is not a UUID
 * or a commit hash (a token file entry is at least 32 characters). Routes keep their `?session=` and other ids; only these shapes are cut.
 */
export function redactTokenLike(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐去]")
    .replace(/([?&;\s"'](?:token|access_token|authorization|csrf|key|secret|password)=)[^&\s"']+/gi, "$1[已隐去]")
    .replace(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[已隐去]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, run => {
      // A UUID, a commit hash, or a UUID with a short prefix (`owned%3A<uuid>` in a route) is an id, not a secret: judge the run without them.
      const rest = run.replace(new RegExp(UUID, "gi"), "").replace(/\b[0-9a-f]{40}\b/gi, "");
      return rest.length >= 32 ? "[已隐去]" : run;
    });
}
const bounded = (text: string, max: number) => { const clean = redactTokenLike(text.replace(/\u0000/g, "")); return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean; };

/** What is stored: every field cut to a fixed size and redacted. The route loses its fragment; the commit must look like a commit hash. */
export function sanitizeClientRenderError(input: ClientRenderErrorInput, now: Date): Omit<ClientRenderErrorRecord, "id" | "actorId" | "recordedAt"> {
  const occurred = input.occurredAt ? new Date(input.occurredAt) : now;
  const future = occurred.getTime() > now.getTime() + 60_000;
  return {
    route: bounded(input.route.split("#")[0]!, 400),
    message: bounded(input.message, 600),
    componentStack: bounded(input.componentStack, 2400),
    commit: input.commit && /^[0-9a-f]{7,40}$/.test(input.commit) ? input.commit : null,
    occurredAt: (future ? now : occurred).toISOString(),
  };
}

const DEDUPE_SECONDS = 60, KEEP_PER_PROJECT = 200;
const rowOf = (r: Record<string, unknown>): ClientRenderErrorRecord => ({ id: String(r.error_id), actorId: String(r.actor_id), route: String(r.route), message: String(r.message),
  componentStack: String(r.component_stack), commit: r.commit === null ? null : String(r.commit), occurredAt: new Date(r.occurred_at as string).toISOString(), recordedAt: new Date(r.recorded_at as string).toISOString() });

export function createClientErrorStore(pool: Pool, clock: () => Date = () => new Date()) {
  return {
    /** Stores one record, or returns the one the same actor already stored for the same error in the last minute. */
    async record(projectId: string, actorId: string, input: ClientRenderErrorInput): Promise<{ record: ClientRenderErrorRecord; duplicate: boolean }> {
      const now = clock(), value = sanitizeClientRenderError(input, now);
      const fingerprint = createHash("sha256").update(JSON.stringify([value.route, value.message, value.componentStack, value.commit])).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`client-render-error:${projectId}`]);
        const same = await client.query(`SELECT * FROM client_render_error WHERE project_id=$1 AND actor_id=$2 AND fingerprint=$3 AND recorded_at>$4 ORDER BY recorded_at DESC LIMIT 1`,
          [projectId, actorId, fingerprint, new Date(now.getTime() - DEDUPE_SECONDS * 1000)]);
        if (same.rows[0]) { await client.query("COMMIT"); return { record: rowOf(same.rows[0]), duplicate: true }; }
        const id = randomUUID();
        await client.query(`INSERT INTO client_render_error(project_id,error_id,actor_id,fingerprint,route,message,component_stack,commit,occurred_at,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [projectId, id, actorId, fingerprint, value.route, value.message, value.componentStack, value.commit, value.occurredAt, now]);
        await client.query(`DELETE FROM client_render_error WHERE project_id=$1 AND error_id IN (SELECT error_id FROM client_render_error WHERE project_id=$1 ORDER BY recorded_at DESC, error_id OFFSET $2)`, [projectId, KEEP_PER_PROJECT]);
        await client.query("COMMIT");
        return { record: { id, actorId, ...value, recordedAt: now.toISOString() }, duplicate: false };
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    },
    async list(projectId: string, limit = 20): Promise<ClientRenderErrorRecord[]> {
      const rows = await pool.query(`SELECT * FROM client_render_error WHERE project_id=$1 ORDER BY recorded_at DESC, error_id LIMIT $2`, [projectId, Math.min(Math.max(1, limit), 50)]);
      return rows.rows.map(rowOf);
    },
  };
}
export type ClientErrorStore = ReturnType<typeof createClientErrorStore>;
