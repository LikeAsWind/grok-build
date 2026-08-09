# Grok Web UI 前后端对接方案

## Context

OpenCodeUI (React 19, Vite, Tailwind CSS v4) 现运行在 `grok web` 中，但其内部 80 个 API 调用全部走 opencode 的 REST + SSE 协议。需全部替换为 grok 的 ACP JSON-RPC over WebSocket。

**原则**: 不修改后端 ACP 服务器，不修改 OpenCodeUI 的 UI 组件，只改 `src/api/` 和 `src/store/`。

## 数据流对比

```
当前 (REST+SSE):                    目标 (ACP WebSocket):
POST /session/{id}/prompt     →    acp.send("session/prompt")
GET /global/event (SSE)       →    acp.onNotification("session/update")
GET /session/status           →    acp.request("x.ai/session/status")
POST /permission/{id}/reply   →    acp.request("session/request_permission") response
ws://.../pty/{id}/connect     →    ❌ 暂不实现 (terminal capabilities=false)
```

## 前后端分离部署（已实现）

前端通过**服务器面板**配置后端地址，三种启动形态：

| 形态 | 前端 | 后端 | 连接 |
|---|---|---|---|
| 单二进制（默认） | rust-embed 内嵌托管 | `grok web --secret K` | 同源零配置，`#key=K` 传密钥 |
| 开发模式 | `npm run dev`（5173） | `grok web`（2420） | vite proxy 转发 `/config` + `/ws`（`GROK_BACKEND` 环境变量可改目标） |
| 分离部署 | 任意静态托管 | `grok web --bind 0.0.0.0:2420 --secret K` | 服务器面板添加后端：URL + 密钥（password 字段存 server-key）；`/config` 已加 CORS |

实现要点：
- `constants/api.ts`：默认后端地址 = 同源（原 opencode 的 4096 已废弃）
- `acpBridge.ts`：连接地址取 `serverStore.getActiveBaseUrl()`；密钥取服务器 auth.password → URL `#key` → sessionStorage；`onServerChange` 自动断开重连
- `serverStore.checkHealth`：探测 `${url}/config`（grok 格式校验），面板显示在线状态/版本
- 后端 `/config` 返回 `Access-Control-Allow-Origin: *`（无敏感信息，WS 由 server-key 保护）

## 分阶段实施 (每步可验证)

### Step 1: 核心聊天回路 (发消息→收到回复)

**改动文件**: `src/api/message.ts`, `src/api/events.ts`, `src/store/messageStore.ts`

**具体做法**:
1. `sendMessageAsync()` → 改为调 AcpClient.prompt(sessionId, text)
2. ACP `session/update` 通知 → 转译为 OpenCodeUI 的 `message.part.delta` / `message.part.updated` / `session.idle` 事件格式，喂入 messageStore 现有 handler
3. Abort → 改为 AcpClient.cancel(sessionId)

**验证**: 浏览器发一条 prompt，页面显示 AI 回复流。F12 Console 查看 ACP WebSocket 帧。

### Step 2: 会话管理

**改动文件**: `src/api/session.ts`, `src/api/agent.ts`

**具体做法**:
1. `createSession()` → ACP `session/new`
2. `getSessions()` → ACP ext `x.ai/session/list`
3. `deleteSession()` → ACP ext `x.ai/session/delete`
4. `forkSession()` → ACP ext `x.ai/session/fork`
5. `getAgents()` → 从 ACP initialize 响应的 `_meta.modelState.availableModels` 构建 agent 列表

**验证**: 左侧会话列表显示已有会话，可新建/切换/删除会话。

### Step 3: 交互式对话框

**改动文件**: `src/api/permission.ts`, ACP ext handler 在 events.ts

**具体做法**:
1. ACP `session/request_permission` 请求 → 转译为 OpenCodeUI 的 `permission.asked` 事件
2. `replyPermission()` → 回包给 ACP
3. ACP `x.ai/ask_user_question` → 转译为 `question.asked`
4. ACP `x.ai/exit_plan_mode` → 新增 plan approval UI (OpenCodeUI 无此组件)

**验证**: 触发需要权限的工具调用，弹出权限对话框；在 plan mode 下发 prompt，弹出计划审批。

### Step 4: 模型/模式切换

