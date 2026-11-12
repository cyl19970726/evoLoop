import { z } from 'zod';

const id=z.uuid(), text=z.string().trim().min(1).max(4000), version=z.number().int().positive();
export const providerSchema=z.enum(['codex','claude']);
/** Failure categories that mean the account, not the work, is the problem: every Session of the provider would fail the same way. */
export const providerHoldCategories=['quota_exhausted','authentication_failed'] as const;
export const holdsProvider=(category:string|null|undefined):boolean=>
  !!category&&(providerHoldCategories as readonly string[]).includes(category);

export const providerHoldCommands=[
  /** One decision frees the provider and resumes every Session whose gate was closed by the hold's quota/auth failure. */
  z.strictObject({projectId:id,operationId:id,type:z.literal('runtime.providerHold.release'),
    provider:providerSchema,holdId:id,expectedVersion:version,evidenceRef:text,reason:text}),
];
export type ProviderHoldCommand=z.infer<typeof providerHoldCommands[number]>;

export interface ProviderHold {
  projectId:string;id:string;provider:'codex'|'claude';state:'held'|'released';category:string;
  causeSessionId:string|null;causeMessageId:string|null;reason:string;version:number;openedAt:string;
  releasedAt:string|null;releasedBy:string|null;releaseReason:string|null;
  /** Sessions resumed by the release and those it could not resume, with the refusal code. */
  releaseSummary:{resumed:string[];skipped:{sessionId:string;code:string}[]}|null;
}
export interface ProviderHoldImpact {
  sessionId:string;gatePhase:string|null;blockedByQuotaFailure:boolean;queuedMessages:number;
}
export interface ProviderHoldView extends ProviderHold {
  /** Live for a held provider; empty once released. */
  impact:ProviderHoldImpact[];
  queuedMessages:number;
}
export interface ProviderHoldListing { items:ProviderHoldView[]; observedAtUtc:string }
export const providerHeldMessage=(provider:string,category:string)=>
  `模型服务${provider}的${category==='authentication_failed'?'鉴权失败':'额度不足'}，已暂停该提供方的新 Turn；新消息照常保存排队。由账户使用者处理后，在“运行受阻”处一次放行。`;
