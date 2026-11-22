// The acceptance-capability gaps the service lists as codes (apps/coordinator/src/acceptance-relay/capability.ts), in words. The code itself stays in
// the row's 来源与完整标识; a code this page does not know is said as such, with its code, never dropped.
const words: Record<string, string> = {
  MESSAGE_GRANT_MISSING: "没有给验收者发消息的授权", SESSION_NOT_READY: "会话还没就绪", SESSION_READBACK_FAILED: "会话状态没读回",
  SENDER_IDENTITY_UNAVAILABLE: "发送方身份不可用", RECEIVER_IDENTITY_UNAVAILABLE: "接收方身份不可用", RECIPIENT_BINDING_MISSING: "没有绑定接收方身份",
};
export const capabilityGapText = (code: string): string => words[code] ?? `未收录的缺项（${code}）`;
