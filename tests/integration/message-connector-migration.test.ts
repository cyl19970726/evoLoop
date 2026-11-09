import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import test from "node:test";
import pg from "pg";
import {runner} from "node-pg-migrate";
import {migrate} from "@evoloop/adapter-postgres";

const database=process.env.TEST_DATABASE_URL;
if(!database||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("Connector migration tests require a dedicated evoloop_*_test database");
const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
const files=readdirSync(migrations).filter(name=>name.endsWith(".mjs")).sort();
const through=(name:string)=>files.indexOf(name)+1;

async function applyTo(schema:string,count:number){
  await runner({databaseUrl:database!,dir:migrations,direction:"up",migrationsTable:"pgmigrations",
    schema,count,createSchema:true,createMigrationsSchema:true,singleTransaction:true,log:()=>{}});
}

test("released 058 and 062 schemas upgrade to the additive Connector head",async t=>{
  for(const baseline of ["058_session_compaction.mjs","062_acceptance_relay.mjs"]){
    await t.test(baseline,async t=>{
      const schema=`connector_upgrade_${randomUUID().replaceAll("-","").slice(0,12)}`;
      t.after(async()=>{
        const cleanup=new pg.Client({connectionString:database});
        await cleanup.connect();
        try{await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await cleanup.end();}
      });
      const baselineIndex=through(baseline);
      assert.ok(baselineIndex>0,`${baseline} must exist`);
      await applyTo(schema,baselineIndex);
      const client=new pg.Client({connectionString:database,options:`-c search_path=${schema}`});
      await client.connect();
      t.after(()=>client.end());
      const projectId=randomUUID();
      await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'preserved',$2)",
        [projectId,new Date().toISOString()]);
      await migrate(database!,schema);
      assert.equal((await client.query("SELECT title FROM project WHERE project_id=$1",[projectId])).rows[0]?.title,
        "preserved");
      const connectorMigrations=(await client.query(`SELECT name FROM pgmigrations
        WHERE name LIKE '063_%' OR name LIKE '064_%' OR name LIKE '065_%' OR name LIKE '066_%'
        ORDER BY name`)).rows.map(row=>row.name);
      assert.deepEqual(connectorMigrations,[
        "063_message_connectors",
        "064_message_connector_links",
        "065_message_connector_standard",
        "066_connector_delivery_decision",
      ]);
      const tables=(await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=$1 AND table_name IN ('connector_route','connector_message_link',
          'connector_unhandled_event','connector_delivery_decision','connector_transport_attempt',
          'connector_claim_attempt')
        ORDER BY table_name`,[schema])).rows.map(row=>row.table_name);
      assert.deepEqual(tables,[
        "connector_claim_attempt",
        "connector_delivery_decision",
        "connector_message_link",
        "connector_route",
        "connector_transport_attempt",
        "connector_unhandled_event",
      ]);
    });
  }
});

test("a failed 064 rolls the whole Connector upgrade back, then a corrected rerun reaches 066",async t=>{
  const schema=`connector_failure_${randomUUID().replaceAll("-","").slice(0,12)}`;
  t.after(async()=>{
    const cleanup=new pg.Client({connectionString:database});
    await cleanup.connect();
    try{await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await cleanup.end();}
  });
  await applyTo(schema,through("062_acceptance_relay.mjs"));
  const client=new pg.Client({connectionString:database,options:`-c search_path=${schema}`});
  await client.connect();
  t.after(()=>client.end());
  const projectId=randomUUID();
  await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'survives failure',$2)",
    [projectId,new Date().toISOString()]);
  await client.query("CREATE TABLE connector_unhandled_event(dummy integer)");
  await assert.rejects(migrate(database!,schema));
  assert.equal((await client.query("SELECT title FROM project WHERE project_id=$1",[projectId])).rows[0]?.title,
    "survives failure");
  assert.equal((await client.query("SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1")).rows[0]?.name,
    "062_acceptance_relay");
  assert.equal((await client.query("SELECT to_regclass('connector_route')")).rows[0]?.to_regclass,null);
  await client.query("DROP TABLE connector_unhandled_event");
  await migrate(database!,schema);
  // Later migrations may follow 066; the corrected rerun must have applied it.
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='066_connector_delivery_decision'")).rows[0]?.n,1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name LIKE '063_%' OR name LIKE '064_%' OR name LIKE '065_%' OR name LIKE '066_%'")).rows[0]?.n,4);
});
