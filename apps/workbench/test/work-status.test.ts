import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "@evoloop/contracts";
import { businessNextStep, cognitionSummary, partitionWorkTasks, visibleWorkGroups, type WorkTaskStatus } from "../src/workflow/workStatusPresentation.ts";

const task={id:"task",kind:"research",state:"in_progress"} as Task;
const base:WorkTaskStatus={taskId:"task",cognition:true,dispatchId:"dispatch",dispatchState:"accepted",outcome:null,
  runId:"run",runState:"running",unsettledRunState:null,loopState:"active",goalOutcome:"交付一份可核对报告",stageDeliverable:"固定报告",
  sourceKind:"loop.enrolled",sourceTaskId:null,sourceTaskTitle:null,decisionKind:null,decisionReason:null,
  useRequired:null,deliveryId:null,technicalResult:null,observationResult:null,observerKind:null,
  hasClosure:false,readyForAcceptance:false};

test("cognition label follows formal source and a terminal signed decision, not Task kind or title",()=>{
  assert.match(cognitionSummary(base).title,/首次规划 · 交付一份可核对报告/);
  assert.equal(cognitionSummary(base).phase,"本轮执行中");
  const signed={...base,sourceKind:"dispatch.gap",sourceTaskTitle:"上轮判断",decisionKind:"stop",
    decisionReason:"证据已充分",runState:"completed",outcome:null};
  assert.match(cognitionSummary(signed).title,/运行缺少署名结果后的恢复 · 上轮判断/);
  assert.equal(cognitionSummary(signed).phase,"已署名判定 · 待收束");
  assert.equal(cognitionSummary({...signed,outcome:"no_action",loopState:"stopped"}).phase,"本轮已停止");
  assert.equal(cognitionSummary({...signed,decisionKind:"waiting",outcome:"waiting"}).phase,"本轮判断已结束 · 等待");
  assert.equal(cognitionSummary({...base,runState:"completed"}).phase,"运行已结束 · 缺署名结果");
  assert.equal(cognitionSummary({...base,runState:"unknown"}).phase,"运行或派发结果未知");
  assert.equal(cognitionSummary({...base,dispatchState:"unknown"}).phase,"运行或派发结果未知");
});

test("business acceptance hint requires the exact current delivery and declared-consumer use fact",()=>{
  const ready={...base,cognition:false,runState:"completed"};
  assert.equal(businessNextStep(task,{...ready,deliveryId:"delivery",readyForAcceptance:true}),
    "当前交付已通过技术检查且声明消费者已记录使用；待负责人核对验收条件");
  assert.match(businessNextStep(task,{...ready,deliveryId:"delivery",readyForAcceptance:false})!,/尚未确认验收/);
  assert.doesNotMatch(businessNextStep(task,{...ready,deliveryId:"delivery",readyForAcceptance:false})!,/待负责人核对验收条件/);
  assert.match(businessNextStep({...task,state:"done"},{...base,cognition:false,hasClosure:true})!,/已登记验收/);
  for (const state of ["requested","dispatching","running","unknown"]) {
    const result=businessNextStep(task,{...ready,deliveryId:"old-delivery",readyForAcceptance:true,
      runState:"completed",unsettledRunState:state})!;
    assert.doesNotMatch(result,/待负责人核对验收条件|查看最新交付/);
    assert.match(result,state === "unknown" ? /结果未知/ : /运行在途/);
  }
});

test("only a formal cognition projection is folded; ordinary research and missing facts remain visible",()=>{
  const cognition={...task,id:"cognition",title:"Cognition: event"};
  const research={...task,id:"research",title:"Research report"};
  const unknown={...task,id:"unknown",title:"Unclassified"};
  const groups=partitionWorkTasks([cognition,research,unknown],{
    cognition:{...base,taskId:"cognition"},research:{...base,taskId:"research",cognition:false}});
  assert.deepEqual(groups.business.map(item=>item.id),["research"]);
  assert.deepEqual(groups.cognition.map(item=>item.id),["cognition"]);
  assert.deepEqual(groups.unknown.map(item=>item.id),["unknown"]);
});

test("the work list keeps loaded tasks in its primary view when status classification is unavailable",()=>{
  const tasks=[{...task,id:"business",title:"Deliver report"},{...task,id:"system",title:"Event record"}];
  const unavailable=visibleWorkGroups(tasks,{},true);
  assert.equal(unavailable.primaryKind,"unclassified");
  assert.deepEqual(unavailable.primary.map(item=>item.id),["business","system"]);
  assert.deepEqual(unavailable.cognition,[]);
  assert.deepEqual(unavailable.unknown,[]);
});

test("complete status classification keeps only business tasks in the primary view",()=>{
  const tasks=[{...task,id:"business"},{...task,id:"system"}];
  const complete=visibleWorkGroups(tasks,{
    business:{...base,taskId:"business",cognition:false},
    system:{...base,taskId:"system"},
  },false);
  assert.equal(complete.primaryKind,"business");
  assert.deepEqual(complete.primary.map(item=>item.id),["business"]);
  assert.deepEqual(complete.cognition.map(item=>item.id),["system"]);
  assert.deepEqual(complete.unknown,[]);
});

test("partial work status keeps missing tasks visible without folding them with formal cognition records",()=>{
  const tasks=[{...task,id:"business"},{...task,id:"system"},{...task,id:"missing"}];
  const partial=visibleWorkGroups(tasks,{
    business:{...base,taskId:"business",cognition:false},
    system:{...base,taskId:"system"},
  },false);
  assert.equal(partial.primaryKind,"business");
  assert.deepEqual(partial.primary.map(item=>item.id),["business"]);
  assert.deepEqual(partial.cognition.map(item=>item.id),["system"]);
  assert.deepEqual(partial.unknown.map(item=>item.id),["missing"]);
});
