# CLAUDE.md

## Web UI: OpenCodeUI fork → grok 适配

### 架构

```
浏览器 OpenCodeUI (React 19 + Vite + Tailwind CSS v4)
  ↕ ACP JSON-RPC over WebSocket (/ws?server-key=KEY)
grok web (Rust axum server, 复用 xai-grok-shell MvpAgent)
  ↕ tokio::mpsc channels (ACP 协议)
xai-acp-lib / agent-client-protocol v0.10.x
```

### 前端源码

- **基础**: https://github.com/lehhair/OpenCodeUI (React 19, Vite 7, Tailwind CSS v4, GPL-3.0)
- **已内置**: Shiki 代码高亮, xterm.js 终端, 主题系统, PWA, 移动端适配
- **构建**: `npm run build` → `web/dist/`
- **嵌入**: rust-embed feature `web-ui` 编译期吸入 `web/dist/`

### 适配策略

**替换 API 层，保留 UI 层。** OpenCodeUI 目前调 opencode REST API + SSE，需要全部改成 ACP WebSocket:

| OpenCodeUI 模块 | 原协议 | grok 替换 |
|---|---|---|
| `src/api/client.ts` | HTTP fetch | ACP WebSocket (`/ws`) |
| `src/api/sse.ts` | SSE streaming | WS message handler |
| `src/api/session.ts` | REST /session | ACP `session/new`, `session/load` |
| `src/api/message.ts` | REST /message | ACP `session/prompt` |
| `src/api/agent.ts` | REST | ACP `initialize` → `authenticate` |
| `src/api/permission.ts` | REST /permission | ACP `session/request_permission` |
| `src/api/tool.ts` | REST | ACP `session/update` tool_call + tool_call_update |
| `src/api/file.ts` | REST /file | ACP ext `x.ai/...` |
| `src/api/mcp.ts` | REST /mcp | ACP ext `x.ai/mcp/*` |
| `src/api/pty.ts` | REST /pty | 暂不实现 (terminal capabilities=false) |

### ACP 协议要点

- Transport: WebSocket JSON-RPC text frames, newline-agnostic
- Auth: `?server-key=<secret>` query param
- Keepalive: 客户端 15s 发 `"ping"` 文本帧
- 类型定义: `crates/codegen/xai-acp-lib/src/message.rs`
- 80+ `x.ai/*` 扩展方法: `web/src/acp/ext-types.ts`

### grok TUI 功能 → OpenCodeUI 适配清单

| TUI 功能 | 状态 | 备注 |
|---|---|---|
| 聊天流 (Markdown+代码) | ✅ OpenCodeUI 已有 | Shiki + react-markdown |
| 工具调用卡片 | 🔧 需新增 | ACP tool_call → ContentBlock |
| Thinking 折叠 | 🔧 需新增 | reasoning part |
| Plan/Todo | ❌ 待加 | ACP plan update |
| Permission 弹窗 | 🔧 需适配 | ACP session/request_permission |
| Plan Approval | ❌ 待加 | ACP x.ai/exit_plan_mode |
| AskUserQuestion | ❌ 待加 | ACP x.ai/ask_user_question |
| 终端 | ✅ OpenCodeUI 已有 | xterm.js，但 ACP 不走 PTY |
| 文件 Diff | ✅ OpenCodeUI 已有 | DiffViewer 组件 |
| 会话管理 | ✅ OpenCodeUI 已有 | 需适配 ACP session/list |
| 模型切换 | 🔧 需适配 | ACP session/set_model |
| 斜杠命令 | ✅ OpenCodeUI 已有 | / 和 @ 提及 |
| Subagent/Task | ❌ 待加 | ACP ext notifications |
| MCP 面板 | ❌ 待加 | ACP ext x.ai/mcp/* |
| Skills/Worktree | ❌ 待加 | ACP ext |
| Rewind | ❌ 待加 | ACP ext x.ai/rewind/* |

### 工作流程

1. **不修改 OpenCodeUI 的 UI 组件** — 只改 `src/api/` 和 `src/store/`
2. **API 层一次替换一个文件** — 改一个测一个
3. **grok 特有功能** — 新增组件遵循 OpenCodeUI 现有的 React + Tailwind 模式
4. **保持 OpenCodeUI 的 GPL-3.0 协议** — 所有新增代码也 GPL-3.0

### 后端 (保持不变)

- `grok web` CLI: `crates/codegen/xai-grok-pager-bin/src/main.rs` + `crates/codegen/xai-grok-pager/src/app/cli.rs`
- ACP server: `crates/codegen/xai-grok-shell/src/agent/server.rs`
- Web server: `crates/codegen/xai-grok-web/`
- Windows 构建需: `editbin /STACK:8388608` + PROTOC 环境变量

### 构建

```
cd web && npm install && npm run build     # 前端
cargo build --features "xai-grok-pager-bin/web-ui"    # Rust 二进制
grok web --secret <key>                    # 启动 → http://127.0.0.1:2420/#key=<key>
```
