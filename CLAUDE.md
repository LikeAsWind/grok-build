# CLAUDE.md

## Web UI: OpenCodeUI fork → grok 适配

> 8 步 ACP 改造 + 配置表单编辑器 + 多后端支持均已落地。  
> 设计背景：`docs/web-acp-adaptation-plan.md`、`docs/web-config-ui-design.md`。  
> 多 workspace 编排仍 pre-design：`docs/multi-workspace-requirements.md`。

### 架构

```
浏览器 OpenCodeUI (React 19 + Vite 7 + Tailwind CSS v4)
  ↕ ACP JSON-RPC over WebSocket (/ws?server-key=KEY)
  ↕ REST (/config-file, /browse-dir) —— x-server-key header
grok web (Rust axum, 复用 xai-grok-shell MvpAgent)
  ↕ tokio::mpsc (ACP)
xai-acp-lib / agent-client-protocol v0.10.x
```

同源默认；多后端通过 `serverStore` 切换（split deploy / 本地 + 远端并存）。

### 前端

- **基础**：[lehhair/OpenCodeUI](https://github.com/lehhair/OpenCodeUI)，React 19 + Vite 7 + Tailwind v4，**GPL-3.0-only**——本仓库所有新增代码沿用此协议
- **已内置**：Shiki 高亮、xterm.js、主题系统、PWA、移动端适配
- **构建**：`npm run build` → `web/dist/`，rust-embed `web-ui` feature 编译期吸入

### 模块地图（实文件）

**ACP transport & 桥 — `web/src/api/`**
- `acp.ts` — `AcpClient`（JSON-RPC over WS），ext 方法前缀路由（`_x.ai/...`）
- `acpBridge.ts` — **唯一共享连接**。负责 `fetch /config → WS → initialize → authenticate`；把 `session/update` 翻译成 OpenCodeUI 的 SSE 事件并注入 `events.ts::broadcastEvent`（`messageStore` 等下游零改动）。导出 `getAcpStatus / subscribeAcpStatus / getBackendBaseUrl / getAcpSecret / acpExtRequest / getAcpActiveModels / getCurrentAcpModelId / mapAcpModels`
- `acpPermissionBridge.ts` — 服务端发起的 `session/request_permission` 处理器
- `client.ts` — 薄 re-export，保持 `import { ... } from './api/client'` 兼容
- `types.ts` — `ModelInfo`、`AgentInfo` 等共享类型
- `sdk.ts` — `@opencode-ai/sdk` 运行时已剔除，保留类型 stub（避免 import 链断）
- `events.ts` — `session/update` ↔ `message.part.delta / .updated / session.idle`
- `message.ts` — `sendMessageAsync` → `AcpClient.prompt`；abort → `cancel`
- `session.ts` — `session/new`、`x.ai/session/{list,delete,fork}`
- `agent.ts` — `getAgents` 取自 `initialize.modelState.availableModels`
- `permission.ts` — `request_permission` + `x.ai/ask_user_question` → `permission.asked` / `question.asked`
- `mcp.ts` — `x.ai/mcp/list` + toggle
- `pty.ts` — 客户端表面保留；ACP `terminal=false`，UI 提示"终端不可用"
- `grokConfig.ts` — `getGrokConfigFile / saveGrokConfigFile / getGrokConfigParsed / patchGrokConfig / reloadBackend / browseDirectory`
- `constants/api.ts` — `API_BASE_URL` 默认同源；`VITE_API_BASE_URL` 覆盖

**状态 — `web/src/store/`**
- `serverStore.ts` — 多 `ServerConfig` + `activeServerId`；`setActiveServer` / `updateServer` 触发 `notifyServerChange`，acpBridge 自动重连
- `themeStore.ts` — 主题（与 `ui.theme` 热重载联动）
- `layoutStore.ts` — 持久化侧栏宽度 / 面板可见性
- `followupQueueStore.ts` — streaming 期间的 follow-up 队列
- `messageStore.ts`（未改）— 消费 `events.ts` 注入的 OpenCodeUI 事件

**React glue — `web/src/contexts/` + `web/src/hooks/`**
- `AcpContext.tsx` — 订阅 `acpBridge` 状态
- `SessionContext.tsx` — 当前 session / model / mode（`set_model` + `set_mode`）
- `useChatSession.ts` — 发送 / 中止 / 重试
- `useGlobalEvents.ts` — 把服务端通知路由到权限/问题/计划 modal
- `useSessionManager.ts` — 列表/创建/加载/删除/fork + 服务器切换重连

**UI — `web/src/features/`**
- `chat/` — `ChatPane`、`Header`（模型+模式+ACP 连接状态+服务器切换）、`InputBox`、`InputToolbar`（`@` 提及 / `/` 命令 / follow-up 队列徽章）、`sidebar/SidePanel`（会话列表 + 服务器健康）、`sidebar/DirBrowserModal`（`browseDirectory` 工作目录选择）
- `settings/` — `SettingsDialog`（双 tab：表单 / TOML 源码）+ `components/`：
  - `GrokConfigSettings.tsx` — 左 rail 列 `grokConfigSchema` 的分区，右 pane 渲染 `ConfigSectionCard`
  - `ConfigFieldControl.tsx` — 数据驱动：开关/输入/下拉、密钥掩码、模型引用下拉、规则对、键值对、Anthropic / OpenAI / Ollama 预设
  - `CustomModelsSettings.tsx` — 模型与供应商表格 + 展开抽屉
  - `SelectField.tsx` — 主题感知下拉
  - `configFormOps.ts` — 增量 patch（`buildSectionDraft` / `buildSectionOps`），只动用户编辑过的 section
  - `grokConfigSchema.ts` — 声明式字段元数据（`ConfigFieldDef` / `ConfigSectionDef` / `ConfigGroupDef` / `KeyedTableDef` / `ReloadKind`）

### grok 扩展协议

- 类型：`crates/codegen/xai-acp-lib/src/message.rs`
- 前端类型：按 OpenCodeUI endpoint 一文件一组的 `web/src/types/api/*.ts` 保留
- 常用 ext：`x.ai/session/{list,delete,fork,status}`、`x.ai/mcp/{list,toggle}`、`x.ai/ask_user_question`、`x.ai/exit_plan_mode`、`x.ai/rewind/{points,execute}`、`x.ai/internal/reload_{models,config,all_mcp_servers,skills}`

### 适配进度（按 codegraph 实测，不夸大）

| # | 内容 | 状态 |
|---|---|---|
| 1 | 核心聊天回路（发消息 → 流式回复） | ✅ |
| 2 | 会话管理（list / create / delete / fork / 历史回放） | ✅ |
| 3a | 权限弹窗 | ✅ |
| 3b | AskUserQuestion 弹窗 | ✅ |
| 3c | Plan Approval（`x.ai/exit_plan_mode`） | ❌ **自动批准所有 plan——见下方"已知缺口"** |
| 4 | 模型 / 模式切换（`set_model` + `set_mode`） | ✅ |
| 5 | `/` 斜杠命令 + `@` 文件提及 | ✅ |
| 6a | MCP 配置表单（持久化） | ✅ |
| 6b | MCP 运行时面板（live 状态） | ❌ |
| 6c | Skills 面板 | ❌ |
| 6d | Worktree 生命周期面板 | ❌（`DirBrowserModal` 只选工作目录） |
| 7a | Rewind（消息级 undo / redo） | ⚠️ 半成品——`useSessionManager.handleUndo/Redo` 调 `revertMessage`/`unrevertSession`；`x.ai/rewind/points` 检查点面板未做 |
| 7b | Cron / 定时任务 UI | ❌ |
| 7c | 后台任务卡片（`TaskCompleted`） | ❌ |
| 8 | 品牌 + 中英 i18n（标题 Grok Build） | ✅ |

**横向能力**：

| 能力 | 状态 |
|---|---|
| 工具调用卡片（`tool_call` / `tool_call_update`） | ✅ `acpBridge.handleToolCall` → `emitToolPart` |
| Plan / Todo 卡片（`plan` notification） | ⚠️ 后端 `handlePlan` 发 `todo.updated`，但 `useGlobalEvents` **无订阅者** |
| Reasoning / Thinking 折叠 | ⚠️ 未确认——`acpBridge` 缺 `handleReasoning` |
| Subagent / 子会话视图 | ⚠️ `childSessionStore.registerChildSession` 跟踪父子，**无 UI 切换视图** |
| 多后端服务器切换 | ✅ `serverStore` + acpBridge 自动重连 |
| 工作目录选择 | ✅ `DirBrowserModal` + `browseDirectory` |
| config.toml 全量表单编辑器 | ✅ `GrokConfigSettings` + `ConfigFieldControl` + `configFormOps` + `grokConfigSchema` |

**附加已交付**：前后端分离部署 + CORS；config.toml 全量可视化编辑器（`grokConfigSchema` 声明式 + `ConfigFieldControl` 数据驱动 + `configFormOps` 增量 patch，`toml_edit` 在后端保留注释）；`@opencode-ai/sdk` 安全 stub；主题感知 `SelectField`；多后端 `serverStore` + 工作目录 `DirBrowserModal`。

### 已知缺口（按优先级排）

> 标记 🔥 的修复优先级最高

1. 🔥 **Plan Approval 自动批准**——`useGlobalEvents.ts:315-321` 显式写着 `TODO Step 3c: plan approval UI component`，目前所有 `x.ai/exit_plan_mode` 请求一律 `respond({ approved: true })`。**后端只要进入 plan 模式就会自动放行，与 plan 模式设计意图相反。** 修复：在 `useGlobalEvents` 加 `onExitPlanMode` 订阅 → 渲染 Plan Approval modal → 调 `respond({ approved: true|false })`。
2. **MCP 运行时面板缺失**——目前只有配置表单，看不到 server live status / tool list / 调用统计。后端 `McpServersUpdated` 通知已存在但前端无订阅。修复：监听 `x.ai/mcp/status` 或类似通知 + 新建 `features/mcp/` 面板组件。
3. **Skills 面板缺失**——同 MCP 模式，缺监听 + UI。
4. **Cron / 后台任务卡片缺失**——`useGlobalEvents` 没有 `scheduled_task_*` / `task.completed` 订阅；后端类型已存在。修复：加订阅 + 在 ChatPane 渲染内联卡片。
5. **Todo 卡片"事件发了没人接"**——`acpBridge.handlePlan` 已 emit `todo.updated`，但 `useGlobalEvents` 订阅表里没有 `onTodoUpdated`。修复成本最低（1 个订阅 + 1 个 ChatPane 渲染分支）。
6. **Reasoning 折叠未确认**——`acpBridge` 缺 `handleReasoning`；OpenCodeUI 自己的 ReasoningPart 渲染依赖 messageStore 里有 reasoning 类型 part。先在 `acpBridge` 监听 agent_thought_chunk → 注入 `messageStore.handlePartUpdated` 试试。
7. **Rewind 面板**——`useSessionManager` 的 undo/redo 走单条 message revert，但 `x.ai/rewind/points`（多检查点列表）UI 没做。
8. **Subagent 子会话视图**——父子关系在 store 里跟踪了，但缺子会话切换 / 树状视图 UI。
9. **Worktree 生命周期**——`DirBrowserModal` 只选目录，没有 create / list / delete worktree。

> 新增/修缺口时按"先订阅 + 再渲染"两步走：先在 `useGlobalEvents`（或 `acpBridge`）加通知处理 → 再在 `ChatPane` 或新组件渲染。**别改 OpenCodeUI 自带 UI 组件**——按现有模式新增 grok 特有组件。

### 工作流程

1. **优先改 API 层和状态层**；UI 改"必要的 React glue"和"grok 特有功能"（如 DirBrowserModal、模型选择器、配置表单）——OpenCodeUI 自带的 UI 组件外观不动
2. **API 层一次替换一个文件**——改一个测一个（`npm run test:run` + `typecheck`）
3. **新增组件**沿用 OpenCodeUI 现有 React + Tailwind 模式
4. **协议**：所有新增代码 GPL-3.0-only（沿用上游）

### 后端（不在本仓库的职责范围）

- `grok web` CLI：`crates/codegen/xai-grok-pager-bin/src/main.rs` + `crates/codegen/xai-grok-pager/src/app/cli.rs`
- ACP server：`crates/codegen/xai-grok-shell/src/agent/server.rs`
- Web server：`crates/codegen/xai-grok-web/`
- Windows 构建：`editbin /STACK:8388608`，需 `PROTOC` 环境变量

### 构建 & 启动

```bash
# 一次构建前后端（推荐）
./scripts/build-web.sh                # debug
./scripts/build-web.sh --release      # release

# 或分步
cd web && npm install && npm run build
cargo build --features "xai-grok-pager-bin/web-ui"

# 启动
grok web --secret <key>   # → http://127.0.0.1:2420/#key=<key>
```

Dev 模式（Vite + 后端分离）：`cd web && npm run dev` —— 通过 `vite.config.ts` 的 proxy 把 `/config` + `/ws` 转给 `GROK_BACKEND`（默认 `http://127.0.0.1:2420`）。

### 验证（每次改动后必跑）

```bash
cd web
npm run typecheck   # tsc -b，必须无错
npm run test:run    # vitest —— 92 文件 / 595 用例 / 5 skip
npm run build       # vite 生产构建
```

后端：`cargo build --features "xai-grok-pager-bin/web-ui"`。

### 在本仓库工作

- **理解代码**：仓库已索引到 `.codegraph/`。优先 `codegraph_explore "<符号或问题>"`——一次拿到相关源码 + 调用路径，别 grep + read 一路凑
- **改 API 之前**：用 `codegraph_node <symbol>` 看 caller 链
- **doc 优先**：实现细节在 `docs/web-*.md` 已写清楚，CLAUDE.md 不重复。改 doc 之前先看现有内容
