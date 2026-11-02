# Rin Studio 任务 004：Roundtable 本机控制面板

基准：`22375586e2bf313775cec4552e758e8873b0d8e8`。开发分支：`feat/rin-roundtable-panel`。
此次交付只保存本地提交，不推送、不创建 PR、不合并 main。

## 实现与安全边界

复用已有 Orca Workers 面板，在工具栏下显示独立 Roundtable 区域。本机主窗口可查看
runId、Lead/Worker 会话、当前执行 Agent、完成回合、已接纳发言预算（上限六次）、
状态、错误和结束原因。保留历史 run 选择，无 run 时明确提示。
远程电脑、远程 Agent 和浏览器侧栏不挂载此区域。

Main IPC `maker:roundtable:panel` 只提供 getStatus/pause/resume/stop。入口先拒绝
device-link，再使用现有可信应用 Renderer 校验；当前 owner 的数据库确认本机 active
Lead，控制动作调用原 `OrcaRoundtable.command` 再验证 active Team 与 run 的归属。
payload 中的 leadSessionId 是选择器，不能代替身份认证；额外 caller 字段无效。
异步读取后重查 owner，避免账号切换泄露旧数据。Lead Plan 模式不能 resume。

Controller 仅新增返回副本的 `runsForLead` 查询；没有复制调度状态机或更改六回合预算、
完成事件、队列、暂停、终止、去重、恢复语义。IPC 不允许 start/dispatch，不创建 Worker，
不更改权限或审批。暂停只阻止后续派发，停止仍明确显示在途 Worker/Lead。
重启后的 uncertain 禁用继续，提示人工核对，不提供自动重试或解除 claim。

时间线任务和结果来自真实 run.messages；回传消息读取 Lead 会话数据库中的实际 user
消息，并同时核实 Orca origin、Worker 来源和准确的 run 标记。按原结果关联显示，
不生成回复、不推测已经投递；未匹配的真实消息单独列出。最多读取该 run 最近 64 条
回传记录（MVP 预算六次发言）。内容用 React 文本显示，不执行消息中的 HTML。

状态保存后广播现有 ORCA_WORKER_CHANGED，Renderer 按 Lead 订阅读取；手动查看和
操作后也刷新。没有定时器或无限轮询。切换 Lead/run、卸载和账号变化会淘汰过期响应；
读取/操作失败清除旧快照并显示统一的账号、Team 权限或状态错误提示。

## 修改文件

相对仓库根目录，共 25 个文件：

- `apps/desktop/src/shared/roundtablePanel.ts`：共享的最小 IPC 合同。
- `apps/desktop/src/main/maker-ipc/roundtablePanelHandler.ts`：鉴权后的查询/控制处理器。
- `apps/desktop/src/main/maker-ipc/register.ts`：可信本机 IPC、owner fence、实际数据库回传查询和已有推送事件装配。
- `apps/desktop/src/main/maker-ipc/orcaRoundtable.ts`：仅增加 run 只读查询。
- `apps/desktop/src/main/maker-ipc/__tests__/roundtablePanelHandler.test.ts`：真实 Controller 边界测试。
- `apps/desktop/src/preload/preload.ts`：类型化 IPC 桥。
- `apps/desktop/src/renderer/vite-env.d.ts`：Renderer API 类型。
- `apps/desktop/src/renderer/features/cc-agent/RoundtablePanel.tsx`：新面板。
- `apps/desktop/src/renderer/features/cc-agent/OrcaWorkerPanel.tsx`：原面板嵌入点。
- `apps/desktop/src/renderer/features/cc-agent/__tests__/RoundtablePanel.test.tsx`：组件行为测试。
- `apps/desktop/src/renderer/features/cc-agent/__tests__/OrcaWorkerPanel.test.tsx`：隔离新子面板，保留原 Worker 行为回归。
- `apps/desktop/src/renderer/i18n/locales/de/common.json`
- `apps/desktop/src/renderer/i18n/locales/en/common.json`
- `apps/desktop/src/renderer/i18n/locales/es/common.json`
- `apps/desktop/src/renderer/i18n/locales/fr/common.json`
- `apps/desktop/src/renderer/i18n/locales/ja/common.json`
- `apps/desktop/src/renderer/i18n/locales/ko/common.json`
- `apps/desktop/src/renderer/i18n/locales/pt-BR/common.json`
- `apps/desktop/src/renderer/i18n/locales/pt-PT/common.json`
- `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json`
- `apps/desktop/src/renderer/i18n/locales/zh-Hans-x-lzh/common.json`
- `apps/desktop/src/renderer/i18n/locales/zh-Hant-x-lzh/common.json`
- `apps/desktop/src/renderer/i18n/locales/zh-TW/common.json`
- `docs/dev-rules/orca-team-architecture.md`：登记本机入口与恢复边界。
- `docs/analysis/rin-studio-roundtable-004.md`：本报告。

