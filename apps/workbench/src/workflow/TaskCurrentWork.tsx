import { useEffect, useState } from "react";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { ArrowUpRight, UserRound } from "lucide-react";
import { runtimeClient } from "../runtime/client";
import { sessionClient } from "../sessions/client";
import { href } from "../ui/shared";
import { assignmentSessionKey, executionSummary } from "./taskExperience";
import { leaderPhaseLabel } from "./leaderWorkLoad";

export function TaskCurrentWork({ item, token, projectId, actorId, returnTo, compact = false }: {
  item: LeaderWorkTask; token: string; projectId: string; actorId: string; returnTo: string; compact?: boolean;
}) {
  const assignedKey = assignmentSessionKey(item);
  const [runner, setRunner] = useState<{ runId: string; revision: string; sessionKey: string; name: string } | null>(null);
  useEffect(() => {
    let active = true; setRunner(null);
    if (!item.latestRun) return () => { active = false; };
    void (async () => {
      const run = await runtimeClient(token, projectId).run(item.latestRun!.runId);
      if (run.id !== item.latestRun!.runId || run.projectId !== projectId || run.taskId !== item.taskId || (run.taskRevisionId !== item.currentRevisionId && run.taskRevisionId !== item.delivery?.taskRevisionId)) return;
      const sessionKey = `owned:${run.sessionId}`;
      const snapshot = await sessionClient(token, projectId).snapshot(sessionKey);
      if (active && snapshot.session.key === sessionKey) setRunner({ runId: run.id, revision: item.currentRevisionId, sessionKey,
        name: snapshot.session.profile?.displayName?.trim() || snapshot.session.title });
    })().catch(() => { /* Run source remains available below; never infer its Session from the Role. */ });
    return () => { active = false; };
  }, [token, projectId, item.taskId, item.currentRevisionId, item.latestRun?.runId, item.delivery?.taskRevisionId]);
  const verifiedRunner = runner?.runId === item.latestRun?.runId && runner?.revision === item.currentRevisionId ? runner : null;
  const key = assignedKey ?? verifiedRunner?.sessionKey ?? null;
  const [session, setSession] = useState<{ key: string; value: ObservedSession } | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let active = true;
    setSession(null); setProblem("");
    if (!key) return () => { active = false; };
    sessionClient(token, projectId).snapshot(key).then(snapshot => {
      if (snapshot.session.key !== key) throw new Error("Session 不匹配");
      if (active) setSession({ key, value: snapshot.session });
    }).catch(() => { if (active) setProblem("会话信息暂未读回；按分派记录保留入口。"); });
    return () => { active = false; };
  }, [token, projectId, key, item.workChangeSequence]);
  const observed = session?.key === key ? session.value : null;
  const name = observed?.profile?.displayName?.trim() || observed?.title || "名称待核对";
  const sessionHref = key ? `${href(projectId, "runtime")}?session=${encodeURIComponent(key)}&tab=overview&actor=${encodeURIComponent(actorId)}&return=${encodeURIComponent(returnTo)}` : null;
  return <section className={`task-current-work${compact ? " compact" : ""}`} aria-label="本任务的承接与执行">
    <div className="current-work-heading"><UserRound size={18} aria-hidden="true" /><h2>具体承接</h2><span className={`leader-phase phase-${item.phase}`}>{leaderPhaseLabel[item.phase]}</span></div>
    <dl className="current-work-facts">
      <div><dt>承接 Session</dt><dd>{sessionHref ? <a href={sessionHref}>{name} <ArrowUpRight size={13} aria-hidden="true" /></a> : ["done", "cancelled"].includes(item.taskState) ? "无当前分派" : "待具体承接"}
        <small>{item.assignment?.state === "accepted" ? "已接受" : item.assignment?.state === "assigned" ? "已分派，仍待接受" : verifiedRunner ? "由本任务当前 Run 确认" : "暂无有效分派"}{item.assignment?.recipientActorId ? ` · ${item.assignment.recipientActorId}` : ""}</small></dd></div>
      <div><dt>执行</dt><dd>{executionSummary(item)}{!compact && observed && <small>Session · {observed.runtimeState ?? "外部状态未知"}（与 Run 分开记录）</small>}</dd></div>
      <div><dt>当前交付</dt><dd>{item.delivery ? `技术检查${item.delivery.technicalResult === "passed" ? "通过" : "失败"}` : "尚无交付"}
        <small>{item.delivery?.observationResult ? `${item.delivery.observationKind === "human" ? "真人" : "Agent"} · ${item.delivery.observationResult === "used" ? "已使用" : item.delivery.observationResult === "failed" ? "使用失败" : "未使用"}` : "尚无本次使用观察"}</small></dd></div>
    </dl>
    {!compact && <><p className="current-work-next"><strong>下一步</strong>{item.nextAction}</p>
      {verifiedRunner && verifiedRunner.sessionKey !== key && <p className="current-work-runner">当前 Run 实际运行于 <a href={`${href(projectId, "runtime")}?session=${encodeURIComponent(verifiedRunner.sessionKey)}&tab=overview`}>{verifiedRunner.name}</a>；与分派目标分别记录。</p>}
      {item.latestRun && <a href={`${href(projectId, "task", item.taskId)}?tab=runtime&run=${encodeURIComponent(item.latestRun.runId)}`}>查看当前 Run 与来源 →</a>}
      {item.queueHold && <p className="task-attention">队列暂不派发：{item.queueHold}</p>}
      <details className="current-work-source"><summary>承接与状态的证据</summary><p>来自当前 Task 工作投影；分派不代表执行，Session 就绪不代表 Run 正在运行。</p>
        <p>固定任务修订 <code>{item.currentRevisionId}</code> · 读于 {new Date(item.dates.observedAt).toLocaleString("zh-CN")}</p>
        {item.assignment && <p>分派目标：{assignedKey ?? "已释放"} · {item.assignment.state}</p>}{item.latestRun && <p>Run {item.latestRun.runId} · {item.latestRun.state}</p>}{problem && <p>{problem}</p>}</details></>}
  </section>;
}
