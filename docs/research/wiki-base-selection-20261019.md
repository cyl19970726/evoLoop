# 认知 Wiki 基座：代码复用与改造选择

状态：2026-10-19，**研究建议，尚未正式采用、fork 或部署**。本轮按“愿意修改上游代码”的新前提重新判断，依据固定版本源码和[已完成的有限实验](../references/validation-summary.md)，没有新增模型运行或生产测试。比较版本为 OpenViking 0.5.0（`20f9c113`）与 nashsu/llm_wiki v0.6.12（`48fd970e`）。

## 建议与依据

**建议优先用 OpenViking 作为外置知识服务基座，由 evoLoop 实现与项目工作相连的认知维护流程。** nashsu 的来源驱动整理、目的/结构约束、Review 和人类阅读体验值得参考；如选择复用代码，按模块评估依赖和许可证，不同时维护两个完整的知识权威。

这个建议并不来自“OpenViking 更会思考”的判断。我们还没有足够实验支持这种结论。它来自系统形态：evoLoop 要让不同 session 和运行时持续读写独立知识空间，既服务当前文档工作，也服务将来的产品、架构、规范和运维任务。OpenViking 已把摄入、内容、检索与会话数据作为服务暴露；nashsu 当前完整摄入与维护链依赖桌面应用和前端状态。前者更接近所需的可替换服务边界，后者更接近现成的个人 Wiki 工作台。

两者确实重叠：都尝试把分散材料转为可持久化、可检索、可复用的知识。差别不宜概括成“一个只有检索，另一个才有 Wiki”——OpenViking 0.5.0 也有真实 Wiki 编译。我们应比较**已经可以复用什么、还要自己维护什么**。

| evoLoop 要完成的工作 | OpenViking 可复用与代价 | nashsu 可复用与代价 |
| --- | --- | --- |
| 多个现有 session 访问一个外置知识服务 | 可用 REST/MCP/SDK 读写资料和页面；外部历史仍需主动适配导入 | 有真实 HTTP/MCP 写页；服务随桌面进程运行，不能直接等同独立后台编译服务 |
| 材料进入持续更新的 Wiki | 原生 compile + 官方 Wiki Skill；复用 compile 需要 Agent Runtime | 双阶段摄入、页面合并、来源字段与 Review 已有；主要处理链在前端 TS 中连接桌面文件调用、状态和模型客户端 |
| 人类阅读、追源、审阅与整理 | 有 Studio 等入口；完整认知维护体验仍需围绕实际任务补齐 | 独立 Markdown vault、图谱、阅读与 Review 更直接，保留桌面形态时复用价值很高 |
| 纠正传播、来源变化与安全发布 | 固定版不足；需来源修订、依赖复核、发布约束 | 同样不足；页级 sources、Review、文件历史并不等于逐主张修订与并发保护 |
| 长期维护的工程负担 | Python 服务、Rust 存储、索引、模型与后台任务；改核心写协议会增加跟随上游成本 | 保留桌面可少改；抽成 headless 需分离文件、模型、配置、审阅、队列和 watcher 的依赖 |

服务能力依据：[OpenViking 内容 API][ov-content]、[编译派发][ov-compile]、[nashsu 摄入依赖][n-ingest]、[文件事件衔接][n-sync]、[MCP 写页][n-mcp]。表中改造代价是源码结构推断，尚未通过实际重构衡量工时。

## “认知”部分仍需怎样构建

我们需要的不只是把文章放进库再搜出来。对项目有价值的知识，应解释：当时目标是什么、采取了什么行动、产物怎样被实际使用、用户如何评价、这改变了什么判断、下一步为什么值得做。用户纠正或来源改变时，还要能找到并复核受影响的旧结论。

第一版建议复用存储和检索，在其外建立有限的维护协议，而不是先造完整知识平台：

1. 各 session 提交带来源、事件时间、观察版本的材料与候选认识，明确事实、解释、假设、决定和争议。
2. 专门 Wiki session 按主题读新材料与既有页，维护当前判断、反例、适用条件和被取代关系。它能提出任务和角色建议，仍由职责所在 session 完成实际工作。
3. 发布时记录读入基线、候选差异、来源修订和发布结果。初期只允许一个发布者；来源变化进入待复核流程。若允许旁路写入，串行维护就不能被宣称为强保护。
4. 下一 session 读取明确修订，完成阶段任务并实际使用产物。把漏用纠正、使用失败和新的反馈带回维护链；飞书继续是任务权威。

