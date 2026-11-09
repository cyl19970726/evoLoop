import type { DirectInputCapability, DirectInputCommand, DirectInputReceipt } from "@evoloop/contracts/direct-input";
import { ApiError, request } from "../../shared/api";

function checkedCapability(value: DirectInputCapability): DirectInputCapability {
  if (!value || typeof value.available !== "boolean" ||
    ![null, "steer", "start"].includes(value.mode) ||
    (value.available && !value.mode) || (!value.available && value.mode !== null) ||
    (value.expectedTurnId !== null && typeof value.expectedTurnId !== "string") ||
    (value.mode === "steer" && !value.expectedTurnId) ||
    (value.mode !== "steer" && value.expectedTurnId !== null) ||
    typeof value.reasonCode !== "string" || typeof value.observedAt !== "string")
    throw new ApiError(0, "即时输入能力响应不完整");
  return value;
}

/** Only route parsing, authorization and runtime-support refusals precede every possible input reservation. */
export function explicitlyUnaccepted(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== "object") return false;
  const code = (error.detail as { code?: unknown }).code;
  return (error.status === 400 && code === "INVALID_INPUT") ||
    (error.status === 413 && code === "TOO_LARGE") ||
    (error.status === 403 && code === "FORBIDDEN") ||
    (error.status === 409 && (code === "DIRECT_GRANT_MISSING" || code === "DIRECT_STEER_UNSUPPORTED"));
}

/** UI keeps the original IDs across an unknown response; it never resends automatically. */
export function directInputClient(token:string,projectId:string,sessionId:string){
  const part=encodeURIComponent;
  const base=`/api/projects/${part(projectId)}/sessions/${part(sessionId)}`;
  return {
    capability:(signal?:AbortSignal)=>request<DirectInputCapability>(token,`${base}/direct-input-capability`,15000,{signal}).then(checkedCapability),
    submit:(command:DirectInputCommand,signal?:AbortSignal)=>request<DirectInputReceipt>(token,`${base}/direct-inputs`,30000,
      {method:"POST",body:JSON.stringify(command),signal}),
    read:(inputId:string,signal?:AbortSignal)=>request<DirectInputReceipt>(token,`${base}/direct-inputs/${part(inputId)}`,15000,{signal}),
    reconcile:(inputId:string,signal?:AbortSignal)=>request<DirectInputReceipt>(token,
      `${base}/direct-inputs/${part(inputId)}/reconcile`,30000,{method:"POST",signal}),
    list:(cursor?:string,signal?:AbortSignal)=>request<{items:DirectInputReceipt[];nextCursor:string|null}>(token,
      `${base}/direct-inputs?limit=30${cursor?`&cursor=${part(cursor)}`:""}`,15000,{signal}),
  };
}
