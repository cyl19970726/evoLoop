import { createHash } from "node:crypto";
import type { Principal, ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";

const terminal=new Set(["completed","failed","interrupted"]);
export function queueIntentId(...parts:string[]):string {
  const h=createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export class ResidentQueuePump {
  private timer:ReturnType<typeof setInterval>|null=null;
  private busy:Promise<void>|null=null;
  constructor(private readonly deps:{workflow:WorkflowService;credentials():Promise<Principal[]>;
    enabled():Promise<boolean>;canWrite():boolean;pollIntervalMs:number;onError(error:unknown):void;
    messageBusy?(projectId:string,sessionId:string):Promise<boolean>}){}
  start():void {
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.tick();},this.deps.pollIntervalMs);
    this.timer.unref();void this.tick();
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void> {
    if(this.busy)return this.busy;
    this.busy=this.scan().catch(this.deps.onError).finally(()=>{this.busy=null;});
    return this.busy;
  }
  private async scan():Promise<void> {
    if(!this.deps.canWrite()||!await this.deps.enabled())return;
    const credentials=await this.deps.credentials();
    const projects=new Set(credentials.flatMap(p=>p.projectIds));
    for(const projectId of projects){
      const reader=credentials.find(p=>p.projectIds.includes(projectId)&&p.permissions.includes("read"));
      if(!reader)continue;
      const queues=await this.deps.workflow.listResidentQueues(reader,projectId);
      for(const queue of queues)if(queue.adoptedVersion===queue.version){
        const lead=credentials.find(p=>p.actorId===queue.actorId&&p.projectIds.includes(projectId)&&
          ["read","write","review"].every(permission=>p.permissions.includes(permission as "read"|"write"|"review")));
        if(lead)await this.advance(queue,lead);
      }
    }
  }
  private async advance(queue:ResidentQueue,lead:Principal):Promise<void> {
    const entries=[...queue.entries].sort((a,b)=>a.position-b.position);
    for(const entry of entries){
      if(entry.state==="claimed"&&entry.claimId&&!entry.holdCode)await this.releaseIfAccepted(queue,entry,lead);
      if(entry.state!=="queued")continue;
      if(await this.deps.messageBusy?.(queue.projectId,entry.sessionId))continue;
      if(entry.dependsOn.some(id=>entries.find(x=>x.id===id)?.state!=="released"))continue;
      if(entries.some(prior=>prior.position<entry.position&&prior.sessionId===entry.sessionId&&prior.state!=="released"))continue;
      // A Lead unhold increments the entry version, making one fresh intent possible
      // without retrying a previously journalled held result or churning while idle.
      const generation=[queue.projectId,queue.id,entry.id,String(queue.adoptedVersion),String(entry.version)];
      const claimId=queueIntentId("claim",...generation);
      const runId=queueIntentId("run",...generation,"1");
      const operationId=queueIntentId("run.reserve",...generation,"1");
      let result;
      try{result=await this.deps.workflow.execute(lead,{type:"queue.claim",projectId:queue.projectId,
        queueId:queue.id,entryId:entry.id,expectedVersion:queue.version,claimId,runId,
        runOperationId:operationId,operationId});}
      catch(error){if(error instanceof Error&&error.message==='SESSION_MESSAGE_BUSY')return;throw error;}
      if(result.status==="rejected"&&!["QUEUE_NOT_ADOPTED","VERSION_CONFLICT","ENTRY_UNAVAILABLE"].includes(result.code))
        this.deps.onError(new Error(`queue claim ${result.code}`));
      // The next item must observe the committed claim on a fresh queue read.
      return;
    }
  }
  private async releaseIfAccepted(queue:ResidentQueue,entry:ResidentQueueEntry,lead:Principal):Promise<void> {
    const attempts=await this.deps.workflow.listResidentQueueAttempts(lead,queue.projectId,entry.claimId!);
    const last=attempts.at(-1);if(!last)return;
    const run=await this.deps.workflow.getRuntimeRun(lead,queue.projectId,last.runId);
    if(!terminal.has(run.state))return;
    const detail=await this.deps.workflow.getTask(lead,queue.projectId,entry.taskId);
    const task=detail.task;if(task.state!=="done")return;
    const latest=[...(detail.deliveries??[])].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1);
    if(!latest||latest.runId!==last.runId||latest.technicalResult!=="passed")return;
    const closure=[...(detail.closures??[])].filter(x=>x.taskRevisionId===task.currentRevisionId&&
      x.acceptanceResult==="met"&&x.deliveryId===latest.id)
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1);
    if(!closure)return;
    if(entry.useRequired){
      const observation=[...(detail.observations??[])].filter(x=>x.deliveryId===latest.id&&x.observer===entry.consumerId)
        .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1);
      if(observation?.result!=="used")return;
    }
    const operationId=queueIntentId("release",queue.projectId,queue.id,entry.id,last.runId,closure.id);
    const result=await this.deps.workflow.execute(lead,{type:"queue.release",projectId:queue.projectId,
      queueId:queue.id,entryId:entry.id,claimId:entry.claimId!,operationId});
    if(result.status==="rejected")this.deps.onError(new Error(`queue release ${result.code}`));
  }
}
