import type { Pool } from 'pg';
import type { RuntimeSessionRecord } from '@evoloop/contracts/runtime';
import { selectMaterialCli, type loadIntegrations } from '../configuration.js';

type Configuration=Awaited<ReturnType<typeof loadIntegrations>>;

/** The Session requester and the business recipient are separate identities. */
export async function currentConnectorBusinessActor(session:RuntimeSessionRecord,actorId:string,
  current:Configuration,pool:Pick<Pool,'query'>,
  projectWriter:(projectId:string,actorId:string)=>Promise<boolean>):Promise<boolean>{
  if(!await projectWriter(session.projectId,actorId))return false;
  const resident=current.residentQueue?.enabled ? current.residentQueue.roleActors.find(value=>
    value.projectId===session.projectId&&value.roleId===session.roleId)?.actorId : undefined;
  const cli=current.runtime?.enabled ? selectMaterialCli(current.runtime.materialCli,
    session.projectId,session.id,session.actorId,undefined,session.roleId)?.cliActorId : undefined;
  if((resident&&resident!==actorId)||(cli&&cli!==actorId)||(!resident&&!cli))return false;
  const binding=await pool.query(`SELECT 1 FROM role_session_binding b JOIN role_definition r
    ON r.project_id=b.project_id AND r.role_id=b.role_id
    WHERE b.project_id=$1 AND b.session_id=$2 AND b.role_id=$3 AND r.state IN ('trial','active') LIMIT 1`,
    [session.projectId,session.id,session.roleId]);
  return binding.rows.length>0;
}
