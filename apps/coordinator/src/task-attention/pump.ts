import type { Pool } from "pg";
import { PgTaskAttention, scanTaskAttentionCandidates } from "@evoloop/adapter-postgres";
import { readLeaderWorkTask } from "@evoloop/adapter-postgres/work-index";
import { assessTaskAttention, trialAttentionThreshold } from "@evoloop/core";

export class TaskAttentionPump {
  private timer:ReturnType<typeof setInterval>|null=null;
  private busy:Promise<void>|null=null;
  private cursors=new Map<string,string>();
  constructor(private readonly deps:{pool:Pool;projects:()=>Promise<string[]>;canWrite:()=>boolean;
    now:()=>string;onError:(error:unknown)=>void;pollIntervalMs:number;pageSize?:number}){}
  start():void{
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.tick();},this.deps.pollIntervalMs);
    this.timer.unref();void this.tick();
  }
  stop():void{if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void>{
    if(this.busy)return this.busy;
    this.busy=this.cycle().catch(this.deps.onError).finally(()=>{this.busy=null;});
    return this.busy;
  }
  private async cycle():Promise<void>{
    if(!this.deps.canWrite())return;
    for(const projectId of new Set(await this.deps.projects())){
      if(!this.deps.canWrite())return;
      const limit=Math.min(50,Math.max(1,this.deps.pageSize??25));
      let cursor=this.cursors.get(projectId)??null;
      let page=await scanTaskAttentionCandidates(this.deps.pool,projectId,cursor,limit);
      if(!page.length&&cursor){cursor=null;page=await scanTaskAttentionCandidates(this.deps.pool,projectId,null,limit);}
      for(const taskId of page){
        if(!this.deps.canWrite())return;
        try{await this.evaluateOne(projectId,taskId);}
        catch(error){this.deps.onError(error);}
      }
      const last=page.at(-1);
      if(last)this.cursors.set(projectId,last);else this.cursors.delete(projectId);
    }
  }
  private async evaluateOne(projectId:string,taskId:string):Promise<void>{
    const client=await this.deps.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
      await client.query("SELECT task_id FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",[projectId,taskId]);
      const now=this.deps.now();
      const task=await readLeaderWorkTask(client,projectId,taskId,now);
      if(task){
        const store=new PgTaskAttention(client,projectId);
        const configured=await store.effectiveThreshold(task.stage?.stageId??null,task.timing.current.stage);
        const followUp=await store.getFollowUp(taskId);
        const assessed=assessTaskAttention(task,configured??trialAttentionThreshold(task.timing.current.stage),now,followUp);
        await store.recordAssessment(task,assessed,now,followUp);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
