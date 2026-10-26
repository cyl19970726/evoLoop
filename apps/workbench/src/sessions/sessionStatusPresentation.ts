import type { ObservedSession } from "@evoloop/contracts/session-observation";

type StatusSource = Pick<ObservedSession, "kind" | "runtimeState" | "busy">;

const lifecycle: Record<string, string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "生命周期待核对", closed: "已关闭",
};

export function sessionLifecycleLabel(session: StatusSource): string {
  if (session.kind === "external") return "外部接入，原会话状态需核对";
  return session.runtimeState ? lifecycle[session.runtimeState] ?? "生命周期状态未识别" : "生命周期未知";
}

export function sessionStatusLabel(session: StatusSource): string {
  if (session.kind === "owned") {
    if (session.runtimeState !== "ready") return sessionLifecycleLabel(session);
    return session.busy === true ? "有在途或未知结果" : session.busy === false ? "空闲" : "活动状态未知";
  }
  return session.busy === true ? "有活动" : session.busy === false ? "空闲" : "状态未知";
}
