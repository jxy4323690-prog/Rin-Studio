# 任务 003.5：Roundtable 质量审查与本地保存

日期：2026-11-02。分支：`feat/rin-roundtable-mvp`。
范围：审查并修复任务 003 的正确性问题，保存源码、测试与报告；不增加功能，不 Push、不创建 PR、不合并 main。

## 结论

Controller 仅管理有界 run 的顺序、去重和状态，模型执行、Worker 恢复、输入锁、授权与终态仍复用真实 Orca 服务。没有复制 Maker/Agent 的输入队列和运行时状态机，也没有定时器或单模型角色扮演。

生产调用链：已认证 MCP context → `withToolCallAuthority` / Host task action guard → owner-scoped Roundtable → `OrcaTeamService.sendToWorker` → 原有 dispatcher/accepted transaction → 真实 Worker session。Worker 的产品终态经 `bridgeWorkerCompletion` 的可选路由回到 Controller，只有归属匹配的实际结果才能产生下一次 Lead 输入；Lead 再通过结构化工具作真实决策。

## 审查发现与修复

1. **旧 Worker 终态可能误结算新任务。** 原代码在派发准备阶段就设置 inFlight，再仅按 Worker session 认领终态。修复：在 Orca 真正的 accepted 生命周期边界绑定实际 auto-bridge 对象身份；terminal 使用同一 identity 路由，不匹配的新旧执行不得推进 run。人工中断也使用被中断派单的身份。
2. **Lead 终态先于回执到达可能丢失。** 原 busy 分支直接返回，极速完成/失败后可能永远保留 running。修复：busy 期间按 instance/generation 去重暂存，释放派发边界后消费；旧 generation 不解除等待；初始执行身份在 start 前绑定，重复 start 不改绑。
3. **取消派发后过早释放 Team claim。** 已停止的派发收到确定未投递回执时，原代码没有检查仍在活动的 Lead。修复：仅在 Worker/Lead 均已收口时释放，防止跨实例重新取得 Team 占用。
4. **恢复保护需要覆盖完成路由和普通写入口。** 原装配仅查看已存在的内存 Controller，恢复日志尚未加载时不能据其拒绝不确定后续操作。修复：完成路由和 Worker/Lead 写守卫按 owner 加载日志；未完成或仍有在途执行的记录恢复为 uncertain，观察到迟到结果也不自动接力、不自动重放。此项是冷启动防御补强，不声称当前仅本机 MVP 已存在可复现的远端自动重放事故。
5. **directOnly 与 steer 的组合违背不留队列承诺。** 当前 Controller 没有对外开放 steer，但内部可选参数仍可能进入 steer 的排队路径。修复：该组合在派发前明确拒绝；普通 Orca 默认排队/插话策略不变。

先新增最小竞态用例，确认旧实现有 4 项失败；修复后同组全部通过。其他补测覆盖实际 Orca 服务的 accepted/terminal 绑定、人工中断、不匹配执行、恢复路由与 directOnly 策略。未靠跳过测试、放宽断言或提高基线使检查通过。

## 权限与恢复边界

- MCP caller 从现有真实上下文读取，不信任参数中伪造的 Lead ID；Host 再校验 active Team 和 Worker 归属。Worker 不获得团队控制权限。
- `roundtable` 写动作已经纳入原 Host 行动授权；危险工具仍走各自原有审批。
- Controller 不创建 Worker、不改 Worker 默认权限，只接纳本机、auto 权限且非 Plan 的已有 Worker。测试 Worker 显式使用 auto；普通产品历史默认值没有被改写。
- pause/stop 不解除用户队列暂停，不再生成后续派发；已跨过派发边界的模型仍如实记 inFlight/leadActive，不宣称已立即终止。
- 未确认的投递不自动重试；重启不恢复执行，只恢复可查询的 uncertain 记录并保留占用。没有自动跨崩溃对账/确认释放界面；需核实旧执行后另开独立 Lead/Team/run。
- 所有新日志位于 owner 私有应用目录，测试临时目录在系统临时路径并清理。未将运行日志、缓存、构建产物或凭据作为提交文件。

## TypeScript 基线复核

原始基线为 `2ce93d3631b58d12706094244244741e988d9b7c`。`chatServerGroupOpen.test.ts` 没有任何本次修改。
再次使用 TypeScript Compiler API，将改动的 tracked 源文件仅在编译器读取层映射回该 HEAD，单独检查原始群聊测试，仍在第 426 行得到 TS2719：`timed<T>` 接收的条件分支返回不同 `ChatServerResult` 结构，不能统一到所推断的 T。整个过程未覆盖工作文件。

本轮 Desktop 全量类型检查最终退出 0（使用 /tmp 下的增量缓存复查）；另保留该既有问题的独立复现证据，不据本轮整仓通过推断隔离可复现的基线问题已修复，也不擅自修改无关群聊功能。

## 验证

- Desktop 定向回归：8 文件、713 项通过。
- Orca bridge/prompt：2 文件、61 项通过。
- MCP server transport/身份/审批：1 文件、5 项通过。
- 合计 11 文件、779 项通过，无失败/跳过；比任务 003 多 8 项行为回归。
- 新 Controller/Store 严格 TypeScript、Desktop 全量 TypeScript、Orca/MCP 包 noEmit 检查、新模块及测试 ESLint、测试规范检查（357 文件）和 diff 空白检查全部退出 0。
- Windows、真实模型、完整 Electron、跨设备行为未验证；没有为启动桌面扩大网络权限。

## 本地提交的完整文件清单

```text
apps/desktop/src/main/maker-ipc/orcaRoundtable.ts
apps/desktop/src/main/maker-ipc/orcaRoundtableStore.ts
apps/desktop/src/main/maker-ipc/orcaTeamService.ts
apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts
apps/desktop/src/main/maker-ipc/register.ts
apps/desktop/src/main/maker-ipc/sessionEventTerminal.ts
apps/desktop/src/main/maker-ipc/taskActionAuthorization.ts
apps/desktop/src/main/maker-ipc/__tests__/orcaRoundtable.test.ts
apps/desktop/src/main/maker-ipc/__tests__/orcaTeamService.test.ts
apps/desktop/src/main/maker-ipc/__tests__/orcaInterAgentDispatcher.test.ts
apps/desktop/src/main/mcp-integrations/mcp-providers.ts
packages/lizi-mcps/src/orca/server.ts
packages/lizi-mcps/src/orca/server.test.ts
docs/dev-rules/orca-team-architecture.md
docs/analysis/rin-studio-roundtable-002.md
docs/analysis/rin-studio-roundtable-003.md
docs/analysis/rin-studio-roundtable-0035.md
```

保存时使用显式文件清单及 DCO sign-off；commit SHA 由提交完成后的 Git 记录给出，不在本报告中自引用。允许用户下一步授权发布功能分支以供进一步代码审查；这不等于允许合并或宣称生产就绪。
