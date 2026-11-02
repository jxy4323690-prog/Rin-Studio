# Rin Studio 开发任务 002：Orca Roundtable 架构分析

状态：提案，未实现。仅新增本文，不修改产品功能。分析依据为当前 checkout 的真实源码；未启动 Electron、Agent 二进制或真实模型，未修改网络权限。

## 1. 结论与范围

Orca 已有独立完整 Worker 会话、Lead↔Worker 双向消息、忙时排队、无损休眠恢复和终态回报，适合作为多 AI 协作底座。它不是已完成的同级 Agent 自主讨论系统。

- A 为 Lead、B 为其 Worker：现有 `send_to_worker` 可主动投递并唤醒 B。
- A 为 Worker、B 为其 Lead：`send_to_lead` 校验真实归属，必要时重建 Lead 捕获会话；直发或排队。手动回报结清回报义务，不代表 Worker 当前执行轮已终止。
- A、B 为同级 Worker：未提供受支持的直接通信工具。A 可报告 Lead，再由 Lead 派给 B；这需要 Lead 再次决策，并非透明同级路由。
- A、B 属不同 Lead：现有团队归属边界拒绝，不应绕过。
- 正文出现 `@B` 不等于宿主派发，不能靠提示词、字符串前缀或原生 subagent 假装已经唤醒 Orca Worker。

MVP 建议：同一个 active team、一个 Lead、2–4 个已明确选定的本机 Worker；每个 Worker 使用自己的 Agent/model/session/context。默认串行讨论，可配置不同模型；本地代码只能证明选路可行，真实模型能力和二进制可用性仍需后续集成验收。暂不覆盖 SSH、device-link、Mobile、跨 Lead、跨账号和自动新建 Worker。

## 2. 已核对的规则

根 `AGENTS.md`、`apps/desktop/AGENTS.md`、`docs/dev-rules/orca-team-architecture.md`、Desktop 开发入口、maker-core 行为规则、伙伴操作权限规则，以及伙伴群聊规范的讨论与分工章节。

关键约束：四类 Orca service 各司其职；全局可见的 MCP 工具仍需宿主校验真实调用身份；不嵌套创建 Orca team；Worker done 不等于质量验收通过；用户 Stop 和队列暂停不能被自动输入解除；协作开关不等于额外用户授权。后续实现涉及数据库、IPC、消息来源、UI 和 prompt 时，还需读取相应专项规范并按正常 migration/review 流程落地。

## 3. 真实源码地图

