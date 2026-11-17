// Behind the Hub (#219): what the page says about where a project runs. Offline is a fact about the link to the machine; it is never worded as a failed Run.
export interface HubMachineFact { name: string; online: boolean; state: string }

export function machineText(machine: HubMachineFact | null | undefined): string {
  if (!machine) return "未登记机器";
  if (machine.state === "removed") return `机器 ${machine.name} 已移除`;
  return `机器 ${machine.name} · ${machine.online ? "在线" : "离线"}`;
}

/** The notice over a project whose machine is not connected: said once, with what it does and does not mean. Null when nothing needs saying. */
export function hubOfflineNotice(machine: HubMachineFact | null | undefined): { key: string; tone: "waiting"; text: string; detail: string } | null {
  if (!machine || machine.online) return null;
  const removed = machine.state === "removed";
  return { key: "machine-offline", tone: "waiting",
    text: removed ? `这个项目所在的机器 ${machine.name} 已从 Hub 移除，项目内容暂时不能读写。` : `这个项目所在的机器 ${machine.name} 现在离线，项目内容暂时不能读写。`,
    detail: "离线只说明 Hub 现在连不上这台机器，不代表运行失败：机器上正在跑的运行、已有的交付和它们的状态都没有被改动。机器重新连上后会自动恢复。" };
}
