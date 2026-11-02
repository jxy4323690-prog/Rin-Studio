# 开发任务 003：Roundtable MVP 实现与验收

本文件记录任务 003 的交付快照；003.5 审查修复及最终保存结果见 `rin-studio-roundtable-0035.md`。

开发分支：`feat/rin-roundtable-mvp`。不推送、不合并。任务 002 的分析文件保持原样。

## 实际工作方式

生产入口是 `cindy_orca.roundtable`，复用现有 MCP transport 的真实会话身份、Host 行动授权、Orca 团队归属和派发服务。

1. 用户向已有 Lead 下达任务；Lead 调用 `roundtable start` 建立唯一 run。
2. Lead 用 `roundtable dispatch` 指定真实 Worker ID、任务正文和唯一 request ID。
3. Host 核对 active team、Lead/Worker 归属、本机位置及 Worker 的 `auto` 权限；不创建 Worker，不修改权限默认值。
4. `OrcaTeamService.sendToWorker` 走原有恢复、发送锁、授权和 accepted/rollback/commit 流程；模型执行在独立 Worker session。
5. Worker 产品终态进入既有 `handleWorkerTerminalTurn → bridgeWorkerCompletion`，可选 `routeWorkerCompletion` 将真实结果交给 Controller；该次常规 auto-bridge 被接管，避免双重报告。
6. Controller 经原有 dispatcher 的 Worker→Lead 来源格式和权限链投递实际结果。Lead 的下一轮模型推理决定新任务/目标 Worker，或结束；不是固定脚本轮流扮演角色。
7. Lead 显式 finish 或其匹配的产品终态结束本轮；Worker/Lead 失败、用户停止和六次发言上限分别记录原因。

Worker 可以在最终结果中请求另一位协作者，由 Lead 理解实际结果并用结构化 dispatch 派给该团队的另一 Worker；没有给 Worker 增加团队管理权。正文 @ 不触发控制器。

## 最小工具接口

公共字段：`action`、`run_id`；派单另需 `request_id`、`worker_id`、`message`。

| action | 行为 |
| --- | --- |
| start | 注册一次 run；同 ID 不会重新启动 |
| dispatch | Lead 根据真实进展作出下一次派单决策；同 request ID 不重复派发 |
| pause | 暂停后续派发，保留结果；不假称已中断在途模型 |
| resume | 继续未执行的结果交付或明确未投递的任务；不重放 uncertain 执行 |
| stop | 禁止后续接力；`inFlight` / `leadActive` 保留尚未确认收口的执行 |
| getStatus | 返回状态、当前目标、计数、请求/结果、错误/结束原因；仅同 owner 的真实 Lead 可读 |
| finish | Lead 明确结束决策 |

例如在已有协同 Lead 中：

```json
{"action":"start","run_id":"windows-smoke-001"}
```

```json
{"action":"dispatch","run_id":"windows-smoke-001","request_id":"inspect-1","worker_id":"实际WorkerID","message":"只读分析指定源码，报告发现和下一步建议"}
```

结果进入 Lead 的新模型轮后，Lead 可使用新 request ID 继续 dispatch，也可 finish。不要用循环轮询 getStatus 代替等待事件。

## 与任务 002 设计的取舍

当前 MVP 是 Lead↔Worker 有界协作，不实现同级 Worker 直接管理、完整讨论 UI、通用 workflow_run 或大型数据库迁移。最多 6 次参与者执行轮，包含初始 Lead 及结果唤醒轮；状态查询/暂停确认等用户控制动作不作为自主协作轮次。

没有引入自动可重放 outbox。为保证暂停和崩溃后的安全，新增内部 `directOnly` 投递策略：仍尊重原有输入队列和发送锁，但不把 Roundtable 输入留下为无守卫的持久排队任务。普通 Orca 默认排队/插话行为不变。

- 快 Worker 在初始 Lead 结束前返回：结果保存在 run，匹配的 Lead 产品终态驱动再次交付，无定时器。
- 其他已有队列、busy 或换窗无 live runtime：明确暂停；用户检查后 resume。不会自动解除用户的队列暂停。
- 投递结果不确定：记 uncertain，不自动重发，不更换模型或扩大权限。
- 进程重启：恢复日志仅供状态检查，未完成 run 进入 uncertain；不把旧任务当新任务启动。
- owner 私有目录下 JSON 原子替换，run tombstone 和 Team 独占 claim 防止重复启动/跨进程重复执行。崩溃遗留 claim 不擅自删除；此版无自动对账/人工确认恢复接口。需先核实旧执行，再显式结束旧 Team、创建独立的新 Lead/Team/run；不能声称已有无缝恢复。

普通异常不会被当作“肯定未投递”。只有 dispatcher 的明确 pre-dispatch 拒绝才允许显式 resume 重试。用户 Stop 后，迟到终态只收口已有执行，不生成下一棒。

## 文件变更