| 能力 | 文件与锚点 | 当前责任 |
| --- | --- | --- |
| Lead | `apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts`，`activateLeadTeam` / `startTeam` | 激活 Lead 角色、team 创建、首 Worker 补偿 |
| Worker 创建 | `apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts`，`createOrcaWorkerCreationService` | 独立 session、Agent/model/provider/权限选择、reservation 和 bootstrap |
| Worker 生命周期 | `apps/desktop/src/main/maker-ipc/orcaTeamService.ts`，`sendToWorker` / `dispatchResolvedWorker` | 校验归属、恢复 dormant Worker、接受/提交/回滚、idle/archive |
| 路由边界 | 同文件 `resolveWorkerRef`，约 865 行 | 只在 caller Lead 的 Worker 列表精确匹配 workerId/sessionId；不能传 Worker A 的身份控制 B |
| 工具注册 | `packages/lizi-mcps/src/orca/server.ts`；`src/xdt-helper/send_to_worker.ts` | `cindy_orca` 控制面，真实 session context 进入 host service |
| Worker→Lead | `packages/orca-workflow/src/orca-bridge-mcp.ts`，`resolveWorkerLink` / `resolveLead` / `send_to_lead` | 核验调用会话确实拥有 Worker；按 link 反查 Lead，拒绝任意目标 |
| 投递 | `apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts`，`dispatchOrEnqueueOrcaInterAgentMessage` | 空闲直发、忙时排队、可选 steer、accepted callback 与回滚 |
| 输入队列 | `apps/desktop/src/main/maker-ipc/agent-input-coordinator.ts`，`AgentInputCoordinator` | 单会话输入边界、drain、暂停、Stop、交互锁、恢复、clientId 去重 |
| 队列编辑 | `sessionQueueControl.ts`、`sessionQueueInspection.ts`；`OrcaTeamService` 的队列控制方法 | 查询、改写、撤销、移动、合并，保留来源与归属约束 |
| 队列持久化 | `apps/desktop/src/main/localDb/agentInputQueueSnapshots.ts` | 快照恢复及持久输入的 clientId 对账 |
| 终态捕获 | `sessionEventDelivery.ts`，约 99 行 | 在 tracker 唤醒 drain 前捕获 Worker runtime/turn generation，避免旧终态结算新任务 |
| 产品终态 | `sessionEventTerminal.ts`，约 763 行；`register.ts` 的延迟终态结算 | 只有最终释放的产品 done/error 进入 Worker 收尾；自愈中供应商终态不能抢先完成 |
| 完成回报 | `orcaTeamService.ts`，`handleWorkerTerminalTurn` / `bridgeWorkerCompletion` | 更新 Worker done/error，手动报告与 auto-bridge 竞争去重，回报 Lead |
| 数据真源 | `apps/desktop/src/main/localDb/schema.ts` 的 `orcaTeams` / `orcaWorkers`；`orcaTeamStore.ts` | active team、worker session、状态和角色；fork parent 不能代替团队归属 |
| 休眠 | `orcaIdleReleaseWatcher.ts` / `orcaWorkerResumeScheduler.ts` | idle release 保留历史和对象，下次任务恢复运行时 |
| 装配 | `apps/desktop/src/main/maker-ipc/register.ts` | 依赖注入、IPC/MCP wiring，不应承载另一套讨论状态机 |

独立 Agent 不要求独立 OS 进程：例如 Codex 可共享 app-server，但 thread/context 必须独立。

## 4. 可复用能力与缺口

已有投递回执可区分 direct / queued / steer 与失败；queued 仅代表已排队，不能当作开始执行或完成。dispatcher 当前每次请求自行生成 clientId，因此 coordinator 的单输入去重不足以保证跨重启的讨论事件只投递一次。

auto-bridge 的 pending / ready / inFlight / 对象身份和 generation 守卫值得复用；不能再独立监听原始供应商 done 文本另做完成判定。手动 `send_to_lead`、自动补报、真正的执行终态是三个不同事件。

额外发现：`botGroupChatService.ts` 已有宿主强制的 3 圈/10 条额度、串并行发言与分工；`packages/maker-shared/src/botGroupMentions.ts` 已有点名和接力步骤解析。它们使用 Bot 身份和群专线，受 `bot-group-chat.md` 的用户续轮规则约束；可参考纯解析和额度设计，不能直接把 Bot ID 当 Orca Worker ID，也不能改变既有群聊续轮行为。

缺口：同级路由授权、可靠结构化 @、讨论级持久状态、统一预算、跨会话暂停、业务事件/outbox 去重、明确完成与失败恢复协议。

## 5. Roundtable Controller 提案

在 host service 层增加独立 `OrcaRoundtableService`，纯确定性的调度核心与存储/投递 adapter 分离。它负责讨论顺序、额度和回执，不负责模型推理、Worker 创建或独立 runtime 生命周期。现有四服务仍为执行真源。

一组 roundtable 绑定一个 active team；用户明确启动时保存成员与目标、允许的接力边、权限作用域和额度快照。默认使用已有 Worker，不因模型点名自动建人。仅由宿主据真实 caller session 反查成员身份。

推荐事件：`RoundtableStarted`、`HandoffProposed`、`DeliveryQueued`、`TurnAccepted`、`TurnSettled`、`ApprovalPending/Resolved`、`Paused/Resumed`、`Finished/Failed`。每个事件关联 `discussionId / epoch / eventId / causeId / teamId / workerId / assignmentId / clientId / execution generation`。

