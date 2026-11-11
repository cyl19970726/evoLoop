// A queued message blocked for want of its sender's message grant must not hold the Session's line; any other
// block (transient: waiting for a Task turn, a busy Session) still keeps first-in-first-out order.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session message grant tests require a dedicated evoloop test database");
const schema = `el_msg_grant_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const projectId = randomUUID(), roleId = randomUUID();
const grantBlock = "MESSAGE_GRANT_MISSING: 没有发送这条消息的授权：没有 user-sim → 这个 Session 的授权。";

async function session(): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/msg-grant','project','danger-full-access','never','ready',1,$4,$5,$6,'leader',now(),now())`, [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
  return sessionId;
}
let tick = 0;
async function message(sessionId: string, sender: string, blockedReason: string | null, state = "queued"): Promise<string> {
  const messageId = randomUUID();
  // Strictly increasing creation times keep the order of the test explicit.
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,blocked_reason,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,$5,'hello',$6,$7,1,now() + ($8 || ' seconds')::interval,now())`, [projectId, messageId, randomUUID(), sessionId, sender, state, blockedReason, String(++tick)]);
  return messageId;
}
const pending = async () => (await uow.read(projectId, async reader => reader.sessionMessages!.listPendingSessionMessages(50, 0))).map(item => item.id);

before(async () => {
  await migrate(url!, schema);
  await pool.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Message grant',now())`, [projectId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',now(),now() + interval '30 days')`, [projectId, roleId, revision]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',now(),now() + interval '30 days')`, [projectId, roleId, revision]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("a message blocked for a missing grant at the head does not hold the messages behind it, which are all still handled", async () => {
  const target = await session();
  const blocked = await message(target, "user-sim", grantBlock);
  const behind = [];
  for (let n = 0; n < 8; n++) behind.push(await message(target, "leader-notice", null));
  const eligible = await pending();
  // The blocked message stays queued and visible; the next in line is handled; the rest follow it in order, one at a time.
  assert.ok(eligible.includes(behind[0]!), "the first message behind the blocked head is now eligible");
  assert.ok(eligible.includes(blocked), "the blocked message is still in the queue, not dropped");
  assert.equal(eligible.includes(behind[1]!), false, "only the next in line, as before: first in, first out among the rest");
  assert.equal((await pool.query(`SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, blocked])).rows[0].state, "queued");
  // Handle the first; the next becomes eligible, and so on to the last of the eight.
  for (let n = 0; n < behind.length; n++) {
    assert.ok((await pending()).includes(behind[n]!), `message ${n + 1} behind the blocked head is eligible in its turn`);
    await pool.query(`UPDATE session_message SET state='cancelled',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2`, [projectId, behind[n]!]);
  }
});

test("any other block keeps the line, and an unblocked head still goes first", async () => {
  const transient = await session();
  const head = await message(transient, "someone", "Waiting for one ready Task turn after the previous ordinary message");
  const next = await message(transient, "someone-else", null);
  const eligible = await pending();
  assert.ok(eligible.includes(head));
  assert.equal(eligible.includes(next), false, "a transient block still holds first-in-first-out order");

  const plain = await session();
  const first = await message(plain, "a", null), second = await message(plain, "b", null);
  const plainEligible = await pending();
  assert.ok(plainEligible.includes(first) && !plainEligible.includes(second), "ordinary order is unchanged");

  // Two grant-blocked heads: neither holds the line, and the unblocked message behind them goes first in the list.
  const both = await session();
  const a = await message(both, "x", grantBlock), b = await message(both, "y", grantBlock), c = await message(both, "z", null);
  const order = (await pending()).filter(id => [a, b, c].includes(id));
  assert.deepEqual(order, [c, a, b], "unblocked first, then the grant-blocked ones in their saved order");
});
