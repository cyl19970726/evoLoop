# 微信 Connector 标准模式接入与核验

本页用于 Task b698cd37 的候选接线。标准模式沿指定受管 Session 原有工具与完整执行权限；没有受限沙箱。wx-cli 原事件、inbox、outbox 和桌面发送仍由微信宿主掌管。先确定获准的专用测试群或私聊及原 Session，再创建 disabled 路由；没有这些实际绑定时保持 disabled。

## 固定的最小材料

维护者需在同一项目核定：`PROJECT_ID`、`BINDING_ID`、`RECEIVER_SESSION_ID`、`RECEIVER_ROLE_ID`、`RECEIVER_ACTOR`、`SESSION_REQUESTER_ACTOR`、`SENDER_ACTOR`、原 Session 的 `CWD`、`AUTHORIZATION_SCOPE`、原生 `THREAD_ID`、`CONVERSATION_ID`、wx `CONNECTION_ID/OWNER/EPOCH/SESSION_REF`、应用 ID，以及审核后的 `POLICY_HASH`。接收 Session 必须 ready、带同一原生 Thread、active execution profile，并保持原有 `danger-full-access`、`never` 和 scope。`SESSION_REQUESTER_ACTOR` 是原 Session 的预留者；`RECEIVER_ACTOR` 是该 Role 的业务执行者，须与现有 Role actor 或 Session material CLI 身份绑定一致，并有此项目 writer 身份。二者可不同。项目、Role、Session、cwd、原 scope 和 runtime grant 必须精确匹配。`SENDER_ACTOR` 是技术来源身份，不是微信发言人；原发言人和事件 cursor 保存在来源关联中。

微信宿主需为该 conversation 建立精确的应用 gateway 客户端：`inbox` 权限和 `session_ref/thread_id` pin；同会话回复还需 `send` 和 `result` 权限。私有客户端配置路径由运行维护者保管，不放进 Git。gateway 的允许 conversation 和 send 权限与 evoLoop 路由的 `sendTargets` 同时生效。当前项目没有已验证的专用 conversation、应用凭据或 Session 绑定；wx-cli 其他项目的群及授权不能直接沿用。

在私有 `EVOLOOP_INTEGRATIONS_FILE` 的既有对象中加入对应条目，保留其他配置。字段示意（尖括号需替换为核定值）：

```json
{
  "runtime": {
    "enabled": true,
    "grants": [{"projectId":"<PROJECT_ID>","actorId":"<SESSION_REQUESTER_ACTOR>","roleId":"<RECEIVER_ROLE_ID>","authorizationScope":"<AUTHORIZATION_SCOPE>","cwd":"<CWD>","sandbox":"danger-full-access","approvalPolicy":"never","networkAccess":true}]
  },
  "sessionMessages": {
    "enabled": true,
    "grants": [],
    "connectorReceivers": [{"projectId":"<PROJECT_ID>","bindingId":"<BINDING_ID>","sessionId":"<RECEIVER_SESSION_ID>","mode":"standard","senderActorId":"<SENDER_ACTOR>","receiverActorId":"<RECEIVER_ACTOR>","receiverRoleId":"<RECEIVER_ROLE_ID>","cwd":"<CWD>","policyHash":"<POLICY_HASH>","maxTurns":100,"enabled":true}]
  },
  "messageConnectors": {"enabled": true,"pollIntervalMs":2000,
    "gateway":{"executable":"/ABS/wx-agent-gateway-client","configPath":"/ABS/private/client.json"}}
}
```

这是所需字段片段，实际文件还要保留已有的 coordinator、runtime、`residentQueue.roleActors` 或当前 Session 的 `runtime.materialCli` 身份绑定及项目配置。`connectorReceivers` 的 `receiverActorId` 和路由 `targetActorId` 应为 `RECEIVER_ACTOR`，不能填写预留者。原 runtime grant 应授权 `SESSION_REQUESTER_ACTOR` 的现有 scope，不应为 Connector 改动已准备 Session 的 scope 或 Thread。内部转交目标另需普通 `sessionMessages.grants`，明确 `senderActorId=RECEIVER_ACTOR`、目标 Session/Role/actor/cwd 与额度；路由 `internalTargets` 只提供第二层目标限制。先用项目现有准备流程合法 prepare/activate 接收 Session 和 profile，再通过 Workbench“微信 Connector”创建 disabled 标准路由，核对来源、目标、actor、owner/epoch/sessionRef、哈希及版本，最后使用原操作 ID 更新为 active。停订将路由更新为 paused；原消息、原 wx delivery 和在途 Turn 仍须按 ID 核对。

## 读回与恢复

- `GET /api/projects/PROJECT_ID/message-connectors/routes/BINDING_ID` 核路由和版本；`GET .../operations/OPERATION_ID` 核未知配置写入。
- `GET .../routes/BINDING_ID/deliveries` 与 `GET .../deliveries/DELIVERY_ID` 核来源事件、平台消息、processing、Turn、决定和原发送 request ID；Workbench 路由卡片可读最近 delivery。
- 微信侧用 `wx-agent inbox --config /ABS/private/conversations.json status --id CONVERSATION_ID`、`show --delivery-id DELIVERY_ID --owner OWNER` 与 `events --delivery-id DELIVERY_ID --owner OWNER --after CURSOR --limit 50` 核原 delivery。`reconcile` 会收集待处理事件，是运营动作，不能当只读探针。
- `send_text` 未知时仅用原本地 request key 调用 gateway `result`；不要生成新 key 或改正文重发。`ui_observed` 只证明本地界面/来源可见，不证明收件人已收到。`complete` 未知时查原 inbox status；缺少 terminal row 仍保持未知。

原接收 Session 如需将某一来源转给已审核内部目标，以本人授权调用 `POST /api/projects/PROJECT_ID/message-connectors/routes/BINDING_ID/transfers`，正文含 `operationId`、`sourceMessageId`、`newMessageId`、`targetSessionId`、`content`。调用者须为路由的接收 actor，目标必须在 `internalTargets`；写入后还需目标 Session 的普通消息 grant 和实际处理读回。原操作未知时查普通 `/api/projects/PROJECT_ID/operations/OPERATION_ID`，保留原消息 ID 和正文。

直接获准的 Session 使用 Skill 与 wx-cli 查询历史或主动发文本无需订阅路由。受管本地 conversation 可用 `wx-agent conversations --config /ABS/private/conversations.json read --id CONVERSATION_ID --after CURSOR --limit 50`；广域历史/搜索属于另行授权的 `wx-cli query TALKER --after-sort-seq SEQ --limit 50 --format json` 与 `wx-cli search KEYWORD --limit 20 --offset 0 --format json`，不是应用 gateway 的方法。主动发送使用固定本地 request key、相同正文和 `--no-wait`：

```sh
wx-agent conversations --config /ABS/private/conversations.json send --id CONVERSATION_ID --owner OWNER --expected-epoch EPOCH --request-id STABLE_KEY --text-stdin --no-wait < /ABS/private/message.txt
wx-cli outbox --state-dir /ABS/private/channel show --request-id STABLE_KEY
```

应用 gateway 可改用 `send_text` 与 `result`，参数均为原本地 key；它不提供图片发送方法。当前自动路由只接入普通文本。图片、附件和媒体查询遵循 wx-cli 单独的本地能力及授权，不能据图文事件声称 Connector 已处理图片。正式测试须用获准的专用群/私聊，逐项记录入站原事件、平台 Session/Thread/Turn、同会话回复、内部目标独立收件、主动发送及收件证据；候选检查不能替代这些事实。
