import type { DirectInputCapability, DirectInputCommand, DirectInputReceipt } from "@evoloop/contracts/direct-input";
import { request } from "../api";

/** UI keeps the original IDs across an unknown response; it never resends automatically. */
export function directInputClient(token:string,projectId:string,sessionId:string){
  const part=encodeURIComponent;
  const base=`/api/projects/${part(projectId)}/sessions/${part(sessionId)}`;
  return {
    capability:(signal?:AbortSignal)=>request<DirectInputCapability>(token,`${base}/direct-input-capability`,15000,{signal}),
    submit:(command:DirectInputCommand,signal?:AbortSignal)=>request<DirectInputReceipt>(token,`${base}/direct-inputs`,30000,
      {method:"POST",body:JSON.stringify(command),signal}),
    read:(inputId:string,signal?:AbortSignal)=>request<DirectInputReceipt>(token,`${base}/direct-inputs/${part(inputId)}`,15000,{signal}),
    reconcile:(inputId:string,signal?:AbortSignal)=>request<DirectInputReceipt>(token,
      `${base}/direct-inputs/${part(inputId)}/reconcile`,30000,{method:"POST",signal}),
    list:(cursor?:string,signal?:AbortSignal)=>request<{items:DirectInputReceipt[];nextCursor:string|null}>(token,
      `${base}/direct-inputs?limit=30${cursor?`&cursor=${part(cursor)}`:""}`,15000,{signal}),
  };
}