**改动文件**: `src/api/config.ts`, `src/api/tool.ts`

**具体做法**:
1. 模型列表从 ACP `session/new` 响应的 `models.availableModels` 获取
2. 模型切换 → `AcpClient.setModel(sessionId, modelId)`
3. 模式切换 → `AcpClient.setMode(sessionId, modeId)`（default/plan/ask）

**验证**: 命令面板中可切换模型和推理强度；Composer 上方显示当前模型名。

### Step 5: 斜杠命令 + 文件搜索

**改动文件**: `src/api/command.ts`, `src/api/file.ts`

**具体做法**:
1. 命令列表 → ACP `AvailableCommandsUpdate` 通知（初始化时推送）
2. 文件搜索 → ACP ext `x.ai/file/*` (如果后端支持) 或暂时用客户端静态文件树

**验证**: 输入 `/` 显示命令补全；`@` 提及文件路径。

### Step 6: MCP / Skills / Worktree 管理面板

**改动文件**: `src/api/mcp.ts`, `src/api/worktree.ts`

**具体做法**:
1. MCP 列表 → ACP ext `x.ai/mcp/list`
2. MCP 开关 → ACP ext `x.ai/mcp/toggle`
3. Skills → ACP ext `x.ai/skills/list` + `x.ai/skills/toggle`
4. Worktree → ACP ext `x.ai/git/worktree/*`

**验证**: 设置面板 → MCP 标签页可看到服务器列表并开关；Skills 标签页可看到 skill 列表。

### Step 7: Rewind / Cron / 后台任务

**改动文件**: 新增 `src/api/scheduler.ts`, `src/api/rewind.ts`

**具体做法**:
1. 回退检查点 → ACP ext `x.ai/rewind/points`, 执行 → `x.ai/rewind/execute`
2. 定时任务 → ACP ext notification `x.ai/scheduled_task_*`
3. 后台任务 → ACP ext notification `x.ai/task_backgrounded/completed`

**验证**: Rewind 面板显示检查点列表可回退；后台任务在消息流中以内联卡片显示。

### Step 8: 主题/设置/i18n

**改动文件**: `web/src/index.html` title, `public/` assets, i18n

**具体做法**:
1. `<title>` 从 "OpenCode" 改为 "Grok Build"
2. 替换 `public/opencode.svg` 为 grok logo
3. 中文 locale 补全（OpenCodeUI 已有 i18n 框架）

**验证**: 页面标题显示 "Grok Build"，中文界面完整。

## 不做 / 暂缓

- PTY 终端 — ACP client capabilities `terminal=false`，终端 I/O 不可用。保留 OpenCodeUI 的终端 UI，但显示 "终端不可用"
- Tauri 桌面端 — 暂时不编译，保留 `src-tauri/` 源码不删（用户要求不删）但 package.json 不去掉 tauri 依赖
- opencode 的 `@opencode-ai/sdk` 包 — 保留作为类型参考，不调用其实例

## 实施状态

| Step | 内容 | 状态 |
|---|---|---|
| 1 | 核心聊天回路 | ✅ DeepSeek 实测 2s 回复 |
| 2 | 会话管理 | ✅ 列表/创建/删除/改名/Fork/历史回放 |
| 3 | 交互式对话框 | ✅ CustomEvent→现有UI，ACP respond闭环 |
| 4 | 模型/模式切换 | ✅ 自动set_model + set_mode |
| 5 | 斜杠命令+文件搜索 | ✅ available_commands_update已转译 |
| 6 | MCP/Skills/Worktree | ✅ 配置表单全覆盖，ACP bridges就位 |
| 7 | Rewind/Cron/后台 | ✅ revertMessage→x.ai/rewind/execute |
| 8 | 品牌/i18n | ✅ 标题 Grok Build，OpenCode文案已替换 |

额外完成：前后端分离部署、config.toml全量可视化编辑器（38分区+动态键表）、SDK安全stub防白屏、SelectField主题下拉组件。

## 验证总流程

每步完成后执行:
1. `cd web && npm run typecheck` — TypeScript 编译通过
2. `npm run build` — Vite 构建通过
3. `grok web --secret test` — 启动服务器
4. 浏览器打开 → 手动测试该步骤功能
5. 检查 F12 Console 和 Network/WS 标签，确认 ACP WebSocket 通信正常