这些要求落实到[知识与协作接口](../architecture/contracts.md)，知识正文和修订保存在开发 repo 外。它们是待实现的流程，不是两个候选现有能力的重新命名。**本次对两者都没有证实持久的逐主张 evidence/claim 账本。** OpenViking 的编译来源约束主要在 Skill 和页级结果；nashsu 的页级 `sources[]` 与 Review 也不提供这一保证。[Wiki Skill][ov-skill] · [编译结果渲染][ov-renderer] · [来源删除流程][n-lifecycle]

## 怎样复用代码，避免过早接手整套上游

**先通过适配器复用 OpenViking 服务，必要时才做范围明确的 fork。** 当前 Codex/Claude 等 session 可以通过内容接口维护 Wiki，不必因为选存储就换掉所有 Agent 运行时。若复用上游 `/compile`，再决定使用 VikingBot 或接入其 Runtime 协议；普通 API 写页不会自动获得 Wiki 综合与冲突处理，需要维护 session 明确执行。[编译服务][ov-compile]

最先值得在 evoLoop 建立的是贡献/维护协议、来源修订与依赖记录、待复核状态、固定修订读取和实际使用回评。需要服务端保证的能力不能只用外层提示词补齐：固定版 OpenViking 写入有路径锁，但旧读后的覆盖不被基线条件拒绝，批量写也不是失败时完整回滚。若进入多写者阶段，应固定并验证新上游能力，或在写入边界做小范围补丁；不能把适配器的“先读后比较”冒称原子条件写。[写入协调器][ov-write]

nashsu 可借鉴或抽取的具体内容包括 `purpose/schema` 引导、页面合并、来源字段与 Review 交互。其页面合并已可注入模型合并函数，比较适合独立评估复用；整条 ingest 则需要先拆桌面依赖。[页面合并][n-merge]。这不等于把 nashsu 界面接到 OpenViking 就能直接工作；两个系统的来源、页面、审阅与索引模型需要映射，当前没有这样的适配器。

源码许可也影响复用方案：固定版本 OpenViking 主项目为 [AGPL-3.0][ov-license]，nashsu 为 [GPL-3.0][n-license]；evoLoop 自身许可证尚未选定。实际复制、修改和分发前应根据采用模块确定许可证安排，不能把公开 GitHub 仓库当作任意许可代码。

## 什么情况下改选 nashsu

如果第一阶段最重要的是“人每天直接操作一个成熟桌面 Wiki”，并接受应用常开、当前项目和本地 vault 的工作方式，**以 nashsu 桌面应用为基础改造是合理的**。它能先节省阅读与整理界面的构建工作，已有外部 MCP 写入口，也不要求一定使用内置模型生成。

但若坚持多个 session、跨运行时、持续后台维护与未来部署，不能把 headless 抽取当成轻微配置改动。当前建议选择 OpenViking 正是基于这个项目方向；如实际使用证明桌面体验才是首要价值，应回看该前提。

下一步应做一个完整纵向场景：导入真实项目的可用材料 → 形成知识 → 新 session 据此完成并实际使用产物 → 收到用户纠正 → 更新受影响旧结论 → 再交给新 session。沿用[有效性研究](../references/wiki-effectiveness.md)的对照和失败判据，同时记录为了接入而修改了多少模块。这个试点决定正式采用与 fork 范围，不能用现有 benchmark 或页面生成数量替代。

[ov-content]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/server/routers/content.py
[ov-compile]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/service/compile_service.py
[ov-skill]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/examples/compile/ov-compile-skills/llm-wiki/SKILL.md
[ov-renderer]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/bot/vikingbot/compile/renderer.py
[ov-write]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/storage/content_write.py
[ov-license]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/LICENSE
[n-ingest]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/src/lib/ingest.ts
[n-sync]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/src/lib/project-file-sync.ts
[n-mcp]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/mcp-server/src/index.ts
[n-lifecycle]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/src/lib/source-lifecycle.ts
[n-merge]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/src/lib/page-merge.ts
[n-license]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/LICENSE
