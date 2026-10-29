import type { KnowledgeCapabilities } from "@evoloop/contracts/knowledge";

/** A version string is not an availability or fixed-original-read receipt. */
export function knowledgeAvailability(capabilities: KnowledgeCapabilities | null) {
  if (!capabilities) return { fullRead: false, title: "知识读取状态尚未核对", detail: "先核对服务和固定原件能力；已登记关系不代表正文已可读。" };
  if (!capabilities.backendReachable) return { fullRead: false, title: "知识服务暂不可达", detail: "仍可核对已登记的固定引用；无法取得的正文与来源保持未验证。" };
  if (capabilities.fixedRevisionRead !== "adapter_verified") return { fullRead: false, title: "服务可连接，固定正文读取尚未接通", detail: "连接可达不等于已能阅读所选原件，请以具体页面回读为准。" };
  return { fullRead: true, title: "知识正文读取已接通", detail: "按所选固定版本核对正文、适用条件和支持/挑战来源。语义索引仍未验证。" };
}
