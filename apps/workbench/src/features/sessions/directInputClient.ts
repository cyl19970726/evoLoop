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

/**
 * Refusals the service raises before it reserves anything: the input has no record, the text is still in the box, and the
 * person may choose insert or queue again. A 5xx or a lost answer is not here: that outcome is unknown.
 */
const beforeReservation = new Set([
  "DIRECT_GRANT_MISSING", "SESSION_NOT_READY", "SESSION_BUSY", "SOURCE_AMBIGUOUS", "TURN_CHANGED", "MESSAGE_BUDGET_EXHAUSTED",
  "NATIVE_ADMISSION_MISSING", "NATIVE_UNAVAILABLE", "NATIVE_CAPABILITY_UNKNOWN", "DIRECT_RUNTIME_UNAVAILABLE",
]);
export function explicitlyUnaccepted(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== "object") return false;
  const code = (error.detail as { code?: unknown }).code;
  return (error.status === 400 && code === "INVALID_INPUT") ||
    (error.status === 413 && code === "TOO_LARGE") ||
    (error.status === 403 && code === "FORBIDDEN") ||
    (error.status >= 400 && error.status < 500 && typeof code === "string" && beforeReservation.has(code)) ||
    (error.status === 503 && (code === "NATIVE_UNAVAILABLE" || code === "DIRECT_RUNTIME_UNAVAILABLE"));
}

/** A local per-Session admission conflict: nothing was reserved, so retrying the same draft is safe. */
export function retryableInputBusy(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.detail !== null &&
    typeof error.detail === "object" && (error.detail as { code?: unknown }).code === "SESSION_INPUT_BUSY";
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