运行态：`running → paused | waiting_approval | recovering | completed | failed | cancelled`。内部子步骤单独记录 pending/queued/accepted/settled/uncertain；不向 Worker status 增塞这些值。完成原因、质量结论另列字段。

### @ 与自动接力

用户侧 @ 候选绑定真实 workerId，重名、未知名、离队成员明确报错；显示 label 只用于呈现。Agent 侧增加固定 schema 的 `roundtable_handoff(target_worker_id, message, expected_assignment_id)`，宿主从上下文决定发送者和实际 assignment，模型不能自报角色或 owner 授权。

工具先登记接力提议，返回 proposed，不谎称 delivered。MVP 每个执行轮最多一个后继，禁止自发广播。A 当前产品轮成功结束后，Controller 才按登记提议投递 B；没有提议则按启动时的轮转顺序选下一位。正文中的 `@B`、引用/代码块和流式输出都不直接触发工具或路由。

路由链：真实 A context → 同 team 成员/运行代次核验 → roundtable 范围授权 → 持久 outbox → Orca worker 投递原语 → dispatcher → coordinator → B 的 session。B 的终态再进入下一轮。A/B 可互指，但只能在预算内。

不能用 A 的 callerSessionId 冒充 Lead，也不能传任意 Lead ID 绕过 `resolveWorkerRef`。需增加宿主持有的、限定 discussion/team/member 的授权 adapter，先核验 A 的真实身份与现有 task-action 授权，再调用既有 Worker 执行原语；把 A 的来源和授权链带到 B。不是把普通 `send_to_worker` 向所有 Worker 无条件开放。

Lead 的既有回报通道保留，Worker 结果仍可观察。Controller 只按 assignment 的产品终态推进，绝不因 Lead 收到 auto-bridge 或手动回报再次推进。MVP 给 Roundtable 管理的 Worker 增加派单冲突检测：Lead 新派单或用户接管时暂停对应讨论，不允许 Controller 与 Lead 同时争用该 Worker；真实用户操作优先。Lead 总结属于显式的一次收尾派发，不自动启动下一场讨论。

讨论上下文注入 user/input 的低信任数据块，携带来源、最新议题、前一位结论与有界摘要；不反复改 system 前缀，不把其他 Agent 的话当用户授权。长期历史仍留各自 session，避免每轮复制全量 transcript。

## 6. 防循环、暂停、审批与恢复