## 验证

| 检查 | 结果 |
| --- | --- |
| Desktop 定向回归 | 11 文件、745 项通过，包含原有 Controller/Team/dispatcher/队列/权限/终态管道及原 Orca 面板 |
| 新增 Main IPC handler / UI 测试 | 6 / 7 项通过，已计入上项；单文件测试执行分别约 10ms / 300ms |
| Orca bridge/prompt 回归 | 2 文件、61 项通过 |
| MCP server 身份/transport 回归 | 1 文件、5 项通过 |
| 自动化测试合计 | 14 文件、811 项通过，无失败或跳过 |
| 新模块及测试 ESLint、测试规范、diff 空白 | 通过 |
| Orca 包 TypeScript（build = noEmit） | 通过 |
| Desktop 全量 TypeScript | 未通过：仅既有 chatServerGroupOpen.test.ts:426 TS2719；没有本次修改文件诊断 |
| i18n key / 术语检查 | 通过，未提高基线；存量警告保留 |
| 单组件 Chromium 浅色/深色渲染 | running、paused、uncertain、无 run、拒绝访问，5 × 2 = 10 场景通过，并检查概览截图 |
| 仓库 ui:check --changed --theme all | 未通过：既有 PdfPreview.tsx:38 对 pdf.worker.min.mjs?url 的 default import 构建错误 |

Main 测试经过生产处理器和真实 Controller，只模拟数据库/模型底座；验证实际控制状态、
跨 Lead/run/Team 拒绝、伪造 caller 无效、非 Lead/远程拒绝、异步 owner 切换和 Plan 保护。
UI 测试运行真实组件并模拟 IPC，验证真实字段呈现、按钮请求、事件过滤/解绑、暂停恢复、
在途/uncertain/停止提示、拒绝和无 run、切换 Lead 的旧响应及账号变化清空。
两类测试属于 unit，补足新增 IPC/UI 的权限和时序行为缺口，不用源码字符串断言。

全量类型错误的文件相对基准提交未修改；任务 003.5 报告已记录原始代码的独立 Compiler API
复现。本轮最终全量检查仍得到同一 TS2719，不能表述为整仓类型检查通过。

UI 检查使用真实组件、受控测试 host 和明确标注的 fixture 状态，验证渲染与主题，不代表
真实模型或 Electron IPC 已在 Windows 实机通过。单组件命令使用 ui:check 的 entry 模式、
Chromium 引擎、两种主题与五个场景；Windows platform 参数仅为 harness 环境声明。
临时 fixture、截图、日志和编译缓存不纳入提交。

## 剩余验证与使用方式

先在本机已有 Lead 的真实 Agent 工具中启动 run，再打开 Orca Workers 面板进行查看、
暂停、继续和终止；此次没有添加 UI 启动或派单功能。原有 Worker 聊天入口保留。

尚未运行完整 Windows Electron 客户端、真实模型、真实账号和桌面 IPC 端到端联调。
后续需检查双会话真实接力、实际审批卡、执行期间暂停/终止、应用重启 uncertain 和
账号切换。全量 TypeScript 与 changed UI 构建两项既有阻塞尚未修复。
新增文案具备简体中文和英文；其余十个 locale 暂用英文新文案，完整母语翻译待补。
没有修改 Agent 二进制版本、网络访问范围、官方云服务、数据库结构或 Worker 权限。
可以交给后续 Windows 集成验证；当前证据不足以宣称可直接作为完整 Windows 产品发布。
