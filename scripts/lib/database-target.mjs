// Development and test code must never run against the live PostgreSQL server. The test-database NAME is not enough:
// a database called evoloop_x_test is as easy to create on the live server as anywhere else (and was, once). So the
// server is judged by what it hosts: a dedicated development/test server holds only `postgres`, the templates and
// `evoloop_*` databases; one that also holds any other database (the live one is called `evoloop`) is a shared or live
// server and is refused. The one override names the exact server, for a development instance that really does share.
//
//   EVOLOOP_DEV_DATABASE_SERVER=host:port   accept this exact server despite other databases on it
import pg from "pg";

export const testDatabaseName = /^evoloop(?:_[a-z0-9]+)*_test$/;
const developmentDatabase = name => ["postgres", "template0", "template1"].includes(name) || /^evoloop_[a-z0-9_]+$/.test(name);

/** host, port and database of a PostgreSQL URL; a socket URL (`?host=/dir`) keeps the directory as its host. */
export function targetOf(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL");
  const host = (url.hostname || url.searchParams.get("host") || "localhost").toLowerCase();
  const port = url.port || url.searchParams.get("port") || "5432";
  return { host, port, server: `${host}:${port}`, database: decodeURIComponent(url.pathname.slice(1)) };
}

/** Pure decision: is this target a development/test server? `databases` are the names found on the server. */
export function judgeTarget({ url, databases, allowedServer }) {
  const target = targetOf(url);
  if (!testDatabaseName.test(target.database))
    return { ok: false, target, reason: `database "${target.database}" is not a dedicated evoloop_*_test database` };
  const foreign = databases.filter(name => !developmentDatabase(name)).sort();
  if (foreign.length === 0) return { ok: true, target, foreign };
  if (allowedServer && allowedServer.trim().toLowerCase() === target.server) return { ok: true, target, foreign, overridden: true };
  return { ok: false, target, foreign, reason:
    `server ${target.server} also hosts ${foreign.map(name => `"${name}"`).join(", ")}, so it is treated as a live or shared server. ` +
    "Development and tests need their own PostgreSQL instance (own port and data directory) that holds only evoloop_* databases; see docs/development/local-run.md. " +
    `If this really is a development instance, set EVOLOOP_DEV_DATABASE_SERVER=${target.server}` };
}

export async function listDatabases(url) {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try { return (await client.query("SELECT datname FROM pg_database ORDER BY datname")).rows.map(row => row.datname); }
  finally { await client.end(); }
}

const verdicts = new Map();
/** Throws unless `url` is a development/test server; the answer is remembered for the process. */
export async function assertDevelopmentDatabase(url, { env = process.env, list = listDatabases } = {}) {
  const key = `${url}|${env.EVOLOOP_DEV_DATABASE_SERVER ?? ""}`;
  if (!verdicts.has(key)) verdicts.set(key, (async () => {
    // A bad name needs no connection to be refused.
    const early = judgeTarget({ url, databases: [], allowedServer: env.EVOLOOP_DEV_DATABASE_SERVER });
    if (!early.ok) throw new Error(`Refusing to run against ${early.target.server}: ${early.reason}`);
    let databases;
    try { databases = await list(url); }
    catch (error) { throw new Error(`Refusing to run: cannot list the databases on ${early.target.server} to prove it is not the live server (${error?.code ?? error?.message ?? "unknown"})`); }
    const verdict = judgeTarget({ url, databases, allowedServer: env.EVOLOOP_DEV_DATABASE_SERVER });
    if (!verdict.ok) throw new Error(`Refusing to run against ${verdict.target.server}: ${verdict.reason}`);
    return verdict;
  })());
  return verdicts.get(key);
}