| 机制 | MVP 规则 |
| --- | --- |
| 消息去重 | 数据库唯一键 `(discussionId, epoch, assignmentId, eventType)`；handoff 每 assignment 一条，eventId 去重。业务先 claim 再投递，事务写 outbox；不按正文 hash 去重合法重复问题 |
| clientId 连续性 | outbox 提前分配稳定 clientId，扩展 Orca 内部投递契约透传；队列快照、持久消息和实际执行对账都使用它。不能每次重试重新随机生成 |
| 轮次额度 | 建议默认 3 圈、最多 10 次参与者发言、每圈每人最多一次、同时运行 1 位；Lead 收尾另限 1 次。MVP 不开放 Agent 提高上限；界面分别显示圈数与发言数 |
| 预算计数 | 排队前预留名额，accepted 后记账；重试同 assignment 不重复计数，也不能通过失败退回额度无限尝试。token/cost 若提供可靠 usage 则叠加用户预算；缺失时明确未知，不假报为零 |
| 时间与熔断 | 建议每 assignment 15 分钟活动时间上限，审批/用户暂停不计；等待队列可显示独立时长。连续两次失败暂停，不自行换模型/扩大权限。已有 loop guard 保持不变 |
| 用户暂停 | 先原子置 paused、提高 controller revision，阻止在途异步回调新派发；保留未执行 outbox。已跨 accepted 边界的执行默认完成当前轮，但不接力；另提供立即停止，按现有 Stop/abort 流程停止本讨论拥有的输入 |
| 队列保护 | 不清空或恢复用户其他输入，不调用会自动解开 Stop 的 resume；对 Controller 行执行精确暂停/撤销。已入 coordinator 的行必须在入库前受 pause/取消代次栅栏保护，单有外层状态开关不足以挡住旧队列 drain |
| 审批 | 沿用 Full Access / Auto / Ask / Plan 的现有权限链和 worker 创建偏好；普通协作不叠加无依据的确认卡。权限升级、工作目录等既有需确认动作保持原审批；B 按自己的权限执行，A 不能代 B 同意 |
| 审批恢复 | 保存实际请求 ID 与版本；批准/拒绝只处理该请求，晚到批准不解除暂停或恢复旧 assignment。Plan 不执行副作用；无需用户提供密钥到聊天 |
| 明确未投递 | 可有限退避重试同 outbox，建议 1s/3s 最多两次；权限撤销、未知目标等永久错误不重试 |
| 回执不确定 | 状态置 uncertain，查 clientId 的队列/消息/accepted 记录；已有则接回跟踪。无法证明未执行时不重放；暂停并让用户查看或决定下一步，避免重复文件写入或工具执行 |
| 产品恢复 | coordinator 自愈、凭证切换/限额等待期间不判下一棒；只在最终产品终态推进，保留 runtime generation 防迟到终态误结算 |
| 重启 | 从持久讨论/outbox 对账，默认 paused/recovering；复用原 Worker 历史，不重新建 Worker。数据库 owner/team 已变或成员已归档则拒绝旧投递；临时不可判定保留为可恢复，不当作永久撤权 |
| 多实例 | 持久 lease + fencing token/CAS revision，只有持有 lease 的 host 可投递；过期旧 host 回调不得推进。不能只靠内存锁宣称防重 |
| 完成 | 没有后继且一整圈无新贡献、达到额度、用户结束、不可恢复失败分别记录原因；queued、空文本、手动回报不单独表示目标任务验收通过 |

停止讨论不删除 Worker/session/历史。任务执行结束与质量验收正交，Lead 汇总应注明限制、失败与剩余分歧。真正需要实施写代码的分工先由用户启动时授权范围，MVP 默认讨论和评审，不默认为成员提升文件写权限。

## 7. 分阶段开发与拟修改清单

以下均是后续建议，不是本次已经修改的功能。

| 阶段 | 文件/模块 | 拟改内容 |
| --- | --- | --- |
| 1：契约 | 新增 `packages/maker-shared/src/orca-roundtable.ts`，包导出 | 状态、事件、配置、回执类型；不复用 Bot ID |
| 1：确定性核心 | 新增 `apps/desktop/src/main/maker-ipc/orcaRoundtableService.ts` | 纯事件 reducer、额度、成员解析、接力、暂停/恢复；注入 clock/id/store/dispatcher |
| 1：持久化 | 新增 `apps/desktop/src/main/localDb/orcaRoundtableStore.ts`，修改 `localDb/schema.ts`，新增下一条正式 migration | discussions/assignments/outbox、唯一键、revision/lease；不得重写旧 migration |
| 2：投递接入 | `orcaTeamService.ts`、`orcaInterAgentDispatcher.ts`、`agent-input-coordinator.ts`、队列快照序列化层 | 受限授权 adapter、稳定 clientId、assignment/source 元数据、暂停栅栏和冲突处理；复用执行事务 |
| 2：终态接入 | `sessionEventTerminal.ts` / `sessionEventDelivery.ts` 与 `register.ts` | 在既有产品终态收口后发布 typed event；不能重复消费 vendor terminal，wiring 保持薄层 |
| 2：工具 | `packages/orca-workflow/src/orca-bridge-mcp.ts` 与少量 worker prompt；按需要修改 `packages/lizi-mcps/src/orca/server.ts` | Worker handoff/status 工具，宿主来源校验；稳定注册，不在每轮增删工具 |
| 3：最小控制面 | `OrcaWorkerPanel.tsx`，新增 `OrcaRoundtablePanel.tsx`；现有 preload/IPC 类型声明和注册路径 | 显式开始、成员选择、额度、状态、暂停/继续/结束和失败原因；只接本机 IPC，不扩 device-link allowlist |
| 3：文案与规范 | 对应 i18n、`orca-team-architecture.md`、消息来源规范 | Light/Dark、术语与来源标签；说明新机制仅作用于显式 roundtable，不更改普通 Orca/群聊行为 |
| 各阶段：测试 | 新增 `orcaRoundtableService.test.ts` / store 集成测试；扩展既有 dispatcher/team/coordinator/MCP 测试 | 按下节验收，测试通过真实入口观察结果，不创建常量镜像测试 |