- 新增 `maker-ipc/orcaRoundtable.ts`：控制器、run 状态、计数、去重、暂停停止与产品终态处理。
- 新增 `maker-ipc/orcaRoundtableStore.ts`：owner-scoped JSON 日志及独占 claim。
- 新增 `maker-ipc/__tests__/orcaRoundtable.test.ts`：行为、竞态与恢复测试。
- 修改 `orcaTeamService.ts`：可选完成路由和 directOnly 的原有授权复核；默认路径不变。
- 修改 `orcaInterAgentDispatcher.ts`：可选 directOnly，拒绝隐藏排队/冷启动内部重派。
- 修改 `register.ts`：owner-scoped 控制器、真实 DB/权限/Orca adapter 装配。
- 修改 `sessionEventTerminal.ts`：产品 Lead 终态钩子，按真实 execution generation 收口。
- 修改 `taskActionAuthorization.ts`：将 roundtable 写动作纳入已有 Host 行动授权。
- 修改 `mcp-providers.ts`、`packages/lizi-mcps/src/orca/server.ts`：已有 MCP 入口与依赖转发；无新网络入口或通用 IPC。
- 扩展现有 TeamService、Dispatcher、MCP server 测试；更新 Orca 权威架构文档。

上面的 main 路径均相对 `apps/desktop/src/main/`。没有改变官方 Agent 版本、依赖清单、锁文件、Worker 默认 Full Access 偏好或云服务。

## Windows 真实模型验收前提与步骤

1. 在本分支准备仓库所固定的 Agent 二进制和两个真实可用的模型授权；云端本次没有启动桌面或下载放行。
2. 按仓库安全启动规范使用隔离开发沙箱，不连接共享正式用户数据库。
3. 打开 Lead 协同，显式选择 Worker 创建权限 `auto`，建立独立 Worker，不把一个模型的一段角色扮演当成两个会话。
4. 让 Lead 使用 roundtable 完成“只读分析 → Worker 回报 → Lead 根据结果追问 → Worker 回答 → Lead 收尾”，核对两个 session 的历史、模型及来源标签。
5. 在 Worker 执行时 pause/stop，确认没有后续派单；在途执行仍明确显示。测试危险操作时使用现有 Ask/Auto 审批，不改变权限来使测试通过。
6. 测试重复 request、终态重放和第六次发言上限；进程强退后不得自动重放旧任务。

具备开展此集成测试的代码入口与 mock 回归基础，但真实 Windows 模型、Electron 启动和审批 UI 效果尚未验证，不属于本次已通过结论。

## 验证记录

测试及 TypeScript 检查使用 Node 22.22.3、pnpm 10.33.2。

| 检查 | 最终结果 |
| --- | --- |
| Desktop 定向回归（Controller、TeamService、Dispatcher、任务行动权限、权限 gate、队列、产品事件管线） | 8 文件 705 测试通过，其中新增 Controller 21 项；无失败/跳过 |
| Orca bridge/prompt 回归 | 2 文件 61 测试通过 |
| MCP server 真实 transport/身份/权限测试 | 1 文件 5 测试通过 |
| 全部上述测试 | 11 文件 771 项通过，本次新增行为测试 29 项 |
| 新 Controller/Store 严格 TypeScript 检查 | 通过 |
| `pnpm --filter @cindy/orca-workflow build` / `pnpm --filter @cindy/mcps build`（均为 noEmit 类型检查） | 通过 |
| Desktop 全量 typecheck（含使用增量缓存的最终复查） | 未通过：既有 `chatServerGroupOpen.test.ts:426` TS2719，泛型 timed 回调的不同结果结构不兼容；没有报告 Roundtable 文件类型错误 |
| 新模块及测试 ESLint / `git diff --check` | 通过 |
| `pnpm check:test-hygiene` | 通过，357 文件符合基线 |

全量类型错误已通过 TypeScript Compiler API 单独复现：将所有改动过的 tracked 源文件在编译器内存中映射回 HEAD，再检查原始群聊测试文件，仍得到同一位置 TS2719（HEAD `2ce93d3631b58d12706094244244741e988d9b7c`）。未临时覆盖工作文件，也未修改该无关测试。该项不能写成整仓 typecheck 已通过；需另行修复既有群聊测试的泛型回调类型。

新增集成测试通过真实 `OrcaTeamService` 的派发和产品终态入口验证报告恰好一次，只模拟底层模型 I/O，不是单独的演示状态机。新增 Controller 测试单文件实际用例耗时约 30ms；包含加载的单独运行低于 5 秒。

可信测试基线检查最初因缺少 `refs/remotes/origin/main` 退出 2，随后仅使用现有 HTTPS Git 访问只读 fetch 真实 main 引用，再运行完整检查通过。没有伪造引用、提高基线或放宽网络。

没有进行真实模型/Windows/Electron 验证；因此模型工具遵循性、实际审批交互、工具 schema 增量对真实模型缓存命中和 token 用量的影响仍未实测。新工具定义固定注册，run 的动态内容留在输入/工具结果，不拼入易变 system 前缀。
