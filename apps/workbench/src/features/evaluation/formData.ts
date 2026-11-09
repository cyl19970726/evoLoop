import type { EvaluationDefinition, EvaluationSourceSignature } from "@evoloop/contracts";
import { parseFixedRefLines } from "./presentation";

export function definitionFromForm(values: Record<string, string>, source: { taskId: string; sourceTaskRevisionId: string; sourceSignature: EvaluationSourceSignature }, current?: EvaluationDefinition, newId: () => string = () => crypto.randomUUID()): EvaluationDefinition {
  const protocol = parseFixedRefLines(values.protocol ?? "", ["document", "git"]);
  const materials = parseFixedRefLines(values.materials ?? "", ["document", "git"]);
  const wikiRefs = parseFixedRefLines(values.wiki ?? "", ["wiki"]);
  if (protocol.length !== 1 || !materials.length || !wikiRefs.length) throw new Error("需一项协议、至少一项共同材料及一项固定 Wiki。");
  if ((values.sandbox && values.sandbox !== "danger-full-access") ||
    (values.approvalPolicy && values.approvalPolicy !== "never"))
    throw new Error("新定义只能使用统一完整执行权限");
  const environment: EvaluationDefinition["conditions"][0]["environment"] = { cwd: values.cwd, authorizationScope: values.authorizationScope,
    sandbox: "danger-full-access", approvalPolicy: "never" };
  return { ownerTaskId: values.ownerTaskId, question: values.question, protocol: protocol[0]!,
    case: { id: current?.case.id ?? newId(), taskId: source.taskId,
      sourceTaskRevisionId: source.sourceTaskRevisionId, sourceSignature: source.sourceSignature,
      commonInput: values.commonInput, materials, criteria: values.criteria },
    conditions: [
      { id: current?.conditions[0].id ?? newId(), kind: "direct", wikiRefs: null, model: values.model, environment },
      { id: current?.conditions[1].id ?? newId(), kind: "wiki", wikiRefs, model: values.model, environment },
    ], limits: values.limits };
}