第一阶段先实现无模型的确定性状态机和持久 outbox，第二阶段用假 Session 验证完整 handoff，第三阶段再接最小界面与真实模型。无法可靠保存输入去重/暂停边界时，不发布自动接力开关。MVP 不要求新 workflow_run 体系，也不需要修改各模型的底层协议或官方二进制版本。

工具/prompt 接入前按 maker-core 规则补测缓存命中、返回速度、输出准确性与 token/usage；真实模型不可用时标记为未验，不用 mock 宣称多模型效果已成立。

## 8. MVP 验收标准

1. 同一 team 的 A/B/C 有独立 session 与可追溯身份；A handoff B，A 产品轮结束后 B 恰好收到一次输入，再由 B 接 C；不需要用户每轮催促。
2. B 忙时只排队、idle release 后走恢复；queued 回执不提前推进，实际 accepted/settled 与记录一一关联。
3. 同一 handoff/tool 重放、done 重放、手动报告和 auto-bridge 同到，只产生一个后继；旧 generation 终态不覆盖新派单。
4. `@` 出现在代码块、引用、流式中间段不唤醒；未知/重名/跨 team/归档成员明确拒绝，不能伪造 caller ID。
5. A↔B 循环到额度即停，Agent 不能修改预算；收尾只触发一次，显示结束原因。
6. 暂停与投递/终态/审批并发后，不再启动新一棒；立即停止只影响本讨论的执行与队列，用户其他任务保留。
7. Auto/Ask 请求保留实际审批，拒绝不执行；Full Access 沿用现有契约；晚到批准和旧 epoch 回调不恢复已停讨论。
8. 明确投递失败有限重试；丢失回执先对账；重启或两个 host 同时恢复不重复执行；不确定状态可见且可人工处理。
9. 用户接管或 Lead 新派单时 Roundtable 退让并暂停，不吃掉新任务，不把其他 turn 的终态当自己的完成。
10. 原 Orca 非 roundtable 路径、桥接报告、队列控制和已有群聊行为回归通过；本机 UI 的控制和状态可观察，远端入口不可误用。

## 9. 本次检查结果

使用既有工具 Node 22.22.3、pnpm 10.33.2。所有命令保留真实退出码，未调用 Desktop dev/start，未连接模型或放宽网络。

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @cindy/orca-workflow build`（实际 `tsc --noEmit`） | 退出 0，类型检查通过 |
| `pnpm --filter @cindy/orca-workflow test` | 退出 0，2 文件 61 测试通过 |
| `cd apps/desktop && pnpm exec vitest run src/main/maker-ipc/__tests__/orcaTeamService.test.ts src/main/maker-ipc/__tests__/orcaInterAgentDispatcher.test.ts src/main/maker-ipc/__tests__/orcaStartTeamPermissionGate.test.ts src/main/maker-ipc/__tests__/sessionQueueControl.test.ts src/main/__tests__/agentInputQueue.test.ts --maxWorkers=2` | 退出 0，5 文件 343 测试通过 |

宿主测试分别为 TeamService 223、Dispatcher 64、权限 gate 8、队列控制 14、输入队列 34 项。合计 404 项，全部通过，无跳过、无失败。Desktop 测试配置使用仓库已有 Electron stub，不能据此宣称真实 Electron、三种模型、SSH 或跨设备行为已验证。

本次未跑整仓 typecheck/全量测试；结果覆盖 Orca 相关纯 Node 单测与 Orca 包类型检查，不扩大为整仓健康结论。新 Controller 尚未实现，其验收项是后续开发门槛，不是本次已通过的能力。
