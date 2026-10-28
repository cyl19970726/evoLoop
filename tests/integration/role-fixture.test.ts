import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

// Stable within a test run so a fixture Role can stand in for an old role label.
export function fixtureRoleId(label: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(label)) return label;
  const hex = createHash("sha256").update(`integration role:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function seedFixtureRole(pool: pg.Pool, projectId: string, roleId: string,
  proposal: Record<string, unknown> = {}): Promise<void> {
  const client = await pool.connect();
  const revisionId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,trial_started_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'trial','fixture',now(),now(),now() + interval '30 days')
      ON CONFLICT (project_id,role_id) DO NOTHING`, [projectId, roleId, revisionId]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      SELECT $1,$2,$3,1,'trial',$4::jsonb,'fixture','integration fixture',now(),now() + interval '30 days'
      WHERE EXISTS (SELECT 1 FROM role_definition WHERE project_id=$1 AND role_id=$2 AND current_revision_id=$3)`,
      [projectId, roleId, revisionId, JSON.stringify(proposal)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
